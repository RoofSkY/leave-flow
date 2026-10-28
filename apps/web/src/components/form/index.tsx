import type { Employee, LeaveType } from "@leave-flow/shared";
import { LEAVE_STEP_MINUTES, MAX_YEAR, MIN_YEAR } from "@leave-flow/shared";
import { Select, TextInput } from "../ui/index.tsx";

export { TimeSelect } from "./TimePicker.tsx";
export { PhoneInput } from "./PhoneInput.tsx";
export { EmployeeMultiSelect } from "./EmployeeMultiSelect.tsx";

/** 하루 전체 10분 단위 시각 목록 (근무시간 제한이 없을 때) */
export function allDayTimes(): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += LEAVE_STEP_MINUTES) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

/** 날짜 입력. min·max 를 주지 않으면 입력 가능한 연도 범위(MIN_YEAR~MAX_YEAR)로 제한 */
export function DateInput({
  value,
  onChange,
  min,
  max,
  invalid,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  return (
    <TextInput
      type="date"
      value={value}
      min={min ?? `${MIN_YEAR}-01-01`}
      max={max ?? `${MAX_YEAR}-12-31`}
      aria-invalid={invalid || undefined}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const MAX_DURATION_HOURS = 999;

/** 시간(분) 입력: [시간] + [분(10분 단위)] */
export function DurationInput({
  value,
  onChange,
  ariaLabel = "시간",
}: {
  value: number;
  onChange: (minutes: number) => void;
  ariaLabel?: string;
}) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return (
    <div className="row" style={{ gap: 6 }}>
      <TextInput
        type="number"
        min={0}
        max={MAX_DURATION_HOURS}
        step={1}
        value={hours}
        aria-label={`${ariaLabel} (시간)`}
        style={{ width: 80 }}
        onChange={(e) => {
          const h = Math.max(0, Math.min(MAX_DURATION_HOURS, Math.floor(Number(e.target.value) || 0)));
          onChange(h * 60 + minutes);
        }}
      />
      <span className="muted">시간</span>
      <Select
        value={minutes}
        aria-label={`${ariaLabel} (분)`}
        style={{ width: 80 }}
        onChange={(e) => onChange(hours * 60 + Number(e.target.value))}
      >
        {[0, 10, 20, 30, 40, 50].map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
      <span className="muted">분</span>
    </div>
  );
}

export function EmployeeSelect({
  employees,
  value,
  onChange,
  placeholder = "직원 선택",
  disabled,
  invalid,
}: {
  employees: readonly Employee[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">{placeholder}</option>
      {employees.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
          {e.department ? ` · ${e.department}` : ""}
          {e.active ? "" : " (비활성)"}
        </option>
      ))}
    </Select>
  );
}

export function LeaveTypeSelect({
  leaveTypes,
  value,
  onChange,
  placeholder = "휴가 종류 선택",
  disabled,
  invalid,
  labelOf = (t) => t.name,
}: {
  leaveTypes: readonly LeaveType[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** 보일 이름 (기본: 관리 이름. 휴가원 작성은 표시 이름) */
  labelOf?: (t: LeaveType) => string;
}) {
  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">{placeholder}</option>
      {leaveTypes.map((t) => (
        <option key={t.id} value={t.id}>
          {labelOf(t)}
          {t.active ? "" : " (비활성)"}
        </option>
      ))}
    </Select>
  );
}
