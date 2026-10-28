import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  formatLeaveMinutes,
  grantBulkInput,
  grantInput,
  leaveTypeAppliesTo,
  localToday,
  dayMinutesOf,
  formatHoursMinutes,
  type Employee,
  type Grant,
  type GrantBulkInput,
  type GrantInput,
  type LeaveType,
} from "@leave-flow/shared";
import { api, errorMessage } from "../../lib/api.ts";
import { formatDateKo } from "../../lib/format.ts";
import { invalidateLeaveData } from "../../lib/queries.ts";
import { DateInput, EmployeeMultiSelect, EmployeeSelect, LeaveTypeSelect } from "../form/index.tsx";
import { Button, Field, Modal, TextInput, useConfirm, useToast } from "../ui/index.tsx";
import { apiFieldErrors, checkInput, type FieldErrors } from "./formErrors.ts";
import { DayHourInput, dayHourToMinutes, minutesToDayHour, type DayHourValue } from "./inputs.tsx";

interface FormState {
  /** 수정할 때의 직원 (한 명) */
  employeeId: number | null;
  /** 새로 추가할 때 고른 직원들 (여러 명 한 번에) */
  employeeIds: number[];
  leaveTypeId: number | null;
  grantDate: string;
  amount: DayHourValue;
  note: string;
}

