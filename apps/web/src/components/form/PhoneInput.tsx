import { formatPhoneNumber } from "@leave-flow/shared";
import { useLayoutEffect, useRef, type ChangeEvent } from "react";

/** 문자열에서 앞쪽 n개의 숫자가 끝나는 위치 */
function positionAfterDigits(text: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]!)) seen++;
    if (seen === n) return i + 1;
  }
  return text.length;
}

const countDigits = (text: string) => text.replace(/\D/g, "").length;

/**
 * 전화번호 입력. 숫자를 치면 하이픈이 자동으로 들어감 (010-1234-5678).
 * 하이픈 바로 뒤에서 지우면 그 앞 숫자가 지워지고, 중간을 고쳐도 커서가 제자리에 남음.
 */
export function PhoneInput({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  /** 다시 그린 뒤 커서를 둘 위치 (그 앞의 숫자 개수) */
  const caretDigits = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || caretDigits.current === null || document.activeElement !== el) return;
    const p = positionAfterDigits(el.value, caretDigits.current);
    el.setSelectionRange(p, p);
    caretDigits.current = null;
  });

  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    let digitsBefore = countDigits(raw.slice(0, caret));
    // 하이픈만 지워진 경우(숫자 개수 그대로): 하이픈 앞 숫자를 지움
    if (raw.length < value.length && countDigits(raw) === countDigits(value) && digitsBefore > 0) {
      const cut = positionAfterDigits(raw, digitsBefore);
      raw = raw.slice(0, cut - 1) + raw.slice(cut);
      digitsBefore -= 1;
    }
    caretDigits.current = digitsBefore;
    onChange(formatPhoneNumber(raw));
  };

  return (
    <input
      ref={ref}
      className="input"
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      maxLength={14}
      value={value}
      placeholder="010-0000-0000"
      aria-invalid={invalid || undefined}
      onChange={handle}
    />
  );
}
