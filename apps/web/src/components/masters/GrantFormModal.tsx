import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  formatLeaveMinutes,
  grantBulkInput,
  grantBulkItem,
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

/** 종류 한 줄: 종류 + 양 (새로 추가할 때는 여러 줄, 수정할 때는 한 줄) */
interface ItemState {
  key: number;
  leaveTypeId: number | null;
  amount: DayHourValue;
}

interface FormState {
  /** 수정할 때의 직원 (한 명) */
  employeeId: number | null;
  /** 새로 추가할 때 고른 직원들 (여러 명 한 번에) */
  employeeIds: number[];
  items: ItemState[];
  grantDate: string;
  note: string;
}

const EMPTY_AMOUNT: DayHourValue = { days: "", hours: "", minutes: "" };
/** 한 번에 넣을 수 있는 종류 수 (서버 grantBulkInput 과 같게) */
const MAX_ITEMS = 30;
let nextItemKey = 1;
const newItem = (leaveTypeId: number | null = null): ItemState => ({
  key: nextItemKey++,
  leaveTypeId,
  amount: EMPTY_AMOUNT,
});
/** 빈칸은 0 */
const amountNumbers = (a: DayHourValue) => ({ days: a.days || 0, hours: a.hours || 0, minutes: a.minutes || 0 });
const amountEmpty = (a: DayHourValue) => !a.days && !a.hours && !a.minutes;
const amountErrorOf = (e: FieldErrors | undefined) => e?.days ?? e?.hours ?? e?.minutes;

