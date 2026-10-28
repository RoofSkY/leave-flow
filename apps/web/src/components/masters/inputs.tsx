// 기준정보 입력 요소: 묶음 필드, 요일 칩, 결재칸 칩, 색상 고르기, 정수 양 입력, 연도 선택
import { useId, type ReactNode } from "react";
import { APPROVAL_ROLES, WEEKDAY_LABELS, daysHoursToMinutes, type ApprovalRole } from "@leave-flow/shared";
import { currentYear } from "../../lib/format.ts";
import { Select, TextInput } from "../ui/index.tsx";
import { WEEKDAY_ORDER } from "./labels.ts";
import "./masters.css";

/**
 * 버튼 묶음용 필드. Field(<label>)로 감싸면 제목을 눌러도 첫 버튼이 눌리므로 div + role="group" 사용.
 */
export function FieldGroup({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span className="field-label" id={id}>
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/** 근무 요일 고르기 (월~일 칩) */
export function WeekdayChips({ value, onChange }: { value: readonly number[]; onChange: (days: number[]) => void }) {
  const toggle = (d: number) =>
    onChange(value.includes(d) ? value.filter((v) => v !== d) : [...value, d].sort((a, b) => a - b));
  return (
    <div className="chip-group">
      {WEEKDAY_ORDER.map((d) => (
        <button
          key={d}
          type="button"
          className={["chip", (d === 0 || d === 6) && "chip-weekend"].filter(Boolean).join(" ")}
          aria-pressed={value.includes(d)}
          onClick={() => toggle(d)}
        >
          {WEEKDAY_LABELS[d]}
        </button>
      ))}
    </div>
  );
}

/** 휴가원 결재칸 고르기 (담당·팀장·센터장·대표 칩, 양식에는 이 순서로 나옴) */
export function ApprovalRoleChips({
  value,
  onChange,
}: {
  value: readonly ApprovalRole[];
  onChange: (roles: ApprovalRole[]) => void;
}) {
  const toggle = (role: ApprovalRole) =>
    onChange(APPROVAL_ROLES.filter((r) => (r === role ? !value.includes(r) : value.includes(r))));
  return (
    <div className="chip-group">
      {APPROVAL_ROLES.map((role) => (
        <button key={role} type="button" className="chip" aria-pressed={value.includes(role)} onClick={() => toggle(role)}>
          {role}
        </button>
      ))}
    </div>
  );
}

/** 직원 색상 후보 (서로 잘 구분되는 차분한 색) */
export const EMPLOYEE_COLORS = [
  "#4f7cff",
  "#2a9fd6",
  "#1f9e89",
  "#3fa34d",
  "#8aa62b",
  "#d9a21b",
  "#e0723c",
  "#d4524f",
  "#d24d8c",
  "#a35bd1",
  "#8b6c4f",
  "#64748b",
] as const;

/** 다른 직원이 아직 쓰지 않은 첫 색 */
export function pickUnusedColor(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return EMPLOYEE_COLORS.find((c) => !taken.has(c)) ?? EMPLOYEE_COLORS[used.length % EMPLOYEE_COLORS.length]!;
}

export function ColorPicker({
  value,
  onChange,
  usedColors = [],
}: {
  value: string;
  onChange: (color: string) => void;
  /** 다른 직원이 쓰는 색 (점으로 표시) */
  usedColors?: readonly string[];
}) {
  const current = value.toLowerCase();
  const taken = new Set(usedColors.map((c) => c.toLowerCase()));
  return (
    <div className="swatches">
      {EMPLOYEE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={["swatch", taken.has(c) && "is-used"].filter(Boolean).join(" ")}
          style={{ background: c }}
          aria-pressed={current === c}
          aria-label={taken.has(c) ? `${c} (다른 직원이 사용 중)` : c}
          title={taken.has(c) ? "다른 직원이 사용 중" : undefined}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="color-custom" title="다른 색 직접 고르기">
        <input type="color" value={current} onChange={(e) => onChange(e.target.value)} aria-label="다른 색 직접 고르기" />
        <span className="muted">직접</span>
      </label>
    </div>
  );
}

/** 휴가 양의 숫자 칸 하나 (직접 입력). max 를 넘거나 음수면 그 범위로 맞춤. 비우면 "" */
export function AmountBox({
  value,
  onChange,
  max,
  unit,
  label,
  disabled,
  invalid,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
  max: number;
  unit: string;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <>
      <TextInput
        type="number"
        min={0}
        max={max}
        step={1}
        inputMode="numeric"
        className="amount-box"
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-label={label}
        onFocus={(e) => e.target.select()}
        onChange={(e) =>
          onChange(
            e.target.value === "" ? "" : Math.min(max, Math.max(0, Math.floor(Number(e.target.value) || 0))),
          )
        }
      />
      <span className="muted">{unit}</span>
    </>
  );
}

export interface DayHourValue {
  days: number | "";
  hours: number | "";
}

/** 일·시간 → 분 (빈칸은 0, 1일 = dayMinutes) */
export function dayHourToMinutes(v: DayHourValue, dayMinutes: number): number {
  return daysHoursToMinutes(v.days || 0, v.hours || 0, dayMinutes);
}

/** 분 → 일·시간 (1일 = dayMinutes). 시간 단위로 나누어떨어지지 않는 분은 시간의 소수로 */
export function minutesToDayHour(minutes: number, dayMinutes: number): DayHourValue {
  const days = Math.floor(minutes / dayMinutes);
  return { days, hours: Math.round(((minutes - days * dayMinutes) / 60) * 100) / 100 };
}

/**
 * 부여량을 [ ]일 [ ]시간 으로 직접 입력.
 * dayMinutes(1일 = 그 직원의 하루 근무시간)를 주면 칸을 벗어날 때 넘치는 시간을 일로 넘김 (예: 8시간 근무 3일 10시간 → 4일 2시간).
 * 근무시간이 다른 여러 직원에게 한 번에 줄 때처럼 1일이 정해지지 않으면 넘기지 않음.
 */
export function DayHourInput({
  value,
  onChange,
  dayMinutes,
  invalid,
}: {
  value: DayHourValue;
  onChange: (v: DayHourValue) => void;
  dayMinutes?: number;
  invalid?: boolean;
}) {
  const carry = () => {
    if (!dayMinutes || value.hours === "" || value.hours * 60 < dayMinutes) return;
    const total = dayHourToMinutes(value, dayMinutes);
    onChange(minutesToDayHour(total, dayMinutes));
  };

  return (
    <div className="amount-input" onBlur={carry}>
      <AmountBox
        value={value.days}
        max={9999}
        unit="일"
        label="양 (일)"
        invalid={invalid}
        onChange={(days) => onChange({ ...value, days })}
      />
      <AmountBox
        value={value.hours}
        max={99999}
        unit="시간"
        label="양 (시간)"
        invalid={invalid}
        onChange={(hours) => onChange({ ...value, hours })}
      />
    </div>
  );
}

/** 연도 선택 (올해 기준 앞뒤 몇 해). allLabel 을 주면 "전체"(null) 선택지 추가 */
export function YearSelect({
  value,
  onChange,
  allLabel,
  disabled,
}: {
  value: number | null;
  onChange: (year: number | null) => void;
  allLabel?: string;
  disabled?: boolean;
}) {
  const now = currentYear();
  const years = new Set<number>();
  for (let y = now + 1; y >= now - 5; y--) years.add(y);
  if (value !== null) years.add(value);
  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      aria-label="연도"
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      {allLabel && <option value="">{allLabel}</option>}
      {[...years]
        .sort((a, b) => b - a)
        .map((y) => (
          <option key={y} value={y}>
            {y}년
          </option>
        ))}
    </Select>
  );
}
