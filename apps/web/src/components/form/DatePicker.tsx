import { MAX_YEAR, MIN_YEAR, WEEKDAY_LABELS, addDays, isDateString, localToday, weekdayOf } from "@leave-flow/shared";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronIcon, ReturnIcon } from "../ui/icons.tsx";
import "./form.css";

const POPOVER_WIDTH = 268;
const POPOVER_GAP = 4;

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11" 에서 n달 뒤 */
export function shiftMonth(month: string, n: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${pad((total % 12) + 1)}`;
}

/** 그 달 1일이 든 주의 일요일 (달력 격자 첫 칸) */
export function monthGridStart(month: string): string {
  const first = `${month}-01`;
  return addDays(first, -weekdayOf(first));
}

/** "2026-11-26" → "2026. 11. 26." */
const dotDate = (date: string) => `${date.slice(0, 4)}. ${date.slice(5, 7)}. ${date.slice(8, 10)}.`;

/** 직접 입력한 글자 → "YYYY-MM-DD" (못 알아보면 null). "2026. 11. 26.", "2026-11-26", "20261126", "11/26"(연도는 기준 날짜의 해) */
function parseTypedDate(text: string, baseYear: string): string | null {
  const nums = text.match(/\d+/g);
  if (!nums) return null;
  let y: string;
  let m: string;
  let d: string;
  if (nums.length === 1 && nums[0]!.length === 8) {
    [y, m, d] = [nums[0]!.slice(0, 4), nums[0]!.slice(4, 6), nums[0]!.slice(6)];
  } else if (nums.length === 3) {
    [y, m, d] = nums as [string, string, string];
    if (y.length <= 2) y = `20${pad(Number(y))}`;
  } else if (nums.length === 2) {
    [y, m, d] = [baseYear, nums[0]!, nums[1]!];
  } else {
    return null;
  }
  const s = `${y.padStart(4, "0")}-${pad(Number(m))}-${pad(Number(d))}`;
  return isDateString(s) ? s : null;
}

/**
 * 한 달 달력 (6주). 날짜 입력 창과 달력 화면 왼쪽 축소판에서 함께 씀.
 * onToday 를 주면 머리에 [오늘] 단추가 나옴.
 * mini: 축소판 모양 (제목 "2026 8월", 오늘로 ↩ · 이전 달 ∧ · 다음 달 ∨ 아이콘)
 */
export function MonthCalendar({
  month,
  onMonthChange,
  selected,
  onPick,
  min,
  max,
  onToday,
  mini = false,
  className,
}: {
  /** 보이는 달 "YYYY-MM" */
  month: string;
  onMonthChange: (month: string) => void;
  selected: string | null;
  onPick: (date: string) => void;
  min?: string;
  max?: string;
  onToday?: () => void;
  mini?: boolean;
  className?: string;
}) {
  const today = localToday();
  const start = monthGridStart(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));

  return (
    <div className={className}>
      <div className="mcal-head">
        <strong className="mcal-title">{mini ? `${y} ${m}월` : `${y}년 ${m}월`}</strong>
        <span className="spacer" />
        {onToday &&
          (mini ? (
            <button type="button" className="mcal-nav" title="오늘로" aria-label="오늘로" onClick={onToday}>
              <ReturnIcon />
            </button>
          ) : (
            <button type="button" className="mcal-today" onClick={onToday}>
              오늘
            </button>
          ))}
        <button type="button" className="mcal-nav" title="이전 달" aria-label="이전 달" onClick={() => onMonthChange(shiftMonth(month, -1))}>
          {mini ? <ChevronIcon dir="up" /> : "‹"}
        </button>
        <button type="button" className="mcal-nav" title="다음 달" aria-label="다음 달" onClick={() => onMonthChange(shiftMonth(month, 1))}>
          {mini ? <ChevronIcon dir="down" /> : "›"}
        </button>
      </div>
      <div className="mcal-grid" role="grid" aria-label={`${Number(month.slice(0, 4))}년 ${Number(month.slice(5, 7))}월`}>
        {WEEKDAY_LABELS.map((w) => (
          <span key={w} className="mcal-dow" role="columnheader">
            {w}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={d}
            type="button"
            role="gridcell"
            className={[
              "mcal-day",
              d.slice(0, 7) !== month && "is-other",
              d === today && "is-today",
              d === selected && "is-selected",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-selected={d === selected}
            aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
            disabled={(!!min && d < min) || (!!max && d > max)}
            onClick={() => onPick(d)}
          >
            {Number(d.slice(8, 10))}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 날짜 입력. 입력칸을 누르면 달력 창이 열림 (직접 입력도 가능: Enter 로 확정, Esc 로 닫기).
 * min·max 를 주지 않으면 입력 가능한 연도 범위(MIN_YEAR~MAX_YEAR)로 제한
 */
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
  const lo = min ?? `${MIN_YEAR}-01-01`;
  const hi = max ?? `${MAX_YEAR}-12-31`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [typedError, setTypedError] = useState(false);
  const [month, setMonth] = useState(() => (value || localToday()).slice(0, 7));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // 열 때마다 고른 날짜(없으면 오늘)가 든 달부터
  useEffect(() => {
    if (open) setMonth((isDateString(value) ? value : localToday()).slice(0, 7));
  }, [open]);

  const place = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = popRef.current?.offsetHeight ?? 300;
    const above = r.bottom + POPOVER_GAP + height > window.innerHeight && r.top - POPOVER_GAP - height > 0;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    setPos({ left, top: above ? r.top - POPOVER_GAP - height : r.bottom + POPOVER_GAP });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t) || popRef.current?.contains(t)) return;
      commitDraft();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });

  /** 입력칸에 쓴 글자를 확정 (범위 안 날짜면 반영, 비우면 빈 값, 아니면 원래 값으로) */
  const commitDraft = (): boolean => {
    if (draft === null) return true;
    setDraft(null);
    if (draft.trim() === "") {
      setTypedError(false);
      if (value) onChange("");
      return true;
    }
    const d = parseTypedDate(draft, (value || localToday()).slice(0, 4));
    if (d && d >= lo && d <= hi) {
      setTypedError(false);
      if (d !== value) onChange(d);
      return true;
    }
    setTypedError(true);
    return false;
  };

  const pick = (d: string) => {
    setDraft(null);
    setTypedError(false);
    if (d !== value) onChange(d);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (commitDraft()) setOpen(false);
    } else if (e.key === "Escape" && open) {
      // 열린 창만 닫고, 바깥 모달은 닫지 않음
      e.stopPropagation();
      setDraft(null);
      setOpen(false);
    } else if (e.key === "Tab") {
      commitDraft();
      setOpen(false);
    }
  };

  const today = localToday();
  return (
    <>
      <input
        ref={inputRef}
        className="input date-input"
        value={draft ?? (isDateString(value) ? dotDate(value) : value)}
        placeholder="연도. 월. 일."
        inputMode="numeric"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-invalid={invalid || typedError || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onBlur={(e) => {
          if (popRef.current?.contains(e.relatedTarget as Node | null)) return;
          commitDraft();
        }}
        onKeyDown={onKeyDown}
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={ariaLabel ? `${ariaLabel} 고르기` : "날짜 고르기"}
            className="date-pop"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POPOVER_WIDTH }}
            // 날짜를 눌러도 입력칸 포커스가 빠지지 않게
            onMouseDown={(e) => e.preventDefault()}
          >
            <MonthCalendar
              month={month}
              onMonthChange={setMonth}
              selected={isDateString(value) ? value : null}
              onPick={pick}
              min={lo}
              max={hi}
              onToday={today >= lo && today <= hi ? () => pick(today) : undefined}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
