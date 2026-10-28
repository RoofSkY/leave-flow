import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  dayMinutesOf,
  formatHoursMinutes,
  formatLeaveMinutes,
  leaveTypeAppliesTo,
  localToday,
  openingBalanceInput,
  type Employee,
  type LeaveType,
  type OpeningBalance,
  type OpeningBalanceInput,
} from "@leave-flow/shared";
import { api, errorMessage, qs } from "../../lib/api.ts";
import { invalidateLeaveData, qk } from "../../lib/queries.ts";
import { DateInput, EmployeeSelect, LeaveTypeSelect } from "../form/index.tsx";
import { Button, Callout, Field, Modal, useConfirm, useToast } from "../ui/index.tsx";
import { apiFieldErrors, checkInput, type FieldErrors } from "./formErrors.ts";
import { DayHourInput, YearSelect, dayHourToMinutes, minutesToDayHour, type DayHourValue } from "./inputs.tsx";
import { LeaveAmountInput } from "./LeaveAmountInput.tsx";
import "./masters.css";

interface FormState {
  employeeId: number | null;
  leaveTypeId: number | null;
  year: number;
  baseDate: string;
  totalGranted: DayHourValue;
  remainingMinutes: number;
}

/** 연도를 바꾸면 기준일자도 그 해 안으로: 올해 = 오늘, 지난해 = 12/31, 다음 해 = 1/1 */
function baseDateFor(year: number): string {
  const today = localToday();
  const thisYear = Number(today.slice(0, 4));
  if (year === thisYear) return today;
  return year < thisYear ? `${year}-12-31` : `${year}-01-01`;
}

