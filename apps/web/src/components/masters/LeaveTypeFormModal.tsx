import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  leaveTypeAppliesTo,
  leaveTypeInput,
  type BalanceMode,
  type LeaveType,
  type LeaveTypeInput,
  type LeaveTypeTarget,
} from "@leave-flow/shared";
import { api, errorMessage } from "../../lib/api.ts";
import { invalidateLeaveData, useCategories, useDepartments, useEmployees } from "../../lib/queries.ts";
import { EmployeeMultiSelect } from "../form/index.tsx";
import { Button, Callout, Checkbox, ErrorText, Field, Modal, Select, Spinner, TextInput, useToast } from "../ui/index.tsx";
import { apiFieldErrors, checkInput, type FieldErrors } from "./formErrors.ts";
import { BALANCE_MODE_LABELS } from "./labels.ts";
import "./masters.css";

const BALANCE_MODES: readonly BalanceMode[] = ["yearly", "cumulative", "expire_date", "grant_period", "used_up"];

/** 휴가 종류 추가·수정. leaveType = null 이면 새로 추가 */
export function LeaveTypeFormModal({
  leaveType,
  nextSortOrder,
  onClose,
}: {
  leaveType: LeaveType | null;
  /** 새로 추가할 때 기본 표시 순서 */
  nextSortOrder: number;
  onClose: () => void;
}) {
  const formId = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<LeaveTypeInput>(() =>
    leaveType
      ? {
          name: leaveType.name,
          displayName: leaveType.displayName,
          deducts: leaveType.deducts,
          balanceMode: leaveType.balanceMode,
          expireMonth: leaveType.expireMonth,
          expireDay: leaveType.expireDay,
          validMonths: leaveType.validMonths,
          hideWhenEmpty: leaveType.hideWhenEmpty,
          target: leaveType.target,
          sortOrder: leaveType.sortOrder,
        }
      : {
          name: "",
          displayName: "",
          deducts: true,
          balanceMode: "yearly",
          expireMonth: null,
          expireDay: null,
          validMonths: null,
          hideWhenEmpty: false,
          target: null,
          sortOrder: nextSortOrder,
        },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof LeaveTypeInput>(key: K, value: LeaveTypeInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const locked = !!leaveType?.inUse;

  /** 잔여 방식을 바꾸면 그 방식에 필요한 값의 기본값을 채움 (소멸일 12월 31일, 기간 12개월, 소진은 잔여가 없으면 숨김) */
  const setMode = (mode: BalanceMode) =>
    setForm((f) => ({
      ...f,
      balanceMode: mode,
      expireMonth: mode === "expire_date" ? (f.expireMonth ?? 12) : null,
      expireDay: mode === "expire_date" ? (f.expireDay ?? 31) : null,
      validMonths: mode === "grant_period" ? (f.validMonths ?? 12) : null,
      hideWhenEmpty: mode === "used_up",
    }));
  const intOrNull = (raw: string) => (raw === "" ? null : Math.floor(Number(raw)));

  // 적용 대상: 소속·구분 조건(고른 칸끼리 모두) + 따로 고른 직원. 고를 수 있는 직원은 활성 + 이미 대상인 비활성 직원
  const employeesQ = useEmployees(true);
  const departmentsQ = useDepartments();
  const categoriesQ = useCategories();
  const target = form.target ?? null;
  const employeeOptions = (employeesQ.data ?? []).filter((e) => e.active || target?.employeeIds.includes(e.id));
  const setTarget = (patch: Partial<LeaveTypeTarget>) =>
    setForm((f) => ({ ...f, target: { departments: [], categories: [], employeeIds: [], ...f.target, ...patch } }));
  const toggle = <T,>(list: readonly T[], value: T, on: boolean) =>
    on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);
  // 소속은 소속 목록 순서로 저장
  const departmentNames = (departmentsQ.data ?? []).map((d) => d.name);
  const toggleDepartment = (name: string, on: boolean) =>
    setTarget({ departments: departmentNames.filter((n) => toggle(target?.departments ?? [], name, on).includes(n)) });
  // 구분도 구분 목록 순서로 저장
  const categoryNames = (categoriesQ.data ?? []).map((c) => c.name);
  const toggleCategory = (name: string, on: boolean) =>
    setTarget({ categories: categoryNames.filter((n) => toggle(target?.categories ?? [], name, on).includes(n)) });
  const covered = target
    ? (employeesQ.data ?? []).filter((e) => e.active && leaveTypeAppliesTo({ target }, e))
    : [];

  const save = useMutation({
    mutationFn: (input: LeaveTypeInput) =>
      leaveType
        ? api.put<LeaveType>(`/api/leave-types/${leaveType.id}`, input)
        : api.post<LeaveType>("/api/leave-types", input),
    onSuccess: async (saved) => {
      toast(leaveType ? `${saved.name} 종류를 저장했습니다.` : `${saved.name} 종류를 추가했습니다.`);
      onClose();
      await invalidateLeaveData(qc);
    },
    onError: (err) => {
      setErrors(apiFieldErrors(err));
      toast(errorMessage(err), "error");
    },
  });

  const submit = () => {
    const r = checkInput(leaveTypeInput, form);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    save.mutate(r.data);
  };

  return (
    <Modal
      open
      title={leaveType ? "휴가 종류 수정" : "휴가 종류 추가"}
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
          submit();
        }}
      >
        <div className="form-grid">
          <Field label="이름" required hint="관리 화면에서 쓰는 이름. 다른 종류와 겹치면 안 됩니다." error={errors.name}>
            <TextInput
              value={form.name}
              maxLength={30}
              autoFocus
              placeholder="예: 연차(강사)"
              aria-invalid={!!errors.name || undefined}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field
            label="표시 이름"
            hint="휴가원 작성·양식·목록·달력에 보일 이름. 비우면 이름 그대로."
            error={errors.displayName}
          >
            <TextInput
              value={form.displayName}
              maxLength={30}
              placeholder={form.name.trim() || "예: 연차"}
              aria-invalid={!!errors.displayName || undefined}
              onChange={(e) => set("displayName", e.target.value)}
            />
          </Field>
        </div>
        <span className="field-hint">
          대상에 따라 규칙이 다른 같은 휴가(예: 직원·강사 연차)는 이름을 다르게 하고 표시 이름을 같게 한 뒤, 적용 대상이
          겹치지 않게 나누세요. 한 직원에게 표시 이름이 같은 종류가 둘 이상 적용되면 저장할 수 없습니다.
        </span>

        <Field label="잔여 방식" required error={errors.balanceMode}>
          <Select value={form.balanceMode} disabled={locked} onChange={(e) => setMode(e.target.value as BalanceMode)}>
            {BALANCE_MODES.map((m) => (
              <option key={m} value={m}>
                {BALANCE_MODE_LABELS[m].name}: {BALANCE_MODE_LABELS[m].desc}
              </option>
            ))}
          </Select>
        </Field>

        {form.balanceMode === "expire_date" && (
          <Field
            label="소멸일"
            required
            hint="매년 이 날이 지나면 남은 양이 사라지고 다음 날부터 새로 셉니다. (2월 28·29일은 2월 말일)"
            error={errors.expireMonth ?? errors.expireDay}
          >
            <div className="amount-input">
              <Select
                value={form.expireMonth ?? 12}
                disabled={locked}
                aria-label="소멸일 (월)"
                onChange={(e) => set("expireMonth", Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </Select>
              <span className="muted">월</span>
              <TextInput
                type="number"
                min={1}
                max={31}
                inputMode="numeric"
                className="amount-box"
                value={form.expireDay ?? ""}
                disabled={locked}
                aria-label="소멸일 (일)"
                aria-invalid={!!errors.expireDay || undefined}
                onChange={(e) => set("expireDay", intOrNull(e.target.value))}
              />
              <span className="muted">일</span>
            </div>
          </Field>
        )}

        {form.balanceMode === "grant_period" && (
          <Field
            label="쓸 수 있는 기간"
            required
            hint="부여일부터 이 기간이 지나면 그 부여에서 남은 양이 사라집니다. 사용은 먼저 사라질 부여부터 씁니다."
            error={errors.validMonths}
          >
            <div className="amount-input">
              <span className="muted">부여 후</span>
              <TextInput
                type="number"
                min={1}
                max={120}
                inputMode="numeric"
                className="amount-box"
                value={form.validMonths ?? ""}
                disabled={locked}
                aria-label="쓸 수 있는 기간 (개월)"
                aria-invalid={!!errors.validMonths || undefined}
                onChange={(e) => set("validMonths", intOrNull(e.target.value))}
              />
              <span className="muted">개월</span>
            </div>
          </Field>
        )}

        {form.balanceMode === "used_up" && (
          <div className="stack" style={{ gap: 4 }}>
            <Checkbox
              label="남은 양이 없으면 휴가원에서 숨김"
              checked={form.hideWhenEmpty}
              onChange={(v) => set("hideWhenEmpty", v)}
            />
            <span className="field-hint">
              잔여가 0 이하인 직원(한 번도 부여받지 않은 직원 포함)은 휴가원 작성의 종류 목록과 휴가원 양식(휴가현황 표·체크박스)에서
              빠집니다. 그 휴가원에서 쓴 종류는 그대로 보입니다. 잔여 현황에는 늘 나옵니다.
            </span>
          </div>
        )}

        {locked ? (
          <Callout>부여·사용 기록이 있어 잔여 방식(소멸일·기간 포함)은 바꿀 수 없습니다.</Callout>
        ) : (
          <Callout tone="info">
            1일은 직원마다 그 사람의 하루 근무시간입니다. 잔여 방식(소멸일·기간 포함)은 부여·사용 기록이 생기면 바꿀 수
            없습니다.
          </Callout>
        )}

        <div className="stack" style={{ gap: 4 }}>
          <Checkbox label="잔여에서 차감" checked={form.deducts} onChange={(v) => set("deducts", v)} />
          <span className="field-hint">
            공가처럼 잔여와 상관없는 종류는 끄세요. 끈 종류는 휴가원 양식의 휴가현황 표에서 총휴가일·잔여일이 빈칸입니다.
          </span>
        </div>

        <Field label="적용 대상" error={errors.target}>
          <Select
            value={target ? "some" : "all"}
            aria-label="적용 대상"
            onChange={(e) =>
              set("target", e.target.value === "all" ? null : { departments: [], categories: [], employeeIds: [] })
            }
          >
            <option value="all">전체 직원</option>
            <option value="some">소속·구분·직원 선택</option>
          </Select>
        </Field>
        {target &&
          (employeesQ.error || departmentsQ.error || categoriesQ.error ? (
            <ErrorText error={employeesQ.error ?? departmentsQ.error ?? categoriesQ.error} />
          ) : employeesQ.isPending || departmentsQ.isPending || categoriesQ.isPending ? (
            <Spinner />
          ) : (
            <div className="stack target-picker">
              <div className="field">
                <span className="field-label">소속</span>
                {departmentNames.length ? (
                  <div className="check-row">
                    {departmentNames.map((name) => (
                      <Checkbox
                        key={name}
                        label={name}
                        checked={target.departments.includes(name)}
                        onChange={(on) => toggleDepartment(name, on)}
                      />
                    ))}
                  </div>
                ) : (
                  <span className="field-hint">관리 &gt; 설정에 등록된 소속이 없습니다.</span>
                )}
              </div>
              <div className="field">
                <span className="field-label">구분</span>
                {categoryNames.length ? (
                  <div className="check-row">
                    {categoryNames.map((name) => (
                      <Checkbox
                        key={name}
                        label={name}
                        checked={target.categories.includes(name)}
                        onChange={(on) => toggleCategory(name, on)}
                      />
                    ))}
                  </div>
                ) : (
                  <span className="field-hint">관리 &gt; 설정에 등록된 구분이 없습니다.</span>
                )}
              </div>
              <div className="field">
                <span className="field-label">직원 (따로 추가)</span>
                <EmployeeMultiSelect
                  employees={employeeOptions}
                  selected={target.employeeIds}
                  onChange={(ids) => setTarget({ employeeIds: ids })}
                />
              </div>
              <span className="field-hint">
                소속과 구분을 함께 고르면 <strong>둘 다 맞는 직원</strong>만 대상입니다 (예: 아동사업부 + 직원 → 아동사업부의
                직원). 한 칸에서 여러 개를 고르면 그중 하나만 맞으면 됩니다. 따로 고른 직원은 조건과 관계없이 대상에
                더해집니다. 소속·구분으로 고르면 새로 온 직원이나 소속·구분이 바뀐 직원에게도 바로 적용됩니다. 대상이 아닌
                직원은 이 종류로 휴가원 작성·부여를 할 수 없고, 잔여 현황과 휴가원 양식에도 나오지 않습니다. 이미 있는 기록은
                그대로 둡니다.
              </span>
              <span className="field-hint">
                지금 대상: <strong>{covered.length}명</strong>
                {covered.length > 0 && ` (${covered.map((e) => e.name).join(", ")})`}
              </span>
            </div>
          ))}

        <Field
          label="표시 순서"
          hint="작은 숫자부터 목록·휴가원 양식에 나옵니다."
          error={errors.sortOrder}
          className="sort-order-field"
        >
          <TextInput
            type="number"
            min={0}
            max={9999}
            step={1}
            value={form.sortOrder}
            aria-invalid={!!errors.sortOrder || undefined}
            onChange={(e) => set("sortOrder", Math.floor(Number(e.target.value) || 0))}
          />
        </Field>
      </form>
    </Modal>
  );
}
