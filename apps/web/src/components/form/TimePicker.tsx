import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./form.css";

const POPOVER_WIDTH = 252;
const POPOVER_GAP = 4;

const hourOf = (t: string) => t.slice(0, 2);
const minuteOf = (t: string) => t.slice(3, 5);

/** 직접 입력한 글자 → "HH:MM" (못 알아보면 null). "930", "0930", "9:30", "14", "14시 30분" 모두 허용 */
function parseTypedTime(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  let h: number;
  let m: number;
  const sep = /^(\d{1,2})\s*[:시.\s]\s*(\d{1,2})?\s*분?$/.exec(s);
  if (sep) {
    h = Number(sep[1]);
    m = sep[2] ? Number(sep[2]) : 0;
  } else if (/^\d{1,4}$/.test(s)) {
    if (s.length <= 2) {
      h = Number(s);
      m = 0;
    } else {
      h = Number(s.slice(0, s.length - 2));
      m = Number(s.slice(-2));
    }
  } else {
    return null;
  }
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 시각 선택. 입력칸을 누르면 [시] 단추와 [분] 단추가 나오는 작은 창이 열림 (직접 입력도 가능).
 * options("HH:MM" 목록)에 있는 시각만 고를 수 있음 — 휴가는 근무시간 안 10분 단위 + 반차 경계.
 * 키보드: ↑↓ 로 이전·다음 시각, Enter 로 입력 확정, Esc 로 닫기.
 */
export function TimeSelect({
  value,
  onChange,
  options,
  disabled,
  invalid,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [typedError, setTypedError] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  // 시 단추에 보여 줄 시 (허용 시각이 하나라도 있는 시)
  const hours = [...new Set(options.map(hourOf))];
  const [shownHour, setShownHour] = useState<string>(value ? hourOf(value) : "");
  useEffect(() => {
    if (value) setShownHour(hourOf(value));
  }, [value]);
  const activeHour = shownHour && hours.includes(shownHour) ? shownHour : (hours[0] ?? "");
  const minutes = options.filter((t) => hourOf(t) === activeHour).map(minuteOf);

  const place = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = popRef.current?.offsetHeight ?? 240;
    const above = r.bottom + POPOVER_GAP + height > window.innerHeight && r.top - POPOVER_GAP - height > 0;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    setPos({ left, top: above ? r.top - POPOVER_GAP - height : r.bottom + POPOVER_GAP, above });
  };

  useLayoutEffect(() => {
    if (open) place();
    // 시를 바꾸면 분 단추 줄 수가 달라져 창 높이가 바뀌므로 다시 맞춤
  }, [open, activeHour, minutes.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close(true);
    };
    const onMove = () => place();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  });

  /** 입력칸에 쓴 글자를 확정 (허용 시각이면 반영, 아니면 원래 값으로) */
  const commitDraft = (): boolean => {
    if (draft === null) return true;
    const t = parseTypedTime(draft);
    setDraft(null);
    if (t && options.includes(t)) {
      setTypedError(false);
      if (t !== value) onChange(t);
      return true;
    }
    setTypedError(draft.trim() !== "");
    return false;
  };

  const close = (commit: boolean) => {
    if (commit) commitDraft();
    setOpen(false);
  };

  const pick = (t: string, done: boolean) => {
    setDraft(null);
    setTypedError(false);
    if (t !== value) onChange(t);
    if (done) {
      setOpen(false);
      inputRef.current?.focus();
    }
  };

  const pickHour = (h: string) => {
    setShownHour(h);
    const keepMinute = value ? minuteOf(value) : "00";
    const inHour = options.filter((t) => hourOf(t) === h);
    const next = inHour.find((t) => minuteOf(t) === keepMinute) ?? inHour[0];
    if (next) pick(next, false);
  };

  const step = (dir: 1 | -1) => {
    if (options.length === 0) return;
    const i = value ? options.indexOf(value) : -1;
    const next = i < 0 ? options[dir === 1 ? 0 : options.length - 1]! : options[Math.max(0, Math.min(options.length - 1, i + dir))]!;
    pick(next, false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      step(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (commitDraft()) setOpen(false);
    } else if (e.key === "Escape" && open) {
      // 열린 창만 닫고, 바깥 모달은 닫지 않음
      e.stopPropagation();
      setDraft(null);
      setOpen(false);
    } else if (e.key === "Tab") {
      close(true);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className="input time-input"
        value={draft ?? value}
        placeholder="--:--"
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || typedError || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onBlur={(e) => {
          // 창 안의 단추를 누르는 중이면 그대로 둠
          if (popRef.current?.contains(e.relatedTarget as Node | null)) return;
          commitDraft();
        }}
        onKeyDown={onKeyDown}
      />
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-label={ariaLabel ? `${ariaLabel} 고르기` : "시각 고르기"}
            className="time-pop"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POPOVER_WIDTH }}
            // 단추를 눌러도 입력칸 포커스가 빠지지 않게
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.length === 0 ? (
              <div className="time-pop-empty">고를 수 있는 시각이 없습니다.</div>
            ) : (
              <>
                <div className="time-pop-label">시</div>
                <div className="time-pop-hours">
                  {hours.map((h) => (
                    <button
                      key={h}
                      type="button"
                      tabIndex={-1}
                      className={["time-chip", h === activeHour && "is-active", value && hourOf(value) === h && "is-selected"]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => pickHour(h)}
                    >
                      {Number(h)}
                    </button>
                  ))}
                </div>
                <div className="time-pop-label">분</div>
                <div className="time-pop-minutes">
                  {minutes.map((m) => {
                    const t = `${activeHour}:${m}`;
                    return (
                      <button
                        key={m}
                        type="button"
                        tabIndex={-1}
                        className={["time-chip", value === t && "is-selected"].filter(Boolean).join(" ")}
                        onClick={() => pick(t, true)}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
                <div className="time-pop-hint">직접 입력도 됩니다 (예: 930, 14:30) · ↑↓ 로 10분씩</div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
