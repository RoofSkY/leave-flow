import { useId, type ReactNode } from "react";
import { Select } from "../ui/index.tsx";
import { CATEGORY_LABEL } from "./labels.ts";
import type { LeaveType, OvertimeCategory } from "@leave-flow/shared";

/** 여러 입력을 묶는 항목 (Field 와 같은 모양이지만 <label> 이 아님 → 체크 목록·라디오에 사용) */
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
  return (
    <div className="field" role="group">
      <span className="field-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/** 상세내용 선택 (라디오) */
export function CategoryRadios<C extends OvertimeCategory>({
  options,
  value,
  onChange,
}: {
  options: readonly C[];
  value: C;
  onChange: (v: C) => void;
}) {
  const name = useId();
  return (
    <div className="ot-radios" role="radiogroup" aria-label="상세내용">
      {options.map((c) => (
        <label key={c} className="checkbox">
          <input type="radio" name={name} checked={value === c} onChange={() => onChange(c)} />
          <span>{CATEGORY_LABEL[c]}</span>
        </label>
      ))}
    </div>
  );
}

/** 대상자 한 명의 적립 휴가 종류 선택 (처음에는 비어 있음) */
export function AccrualTypeSelect({
  name,
  options,
  value,
  onChange,
  invalid,
}: {
  /** 대상자 성명 (화면 낭독용 이름) */
  name: string;
  options: readonly LeaveType[];
  value: number | null;
  onChange: (id: number | null) => void;
  invalid?: boolean;
}) {
  return (
    <Select
      value={value ?? ""}
      aria-label={`${name} 적립할 휴가 종류`}
      aria-invalid={invalid || undefined}
      className="ot-type"
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">휴가 종류 선택</option>
      {options.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
          {t.active ? "" : " (비활성)"}
        </option>
      ))}
    </Select>
  );
}