/**
 * 부여 내역 추가·수정 (직접 입력분만). grant = null 이면 새로 추가 —
 * 여러 직원 × 여러 종류(종류마다 양이 다를 수 있음)를 한 번에 부여
 */
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
        items: [
          {
            ...newItem(grant.leaveTypeId),
            amount: minutesToDayHour(grant.minutes, dayMinutesOf(employees.find((e) => e.id === grant.employeeId))),
          },
        ],
        grantDate: grant.grantDate,
        note: grant.note,
      };
    }
    const typeOk = defaults.leaveTypeId !== null && typeById.get(defaults.leaveTypeId)?.active;
    const empOk = defaults.employeeId !== null && employees.some((e) => e.id === defaults.employeeId && e.active);
    return {
      employeeId: null,
      employeeIds: empOk && defaults.employeeId !== null ? [defaults.employeeId] : [],
      items: [newItem(typeOk ? defaults.leaveTypeId : null)],
      grantDate: localToday(),
      note: "",
    };
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  /** 줄마다의 오류 (줄 key → 항목별 메시지) */
  const [itemErrors, setItemErrors] = useState<Record<number, FieldErrors>>({});
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // 고를 수 있는 것: 활성이고 서로 적용되는 직원·종류 + 수정 중인 부여의 원래 값(비활성이거나 대상에서 빠졌어도)
  // 여러 종류를 고르면 그 종류가 모두 적용되는 직원만
  const typesOf = (items: readonly ItemState[]) =>
    items.flatMap((it) => {
      const t = it.leaveTypeId !== null ? typeById.get(it.leaveTypeId) : undefined;
      return t ? [t] : [];
    });
  const chosenTypes = typesOf(form.items);
  const appliesAll = (types: readonly LeaveType[], e: Employee) => types.every((t) => leaveTypeAppliesTo(t, e));
  const employeeOptions = employees.filter(
    (e) => e.id === grant?.employeeId || (e.active && appliesAll(chosenTypes, e)),
  );
  const grantEmployee = grant ? employees.find((e) => e.id === grant.employeeId) : undefined;
  /** 그 줄에서 고를 수 있는 종류: 다른 줄에서 고른 종류는 뺌 */
  const typeOptionsFor = (item: ItemState) =>
    leaveTypes.filter(
      (t) =>
        t.id === item.leaveTypeId ||
        (t.id === grant?.leaveTypeId) ||
        (t.active &&
          (!grantEmployee || leaveTypeAppliesTo(t, grantEmployee)) &&
          !form.items.some((other) => other.key !== item.key && other.leaveTypeId === t.id)),
    );
  const setAmount = (key: number, amount: DayHourValue) =>
    setForm((f) => ({ ...f, items: f.items.map((it) => (it.key === key ? { ...it, amount } : it)) }));
  /** 종류를 바꾸면 고른 종류가 모두 적용되지 않는 직원은 선택에서 뺌 */
  const chooseType = (key: number, id: number | null) =>
    setForm((f) => {
      const items = f.items.map((it) => (it.key === key ? { ...it, leaveTypeId: id } : it));
      const types = typesOf(items);
      return {
        ...f,
        items,
        employeeIds: grant
          ? f.employeeIds
          : f.employeeIds.filter((eid) => {
              const e = employees.find((x) => x.id === eid);
              return !e || appliesAll(types, e);
            }),
      };
    });
  const addItem = () => setForm((f) => ({ ...f, items: [...f.items, newItem()] }));
  const removeItem = (key: number) => setForm((f) => ({ ...f, items: f.items.filter((it) => it.key !== key) }));

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
  const amountText = (days: number, hours: number, minutes: number) =>
    [days && `${days}일`, hours && `${hours}시간`, minutes && `${minutes}분`].filter(Boolean).join(" ") || "0일";

  const save = useMutation({
    mutationFn: (input: { edit: GrantInput } | { bulk: GrantBulkInput }): Promise<Grant | Grant[]> =>
      "edit" in input
        ? api.put<Grant>(`/api/grants/${grant!.id}`, input.edit)
        : api.post<Grant[]>("/api/grants/bulk", input.bulk),
    onSuccess: async (_res, input) => {
      const kinds = "bulk" in input && input.bulk.items.length > 1 ? `${input.bulk.items.length}종류를 ` : "";
      toast("edit" in input ? "부여 내역을 수정했습니다." : `${input.bulk.employeeIds.length}명에게 ${kinds}부여했습니다.`);
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
    const missingItems: Record<number, FieldErrors> = {};
    if (grant ? form.employeeId === null : form.employeeIds.length === 0) {
      missing[grant ? "employeeId" : "employeeIds"] = grant ? "직원을 선택하세요." : "직원을 한 명 이상 선택하세요.";
    }
    for (const it of form.items) {
      const e: FieldErrors = {};
      if (it.leaveTypeId === null) e.leaveTypeId = "휴가 종류를 선택하세요.";
      if (amountEmpty(it.amount)) e.days = "부여량을 입력하세요.";
      if (Object.keys(e).length) missingItems[it.key] = e;
    }
    setErrors(missing);
    setItemErrors(missingItems);
    if (Object.keys(missing).length || Object.keys(missingItems).length) return;

    if (grant) {
      const it = form.items[0]!;
      const r = checkInput(grantInput, {
        employeeId: form.employeeId,
        leaveTypeId: it.leaveTypeId,
        grantDate: form.grantDate,
        note: form.note,
        ...amountNumbers(it.amount),
      });
      if (!r.ok) {
        const { leaveTypeId, days, hours, minutes, ...rest } = r.errors;
        setErrors(rest);
        setItemErrors({ [it.key]: { leaveTypeId, days, hours, minutes } });
        return;
      }
      const type = typeById.get(r.data.leaveTypeId);
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

    // 줄마다 검사해 그 줄 아래에 오류를 보여 줌
    const lineErrors: Record<number, FieldErrors> = {};
    for (const it of form.items) {
      const r = checkInput(grantBulkItem, { leaveTypeId: it.leaveTypeId, ...amountNumbers(it.amount) });
      if (!r.ok) lineErrors[it.key] = r.errors;
    }
    setItemErrors(lineErrors);
    const r = checkInput(grantBulkInput, {
      employeeIds: form.employeeIds,
      items: form.items.map((it) => ({ leaveTypeId: it.leaveTypeId, ...amountNumbers(it.amount) })),
      grantDate: form.grantDate,
      note: form.note,
    });
    if (!r.ok || Object.keys(lineErrors).length) {
      setErrors(r.ok ? {} : r.errors);
      return;
    }
    const { employeeIds, items, grantDate } = r.data;
    if (employeeIds.length > 1 || items.length > 1) {
      const names = employeeIds.map((id) => employees.find((e) => e.id === id)?.name ?? "");
      const lines = items.map((i) => `${typeById.get(i.leaveTypeId)?.name ?? ""} ${amountText(i.days, i.hours, i.minutes)}`);
      const who = names.length > 1 ? `${names.length}명에게` : `${names[0]}에게`;
      const ok = await confirm({
        title: names.length > 1 ? "여러 명에게 부여" : "여러 종류 부여",
        message: `${who} 아래와 같이 부여할까요? (부여일 ${formatDateKo(grantDate, true)})${dayMinutes === undefined ? "\n1일은 직원마다 그 사람의 하루 근무시간으로 계산합니다." : ""}\n\n${lines.join("\n")}${names.length > 1 ? `\n\n${names.join(", ")}` : ""}`,
        confirmLabel: names.length > 1 ? `${names.length}명에게 부여` : "부여",
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
                여러 명을 고르면 같은 양을 한 번에 부여합니다. (직원 × 종류마다 부여 내역 1건)
                {chosenTypes.some((t) => t.target) ? " 고른 휴가 종류가 모두 적용되는 직원만 나옵니다." : ""}
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
          {grant && (
            <Field label="휴가 종류" required error={itemErrors[form.items[0]!.key]?.leaveTypeId}>
              <LeaveTypeSelect
                leaveTypes={typeOptionsFor(form.items[0]!)}
                value={form.items[0]!.leaveTypeId}
                invalid={!!itemErrors[form.items[0]!.key]?.leaveTypeId}
                onChange={(v) => chooseType(form.items[0]!.key, v)}
              />
            </Field>
          )}
          <Field label="부여일" required error={errors.grantDate}>
            <DateInput value={form.grantDate} invalid={!!errors.grantDate} onChange={(v) => set("grantDate", v)} />
          </Field>
          {grant && (
            <Field label="양" required hint={amountHint} error={amountErrorOf(itemErrors[form.items[0]!.key])}>
              <DayHourInput
                value={form.items[0]!.amount}
                dayMinutes={dayMinutes}
                invalid={!!amountErrorOf(itemErrors[form.items[0]!.key])}
                onChange={(v) => setAmount(form.items[0]!.key, v)}
              />
            </Field>
          )}
        </div>
        {!grant && (
          <div className="field">
            <span className="field-label">
              휴가 종류와 양<span className="req">*</span>
            </span>
            <div className="grant-items">
              {form.items.map((it, idx) => {
                const e = itemErrors[it.key];
                const message = e?.leaveTypeId ?? amountErrorOf(e);
                return (
                  <div key={it.key} className="grant-item">
                    <div className="grant-item-row">
                      <div className="grant-item-type">
                        <LeaveTypeSelect
                          leaveTypes={typeOptionsFor(it)}
                          value={it.leaveTypeId}
                          invalid={!!e?.leaveTypeId}
                          onChange={(v) => chooseType(it.key, v)}
                        />
                      </div>
                      <DayHourInput
                        value={it.amount}
                        dayMinutes={dayMinutes}
                        invalid={!!amountErrorOf(e)}
                        onChange={(v) => setAmount(it.key, v)}
                      />
                      {form.items.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon
                          title="종류 삭제"
                          aria-label={`${idx + 1}번째 종류 삭제`}
                          onClick={() => removeItem(it.key)}
                        >
                          ✕
                        </Button>
                      )}
                    </div>
                    {message && <span className="field-error">{message}</span>}
                  </div>
                );
              })}
            </div>
            <div>
              <Button size="sm" onClick={addItem} disabled={form.items.length >= MAX_ITEMS}>
                + 종류 추가
              </Button>
            </div>
            {errors.items ? (
              <span className="field-error">{errors.items}</span>
            ) : (
              <span className="field-hint">{amountHint}. 종류마다 양을 다르게 넣을 수 있습니다.</span>
            )}
          </div>
        )}
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