/** 기존 잔여량 입력·수정 (직원·종류·연도 기준으로 덮어씀). opening = null 이면 새로 입력 */
export function OpeningBalanceFormModal({
  opening,
  defaultYear,
  employees,
  leaveTypes,
  onClose,
}: {
  opening: OpeningBalance | null;
  defaultYear: number;
  /** 비활성 포함 전체 */
  employees: readonly Employee[];
  /** 비활성 포함 전체 */
  leaveTypes: readonly LeaveType[];
  onClose: () => void;
}) {
  const formId = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(() =>
    opening
      ? {
          employeeId: opening.employeeId,
          leaveTypeId: opening.leaveTypeId,
          year: opening.year,
          baseDate: opening.baseDate,
          totalGranted: minutesToDayHour(
            opening.totalGrantedMinutes,
            dayMinutesOf(employees.find((e) => e.id === opening.employeeId)),
          ),
          remainingMinutes: opening.remainingMinutes,
        }
      : {
          employeeId: null,
          leaveTypeId: null,
          year: defaultYear,
          baseDate: baseDateFor(defaultYear),
          totalGranted: { days: "", hours: "" },
          remainingMinutes: 0,
        },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const employeeOptions = employees.filter((e) => e.active || e.id === opening?.employeeId);
  // 고른 직원에게 적용되는 활성 종류 (수정 중이면 원래 종류)
  const chosenEmployee = employees.find((e) => e.id === form.employeeId);
  const typeOptions = leaveTypes.filter(
    (t) => t.id === opening?.leaveTypeId || (t.active && (!chosenEmployee || leaveTypeAppliesTo(t, chosenEmployee))),
  );
  /** 직원을 바꾸면 그 직원에게 적용되지 않는 종류는 선택을 비움 */
  const chooseEmployee = (id: number | null) =>
    setForm((f) => {
      const t = leaveTypes.find((x) => x.id === f.leaveTypeId);
      const e = employees.find((x) => x.id === id);
      return { ...f, employeeId: id, leaveTypeId: t && e && !leaveTypeAppliesTo(t, e) ? null : f.leaveTypeId };
    });
  const type = leaveTypes.find((t) => t.id === form.leaveTypeId);
  const employee = employees.find((e) => e.id === form.employeeId);

  // 새로 입력할 때 같은 직원·종류·연도 기록이 이미 있으면 덮어쓰기 안내
  const sameEmployee = useQuery({
    queryKey: qk.openingBalances({ year: form.year, employeeId: form.employeeId }),
    queryFn: () =>
      api.get<OpeningBalance[]>(`/api/opening-balances${qs({ year: form.year, employeeId: form.employeeId })}`),
    enabled: !opening && form.employeeId !== null,
  });
  const existing = opening ? undefined : sameEmployee.data?.find((o) => o.leaveTypeId === form.leaveTypeId);

  // 1일 = 그 직원의 하루 근무시간
  const dayMinutes = dayMinutesOf(employee);
  const totalEmpty = form.totalGranted.days === "" && form.totalGranted.hours === "";
  const totalMinutes = type && !totalEmpty ? dayHourToMinutes(form.totalGranted, dayMinutes) : null;
  const usedMinutes = totalMinutes === null ? null : totalMinutes - form.remainingMinutes;
  const f = (m: number) => (type ? formatLeaveMinutes(m, dayMinutes) : "");
  const dayHint = employee ? `1일 = ${formatHoursMinutes(dayMinutes)} (${employee.name}의 하루 근무시간)` : "직원을 먼저 고르세요.";

  const save = useMutation({
    mutationFn: (input: OpeningBalanceInput) => api.put<OpeningBalance>("/api/opening-balances", input),
    onSuccess: async () => {
      toast("기존 잔여량을 저장했습니다.");
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
    if (form.employeeId === null) missing.employeeId = "직원을 선택하세요.";
    if (form.leaveTypeId === null) missing.leaveTypeId = "휴가 종류를 선택하세요.";
    if (totalEmpty) missing.totalGrantedMinutes = "총 부여량을 입력하세요.";
    if (usedMinutes !== null && usedMinutes < 0) missing.remainingMinutes = "현재 잔여량이 총 부여량보다 큽니다.";
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    const r = checkInput(openingBalanceInput, { ...form, totalGrantedMinutes: totalMinutes ?? 0 });
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    if (opening || existing) {
      const ok = await confirm({
        title: "기존 잔여량 수정",
        message: `${employee?.name ?? ""} ${type?.name ?? ""} ${form.year}년 기존 잔여량을 ${opening ? "수정할" : "새 값으로 덮어쓸"}까요?\n잔여량과 휴가원 양식의 누적사용이 바로 다시 계산됩니다.`,
        confirmLabel: opening ? "수정" : "덮어쓰기",
        danger: !opening,
      });
      if (!ok) return;
    }
    save.mutate(r.data);
  };

  return (
    <Modal
      open
      title={opening ? "기존 잔여량 수정" : "기존 잔여량 입력"}
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
        <div className="form-grid">
          <Field label="직원" required error={errors.employeeId}>
            <EmployeeSelect
              employees={employeeOptions}
              value={form.employeeId}
              disabled={!!opening}
              invalid={!!errors.employeeId}
              onChange={chooseEmployee}
            />
          </Field>
          <Field label="휴가 종류" required error={errors.leaveTypeId}>
            <LeaveTypeSelect
              leaveTypes={typeOptions}
              value={form.leaveTypeId}
              disabled={!!opening}
              invalid={!!errors.leaveTypeId}
              onChange={(v) => set("leaveTypeId", v)}
            />
          </Field>
          <Field label="연도" required error={errors.year}>
            <YearSelect
              value={form.year}
              disabled={!!opening}
              onChange={(y) => {
                if (y === null) return;
                setForm((s) => ({ ...s, year: y, baseDate: s.baseDate.startsWith(`${y}-`) ? s.baseDate : baseDateFor(y) }));
              }}
            />
          </Field>
          <Field label="기준일자" required hint="이 날짜 기준의 잔여량입니다." error={errors.baseDate}>
            <DateInput
              value={form.baseDate}
              min={`${form.year}-01-01`}
              max={`${form.year}-12-31`}
              invalid={!!errors.baseDate}
              onChange={(v) => set("baseDate", v)}
            />
          </Field>
        </div>

        {existing && type && (
          <Callout tone="warning">
            {`이미 입력한 기록이 있습니다 (총 부여 ${f(existing.totalGrantedMinutes)}, 잔여 ${f(existing.remainingMinutes)}). 저장하면 새 값으로 덮어씁니다.`}
          </Callout>
        )}

        <Field label={`${form.year}년 총 부여량`} required hint={dayHint} error={errors.totalGrantedMinutes}>
          <DayHourInput
            value={form.totalGranted}
            dayMinutes={employee ? dayMinutes : undefined}
            invalid={!!errors.totalGrantedMinutes}
            onChange={(v) => set("totalGranted", v)}
          />
        </Field>

        <Field
          label="현재 잔여량"
          required
          hint={type ? "분은 10분 단위 (넘치는 시간·분은 위 단위로 넘어감)" : "휴가 종류를 먼저 고르세요."}
          error={errors.remainingMinutes}
        >
          <LeaveAmountInput
            value={form.remainingMinutes}
            dayMinutes={dayMinutes}
            disabled={!type}
            invalid={!!errors.remainingMinutes}
            ariaLabel="현재 잔여량"
            onChange={(v) => set("remainingMinutes", v)}
          />
        </Field>

        <div className="computed" aria-live="polite">
          <span className="muted">기존 사용량 (총 부여량 − 현재 잔여량)</span>
          <span className="spacer" />
          {usedMinutes === null ? (
            <span className="faint">-</span>
          ) : usedMinutes < 0 ? (
            <span className="field-error">잔여량이 총 부여량보다 큽니다</span>
          ) : (
            <strong>{f(usedMinutes)}</strong>
          )}
        </div>
      </form>
    </Modal>
  );
}