/** 부여 내역 추가·수정 (직접 입력분만). grant = null 이면 새로 추가 — 여러 직원을 골라 한 번에 부여 */
export function GrantFormModal({
  grant,
  employees,
  leaveTypes,
  defaults,
  onClose,
}: {
  grant: Grant | null;
  /** 비활성 포함 전체 */
  employees: readonly Employee[];
  /** 비활성 포함 전체 */
  leaveTypes: readonly LeaveType[];
  /** 새로 추가할 때 미리 고를 직원·종류 (목록 필터 값) */
  defaults: { employeeId: number | null; leaveTypeId: number | null };
  onClose: () => void;
}) {
  const formId = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const typeById = new Map(leaveTypes.map((t) => [t.id, t]));
  const [form, setForm] = useState<FormState>(() => {
    if (grant) {
      return {
        employeeId: grant.employeeId,
        employeeIds: [grant.employeeId],
        leaveTypeId: grant.leaveTypeId,
        grantDate: grant.grantDate,
        amount: minutesToDayHour(grant.minutes, dayMinutesOf(employees.find((e) => e.id === grant.employeeId))),
        note: grant.note,
      };
    }
    const typeOk = defaults.leaveTypeId !== null && typeById.get(defaults.leaveTypeId)?.active;
    const empOk = defaults.employeeId !== null && employees.some((e) => e.id === defaults.employeeId && e.active);
    return {
      employeeId: null,
      employeeIds: empOk && defaults.employeeId !== null ? [defaults.employeeId] : [],
      leaveTypeId: typeOk ? defaults.leaveTypeId : null,
      grantDate: localToday(),
      amount: { days: "", hours: "" },
      note: "",
    };
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // 고를 수 있는 것: 활성이고 서로 적용되는 직원·종류 + 수정 중인 부여의 원래 값(비활성이거나 대상에서 빠졌어도)
  const type = form.leaveTypeId !== null ? typeById.get(form.leaveTypeId) : undefined;
  const employeeOptions = employees.filter(
    (e) => e.id === grant?.employeeId || (e.active && (!type || leaveTypeAppliesTo(type, e))),
  );
  const grantEmployee = grant ? employees.find((e) => e.id === grant.employeeId) : undefined;
  const typeOptions = leaveTypes.filter(
    (t) => t.id === grant?.leaveTypeId || (t.active && (!grantEmployee || leaveTypeAppliesTo(t, grantEmployee))),
  );
  /** 종류를 바꾸면 그 종류가 적용되지 않는 직원은 선택에서 뺌 */
  const chooseType = (id: number | null) => {
    const next = id !== null ? typeById.get(id) : undefined;
    setForm((f) => ({
      ...f,
      leaveTypeId: id,
      employeeIds:
        next && !grant
          ? f.employeeIds.filter((id) => {
              const e = employees.find((x) => x.id === id);
              return !e || leaveTypeAppliesTo(next, e);
            })
          : f.employeeIds,
    }));
  };

  // 1일 = 그 직원의 하루 근무시간. 고른 직원들의 1일이 모두 같을 때만 하나로 정해짐
  const chosen = employees.filter((e) => (grant ? e.id === form.employeeId : form.employeeIds.includes(e.id)));
  const dayOptions = [...new Set(chosen.map((e) => dayMinutesOf(e)))];
  const dayMinutes = dayOptions.length === 1 ? dayOptions[0] : undefined;
  const amountHint =
    dayMinutes !== undefined
      ? `1일 = ${formatHoursMinutes(dayMinutes)} (${chosen.length > 1 ? "고른 직원들" : (chosen[0]?.name ?? "")}의 하루 근무시간)`
      : chosen.length > 1
        ? "하루 근무시간이 다른 직원이 섞여 있어, 1일은 직원마다 그 사람의 하루 근무시간으로 계산합니다."
        : "1일 = 그 직원의 하루 근무시간";
  // 검사·저장용: 빈칸은 0
  const payload = { ...form, days: form.amount.days || 0, hours: form.amount.hours || 0 };
  const amountText = (days: number, hours: number) =>
    [days && `${days}일`, hours && `${hours}시간`].filter(Boolean).join(" ") || "0일";

  const save = useMutation({
    mutationFn: (input: { edit: GrantInput } | { bulk: GrantBulkInput }): Promise<Grant | Grant[]> =>
      "edit" in input
        ? api.put<Grant>(`/api/grants/${grant!.id}`, input.edit)
        : api.post<Grant[]>("/api/grants/bulk", input.bulk),
    onSuccess: async (_res, input) => {
      toast("edit" in input ? "부여 내역을 수정했습니다." : `${input.bulk.employeeIds.length}명에게 부여했습니다.`);
      onClose();
      await invalidateLeaveData(qc);
    },
    onError: (err) => {
      setErrors(apiFieldErrors(err));
      toast(errorMessage(err), "error");
    },
  });

  const submit = async () => {
    const missing: FieldErrors = {};
    if (grant ? form.employeeId === null : form.employeeIds.length === 0) {
      missing[grant ? "employeeId" : "employeeIds"] = grant ? "직원을 선택하세요." : "직원을 한 명 이상 선택하세요.";
    }
    if (form.leaveTypeId === null) missing.leaveTypeId = "휴가 종류를 선택하세요.";
    if (!form.amount.days && !form.amount.hours) missing.days = "부여량을 입력하세요.";
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    if (grant) {
      const r = checkInput(grantInput, payload);
      if (!r.ok) {
        setErrors(r.errors);
        return;
      }
      setErrors({});
      if (type) {
        const emp = employees.find((e) => e.id === r.data.employeeId);
        const ok = await confirm({
          title: "부여 내역 수정",
          message: `${emp?.name ?? ""} ${type.name} ${formatLeaveMinutes(dayHourToMinutes(r.data, dayMinutesOf(emp)), dayMinutesOf(emp))} (${formatDateKo(r.data.grantDate, true)})로 수정할까요?\n잔여량이 바로 다시 계산됩니다.`,
          confirmLabel: "수정",
        });
        if (!ok) return;
      }
      save.mutate({ edit: r.data });
      return;
    }

    const r = checkInput(grantBulkInput, payload);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    if (r.data.employeeIds.length > 1 && type) {
      const names = r.data.employeeIds.map((id) => employees.find((e) => e.id === id)?.name ?? "");
      const ok = await confirm({
        title: "여러 명에게 부여",
        message: `${names.length}명에게 ${type.name} ${amountText(r.data.days, r.data.hours)} (${formatDateKo(r.data.grantDate, true)})을 부여할까요?${dayMinutes === undefined ? "\n1일은 직원마다 그 사람의 하루 근무시간으로 계산합니다." : ""}\n\n${names.join(", ")}`,
        confirmLabel: `${names.length}명에게 부여`,
      });
      if (!ok) return;
    }
    save.mutate({ bulk: r.data });
  };

  return (
    <Modal
      open
      title={grant ? "부여 내역 수정" : "부여 추가"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" type="submit" form={formId} disabled={save.isPending}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!grant && (
          <div className="field">
            <span className="field-label">
              직원<span className="req">*</span>
            </span>
            <EmployeeMultiSelect
              employees={employeeOptions}
              selected={form.employeeIds}
              invalid={!!errors.employeeIds}
              onChange={(ids) => set("employeeIds", ids)}
            />
            {errors.employeeIds ? (
              <span className="field-error">{errors.employeeIds}</span>
            ) : (
              <span className="field-hint">
                여러 명을 고르면 같은 양을 한 번에 부여합니다. (직원마다 부여 내역 1건)
                {type?.target ? ` ${type.name}이(가) 적용되는 직원만 나옵니다.` : ""}
              </span>
            )}
          </div>
        )}
        <div className="form-grid">
          {grant && (
            <Field label="직원" required error={errors.employeeId}>
              <EmployeeSelect
                employees={employeeOptions}
                value={form.employeeId}
                disabled
                invalid={!!errors.employeeId}
                onChange={(v) => set("employeeId", v)}
              />
            </Field>
          )}
          <Field label="휴가 종류" required error={errors.leaveTypeId}>
            <LeaveTypeSelect
              leaveTypes={typeOptions}
              value={form.leaveTypeId}
              invalid={!!errors.leaveTypeId}
              onChange={chooseType}
            />
          </Field>
          <Field label="부여일" required error={errors.grantDate}>
            <DateInput value={form.grantDate} invalid={!!errors.grantDate} onChange={(v) => set("grantDate", v)} />
          </Field>
          <Field label="양" required hint={amountHint} error={errors.days ?? errors.hours}>
            <DayHourInput
              value={form.amount}
              dayMinutes={dayMinutes}
              invalid={!!(errors.days ?? errors.hours)}
              onChange={(v) => set("amount", v)}
            />
          </Field>
        </div>
        <Field label="비고" error={errors.note}>
          <TextInput
            value={form.note}
            maxLength={200}
            placeholder="예: 2026년 연차"
            onChange={(e) => set("note", e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}
