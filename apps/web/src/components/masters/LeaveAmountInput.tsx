import { useState } from "react";
import { splitLeaveMinutes } from "@leave-flow/shared";
import { AmountBox } from "./inputs.tsx";
import "./masters.css";

type Draft = { d: number | ""; h: number | ""; m: number | "" };

function split(value: number, dayMinutes: number): Draft {
  const p = splitLeaveMinutes(value, dayMinutes);
  return { d: p.days, h: p.hours, m: p.minutes };
}

const total = (x: Draft, dayMinutes: number) => (x.d || 0) * dayMinutes + (x.h || 0) * 60 + (x.m || 0);

/** 휴가 양(분)을 [ ]일 [ ]시간 [ ]분 으로 직접 입력 (1일 = dayMinutes, 그 직원의 하루 근무시간. 분은 10분 단위). 넘치는 시간·분은 위 단위로 넘김 */
export function LeaveAmountInput({
  value,
  onChange,
  dayMinutes,
  disabled,
  invalid,
  ariaLabel = "양",
}: {
  value: number;
  onChange: (minutes: number) => void;
  dayMinutes: number;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  // 입력 중인 칸이 비어 있어도 그대로 보이도록 칸별 값을 따로 둠
  const [draft, setDraft] = useState<Draft>(() => split(value, dayMinutes));
  // 바깥에서 값이 바뀌면 (수정 창 열기 등) 칸을 다시 채움
  if (total(draft, dayMinutes) !== value) setDraft(split(value, dayMinutes));
  const emit = (next: Draft) => {
    setDraft(next);
    onChange(total(next, dayMinutes));
  };

  return (
    // 칸을 벗어나면 60분 이상은 시간으로, 하루 근무시간 이상은 일로 넘김 (예: 3시간 70분 → 4시간 10분)
    <div className="amount-input" onBlur={() => setDraft(split(total(draft, dayMinutes), dayMinutes))}>
      <AmountBox
        value={draft.d}
        max={9999}
        unit="일"
        label={`${ariaLabel} (일)`}
        disabled={disabled}
        invalid={invalid}
        onChange={(d) => emit({ ...draft, d })}
      />
      <AmountBox
        value={draft.h}
        max={99999}
        unit="시간"
        label={`${ariaLabel} (시간)`}
        disabled={disabled}
        invalid={invalid}
        onChange={(h) => emit({ ...draft, h })}
      />
      <AmountBox
        value={draft.m}
        max={99999}
        unit="분"
        label={`${ariaLabel} (분, 10분 단위)`}
        disabled={disabled}
        invalid={invalid}
        onChange={(m) => emit({ ...draft, m })}
      />
    </div>
  );
}
