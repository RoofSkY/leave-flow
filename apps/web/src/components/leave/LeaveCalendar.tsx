import type {
  CalendarApi,
  DateSelectArg,
  DatesSetArg,
  DayCellContentArg,
  DayHeaderContentArg,
  EventClickArg,
  EventContentArg,
  EventInput,
} from "@fullcalendar/core";
import koLocale from "@fullcalendar/core/locales/ko";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { type DateClickArg } from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import {
  WEEKDAY_LABELS,
  addDays,
  formatTime,
  mergeLeavePeriods,
  parseTime,
  weekdayOf,
  type CalendarEvent,
  type HolidayKind,
} from "@leave-flow/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../ui/index.tsx";
import { localToday } from "../../lib/format.ts";
import { useEmployees, useHolidays } from "../../lib/queries.ts";
import { monthGridStart, shiftMonth } from "../form/DatePicker.tsx";
import { isShown, type CalendarHidden } from "./CalendarFilter.tsx";
import { ChevronIcon } from "../ui/icons.tsx";
import { shortRange, tint, useCalendarEvents } from "./leaveQueries.ts";
import "./calendar.css";

/** 작성 화면에 미리 채울 기간 */
export interface EditorPrefill {
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
}

/** 축소판에서 고른 날짜 (같은 날을 다시 골라도 이동하도록 seq 를 올림) */
export interface CalendarFocus {
  date: string;
  seq: number;
}

/** 월 보기: 6주를 보여 주고 휠로 한 주씩 이어서 넘김. 그 달 1일이 든 주부터 놓으면 한 달이 다 보임 */
const MONTH_VIEW = "monthWeeks";
const WEEK_VIEW = "timeGridWeek";
type ViewType = typeof MONTH_VIEW | typeof WEEK_VIEW;
const MONTH_WEEKS = 6;
/** 휠을 이만큼(px) 굴리면 한 주 (마우스 휠 한 칸이 보통 100) */
const WHEEL_STEP = 100;

const VIEWS: { type: ViewType; label: string; key: string }[] = [
  { type: WEEK_VIEW, label: "주", key: "W" },
  { type: MONTH_VIEW, label: "월", key: "M" },
];

/** 단축키. KeyboardEvent.code 로 비교해 한글 입력 상태에서도 동작 */
const SHORTCUTS = [
  { code: "KeyW", key: "W", label: "주 보기" },
  { code: "KeyM", key: "M", label: "월 보기" },
  { code: "KeyT", key: "T", label: "오늘" },
] as const;

type HolidayMap = Map<string, { name: string; kind: HolidayKind }[]>;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const monthOf = (date: string) => date.slice(0, 7);
const lastOfMonth = (month: string) => addDays(`${shiftMonth(month, 1)}-01`, -1);
/** 날짜 칸 숫자. 1일에는 달을 굵게 붙임 ("11월 1") */
const dayLabel = (d: Date): ReactNode =>
  d.getDate() === 1 ? (
    // 한 덩이로 감싸야 flex 인 lf-day-num 안에서 사이 띄어쓰기가 살아남음
    <span>
      <b>{d.getMonth() + 1}월</b> 1
    </span>
  ) : (
    d.getDate()
  );
/** 축소판에서 고른 칸: 이만큼 강조한 뒤 천천히 사라짐 (사라지는 길이는 calendar.css lf-unpick 과 같게) */
const PICK_HOLD_MS = 1000;
const PICK_FADE_MS = 1000;

/** 월 보기 범위: 그 달 1일이 든 주부터 6주 */
function monthRange(month: string): { from: string; to: string } {
  const from = monthGridStart(month);
  return { from, to: addDays(from, MONTH_WEEKS * 7 - 1) };
}

/** 보이는 날 중 가장 많은 날이 속한 달 (같으면 앞 달) */
function mainMonth(from: string, to: string): string {
  const counts = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) counts.set(monthOf(d), (counts.get(monthOf(d)) ?? 0) + 1);
  let best = monthOf(from);
  for (const [m, n] of counts) if (n > counts.get(best)!) best = m;
  return best;
}

/** 주 보기 제목 */
function rangeTitle(from: string, to: string): string {
  const y1 = Number(from.slice(0, 4));
  const m1 = Number(from.slice(5, 7));
  const y2 = Number(to.slice(0, 4));
  const m2 = Number(to.slice(5, 7));
  if (y1 === y2 && m1 === m2) return `${y1}년 ${m1}월`;
  if (y1 === y2) return `${y1}년 ${m1}월 – ${m2}월`;
  return `${y1}년 ${m1}월 – ${y2}년 ${m2}월`;
}

/** 글을 쓰는 칸에 있을 때는 단축키를 받지 않음 (체크박스 등은 받음) */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type);
}

/** 월 보기: 한 휴가원의 이어지는 항목은 한 줄로 (휴가원 목록·출력과 같은 규칙, 사이의 휴일도 쉬는 날로 봄) */
function mergeRuns(list: CalendarEvent[], holidays: HolidayMap): CalendarEvent[] {
  const byRequest = new Map<number, CalendarEvent[]>();
  for (const e of list) byRequest.set(e.requestId, [...(byRequest.get(e.requestId) ?? []), e]);
  return [...byRequest.values()].flatMap((items) =>
    mergeLeavePeriods(items, items[0]!, (d) => holidays.has(d)).map((p) => ({
      ...p.items[0]!,
      startAt: p.startAt,
      endAt: p.endAt,
      minutes: p.items.reduce((n, i) => n + i.minutes, 0),
      leaveTypeName: [...new Set(p.items.map((i) => i.leaveTypeName))].join(", "),
    })),
  );
}

function HolidayLabel({ list }: { list: { name: string; kind: HolidayKind }[] | undefined }) {
  if (!list?.length) return null;
  const isPublic = list.some((h) => h.kind === "public");
  const text = list.map((h) => h.name).join(", ");
  return (
    <span className={["lf-hol-name", !isPublic && "is-center"].filter(Boolean).join(" ")} title={text}>
      {text}
    </span>
  );
}

/** [월 ∨] 보기 고르기 */
function ViewMenu({ view, onChange }: { view: ViewType; onChange: (view: ViewType) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lf-menu-wrap" ref={wrapRef}>
      <Button aria-haspopup="menu" aria-expanded={open} title="보기 (W·M)" onClick={() => setOpen((v) => !v)}>
        {VIEWS.find((v) => v.type === view)?.label}
        <ChevronIcon dir="down" size={14} />
      </Button>
      {open && (
        <div className="lf-menu" role="menu" aria-label="보기">
          {VIEWS.map((v) => (
            <button
              key={v.type}
              type="button"
              role="menuitemradio"
              aria-checked={v.type === view}
              className="lf-menu-item"
              onClick={() => {
                setOpen(false);
                onChange(v.type);
              }}
            >
              <span className="lf-menu-check" aria-hidden>
                {v.type === view ? "✓" : ""}
              </span>
              <span>{v.label}</span>
              <span className="lf-menu-key">{v.key}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 단축키 안내 (달력 오른쪽 패널) */
export function ShortcutGuide() {
  return (
    <section className="lf-keys" aria-label="단축키">
      <h2 className="lf-side-title">단축키</h2>
      <ul className="lf-keys-list">
        {SHORTCUTS.map((s) => (
          <li key={s.code}>
            <span>{s.label}</span>
            <kbd className="lf-key">{s.key}</kbd>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LeaveCalendar({
  showCancelled,
  hidden,
  focus,
  onFocusClear,
  onMonthChange,
  onCreate,
  onOpenRequest,
  headerStart,
  actions,
  headerEnd,
}: {
  showCancelled: boolean;
  /** 왼쪽 패널에서 끈 소속·구분·직원 */
  hidden: CalendarHidden;
  /** 이 날짜로 옮기고 칸을 강조 */
  focus: CalendarFocus | null;
  /** [오늘]을 누르면 강조를 지움 */
  onFocusClear: () => void;
  /** 제목의 달이 바뀔 때 ("YYYY-MM") */
  onMonthChange: (month: string) => void;
  onCreate: (prefill: EditorPrefill) => void;
  onOpenRequest: (requestId: number) => void;
  /** 머리 맨 왼쪽 */
  headerStart?: ReactNode;
  /** 머리 오른쪽, 보기 단추 앞 */
  actions?: ReactNode;
  /** 머리 맨 오른쪽 */
  headerEnd?: ReactNode;
}) {
  const calRef = useRef<FullCalendar>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewType>(MONTH_VIEW);
  const [range, setRange] = useState(() => monthRange(monthOf(localToday())));
  const [initialDate] = useState(range.from);
  const month = useMemo(() => mainMonth(range.from, range.to), [range.from, range.to]);
  const title = view === WEEK_VIEW ? rangeTitle(range.from, range.to) : rangeTitle(`${month}-01`, `${month}-01`);

  // 한 주씩 넘길 때마다 다시 부르지 않도록 보이는 범위를 달 단위로 넓혀 조회
  const fetchFrom = `${monthOf(range.from)}-01`;
  const fetchTo = lastOfMonth(monthOf(range.to));
  const eventsQ = useCalendarEvents(fetchFrom, fetchTo);
  const holidaysQ = useHolidays(fetchFrom, fetchTo);
  const employeesQ = useEmployees(true);

  const api = (): CalendarApi | undefined => calRef.current?.getApi();

  useEffect(() => onMonthChange(month), [month, onMonthChange]);

  // 공휴일 조회가 실패하면 공휴일 없이 표시
  const holidayMap = useMemo<HolidayMap>(() => {
    const map: HolidayMap = new Map();
    for (const h of holidaysQ.data ?? []) {
      if (!h.active) continue;
      map.set(h.date, [...(map.get(h.date) ?? []), { name: h.name, kind: h.kind }]);
    }
    return map;
  }, [holidaysQ.data]);

  // 월 보기: 여러 날 휴가는 한 줄로 이어서 (한 휴가원의 이어진 날짜 항목도 합침). 주 보기: 날마다 근무시간 안만 (근무하지 않는 날·휴일 제외)
  // 날마다 나눌 때는 직원의 지금 근무 일정이 아니라 휴가원에 저장된 근무 일정(사용 시간 계산 기준)을 씀
  const events = useMemo<EventInput[]>(() => {
    const out: EventInput[] = [];
    const visible = (eventsQ.data ?? []).filter(
      (e) =>
        (showCancelled || e.status === "active") &&
        isShown(hidden, { id: e.employeeId, department: e.department, category: e.category }),
    );
    for (const e of view === WEEK_VIEW ? visible : mergeRuns(visible, holidayMap)) {
      const base = { title: `${e.employeeName} · ${e.leaveTypeName}`, extendedProps: { ev: e } };
      const first = e.startAt.slice(0, 10);
      const last = e.endAt.slice(0, 10);
      if (view !== WEEK_VIEW || first === last) {
        out.push({ ...base, id: String(e.itemId), start: e.startAt, end: e.endAt });
        continue;
      }
      for (let d = first; d <= last; d = addDays(d, 1)) {
        if (!e.workDays.includes(weekdayOf(d)) || holidayMap.has(d)) continue;
        const from = d === first ? e.startAt.slice(11, 16) : e.workStart;
        const to = d === last ? e.endAt.slice(11, 16) : e.workEnd;
        if (to > from) out.push({ ...base, id: `${e.itemId}-${d}`, start: `${d}T${from}`, end: `${d}T${to}` });
      }
    }
    return out;
  }, [eventsQ.data, hidden, holidayMap, showCancelled, view]);

  // 주 보기 시간 범위: 직원 근무시간과 보이는 휴가원에 저장된 근무시간을 모두 덮도록
  const slots = useMemo(() => {
    const schedules = [...(employeesQ.data ?? []), ...(eventsQ.data ?? [])];
    if (schedules.length === 0) return { min: "08:00:00", max: "20:00:00" };
    const start = Math.min(...schedules.map((e) => parseTime(e.workStart)));
    const end = Math.max(...schedules.map((e) => parseTime(e.workEnd)));
    return {
      min: `${formatTime(Math.floor(start / 60) * 60)}:00`,
      max: `${formatTime(Math.min(24 * 60, Math.ceil(end / 60) * 60))}:00`,
    };
  }, [employeesQ.data, eventsQ.data]);

  /* ---------- 이동 ---------- */

  const goToday = () => {
    const cal = api();
    if (!cal) return;
    if (cal.view.type === WEEK_VIEW) cal.today();
    else cal.gotoDate(monthGridStart(monthOf(localToday())));
    onFocusClear();
  };

  /** ∧∨: 월 보기는 한 달, 주 보기는 한 주 */
  const step = (dir: 1 | -1) => {
    const cal = api();
    if (!cal) return;
    if (cal.view.type === WEEK_VIEW) {
      if (dir === 1) cal.next();
      else cal.prev();
    } else {
      cal.gotoDate(monthGridStart(shiftMonth(month, dir)));
    }
  };

  const switchView = (type: ViewType) => {
    const cal = api();
    if (!cal || cal.view.type === type) return;
    if (type === MONTH_VIEW) {
      cal.changeView(MONTH_VIEW, monthGridStart(month));
      return;
    }
    // 주 보기: 지금 보이는 날 중 강조한 날 → 오늘 → 그 달 1일이 든 주
    const inView = (d: string) => d >= range.from && d <= range.to;
    const today = localToday();
    cal.changeView(WEEK_VIEW, focus && inView(focus.date) ? focus.date : inView(today) ? today : `${month}-01`);
  };

  // 축소판에서 고른 날짜로 (월 보기는 그 달 첫 주부터)
  useEffect(() => {
    const cal = api();
    if (!focus || !cal) return;
    cal.gotoDate(cal.view.type === WEEK_VIEW ? focus.date : monthGridStart(monthOf(focus.date)));
  }, [focus]);

  // 고른 칸 강조: PICK_HOLD_MS 뒤 lf-unpicking 으로 바꿔 천천히 지우고, 다 지워지면 뗌
  const [picked, setPicked] = useState<{ date: string; fading: boolean } | null>(null);
  useEffect(() => {
    if (!focus) {
      setPicked(null);
      return;
    }
    setPicked({ date: focus.date, fading: false });
    const fade = setTimeout(() => setPicked({ date: focus.date, fading: true }), PICK_HOLD_MS);
    const end = setTimeout(() => setPicked(null), PICK_HOLD_MS + PICK_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(end);
    };
  }, [focus]);
  const pickClass = (date: string) => (date !== picked?.date ? null : picked.fading ? "lf-unpicking" : "lf-picked");

  // 단축키: 창(휴가원 작성·상세)이 열려 있거나 글을 쓰는 중에는 받지 않음
  const keyActions = useRef<Record<string, () => void>>({});
  keyActions.current = { KeyW: () => switchView(WEEK_VIEW), KeyM: () => switchView(MONTH_VIEW), KeyT: goToday };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      const action = keyActions.current[e.code];
      if (!action || isTyping(e.target) || document.querySelector(".modal-overlay")) return;
      e.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 휠: 한 칸에 한 주씩. 주 보기에서 시간표가 화면보다 길면 그 안에서 스크롤
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      const cal = api();
      if (!cal || e.ctrlKey || (e.target as Element).closest(".fc-popover")) return;
      if (cal.view.type === WEEK_VIEW) {
        const scroller = el.querySelector(".fc-timegrid-body")?.closest(".fc-scroller");
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return;
      }
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      if (dy === 0) return;
      // 마우스 휠 한 칸은 바로 한 주, 터치패드처럼 잘게 오는 값은 모아서
      if (Math.abs(dy) >= WHEEL_STEP) {
        acc = 0;
        cal.incrementDate({ weeks: Math.sign(dy) });
        return;
      }
      if (Math.sign(dy) !== Math.sign(acc)) acc = 0;
      acc += dy;
      if (Math.abs(acc) < WHEEL_STEP) return;
      cal.incrementDate({ weeks: Math.sign(acc) });
      acc = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* ---------- FullCalendar 콜백 ---------- */

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    setRange({ from: localToday(arg.start), to: addDays(localToday(arg.end), -1) });
    setView(arg.view.type === WEEK_VIEW ? WEEK_VIEW : MONTH_VIEW);
  }, []);

  // 한 칸 누르기는 dateClick 에서. 여기서는 드래그한 범위만 (터치는 길게 누른 뒤 끌기)
  const handleSelect = useCallback(
    (arg: DateSelectArg) => {
      arg.view.calendar.unselect();
      const startDate = localToday(arg.start);
      if (arg.allDay) {
        const endDate = addDays(localToday(arg.end), -1);
        if (startDate !== endDate) onCreate({ startDate, endDate });
        return;
      }
      if (arg.end.getTime() - arg.start.getTime() <= 10 * 60_000) return;
      onCreate({ startDate, startTime: hhmm(arg.start), endDate: localToday(arg.end), endTime: hhmm(arg.end) });
    },
    [onCreate],
  );

  // 날짜 칸(주 보기는 시간 칸)을 누르면 그 날짜로 휴가원 작성
  const handleDateClick = useCallback(
    (arg: DateClickArg) => {
      const date = localToday(arg.date);
      onCreate({ startDate: date, endDate: date });
    },
    [onCreate],
  );

  const handleEventClick = useCallback(
    (arg: EventClickArg) => {
      arg.jsEvent.preventDefault();
      const ev = arg.event.extendedProps.ev as CalendarEvent;
      onOpenRequest(ev.requestId);
    },
    [onOpenRequest],
  );

  const renderEvent = useCallback((arg: EventContentArg) => {
    const ev = arg.event.extendedProps.ev as CalendarEvent;
    const style = { "--ev-color": ev.color, "--ev-bg": tint(ev.color, 0.16) } as CSSProperties;
    const cancelled = ev.status === "cancelled";
    return (
      <div
        className={["lf-ev", cancelled && "is-cancelled"].filter(Boolean).join(" ")}
        style={style}
        title={`${ev.employeeName} · ${ev.leaveTypeName}\n${shortRange(ev.startAt, ev.endAt, true)}${cancelled ? "\n(취소됨)" : ""}`}
      >
        {arg.view.type === WEEK_VIEW && arg.event.start && arg.event.end && (
          <span className="lf-ev-time">
            {hhmm(arg.event.start)}~{hhmm(arg.event.end)}
          </span>
        )}
        <span className="lf-ev-title">
          {ev.employeeName} · {ev.leaveTypeName}
        </span>
      </div>
    );
  }, []);

  const dayCellClassNames = useCallback(
    (arg: DayCellContentArg) => {
      const date = localToday(arg.date);
      const list = holidayMap.get(date);
      const out: string[] = [];
      const dow = arg.date.getDay();
      if (dow === 0 || dow === 6) out.push("lf-weekend");
      if (list?.some((h) => h.kind === "public")) out.push("lf-holiday");
      else if (list?.length) out.push("lf-closed");
      if (arg.view.type === MONTH_VIEW && monthOf(date) !== month) out.push("lf-other-month");
      const pick = pickClass(date);
      if (pick) out.push(pick);
      return out;
    },
    [picked, holidayMap, month],
  );

  const dayHeaderClassNames = useCallback(
    (arg: DayHeaderContentArg) => {
      const pick = arg.view.type === WEEK_VIEW ? pickClass(localToday(arg.date)) : null;
      return pick ? [pick] : [];
    },
    [picked],
  );

  const renderDayCell = useCallback(
    (arg: DayCellContentArg) => {
      if (arg.view.type !== MONTH_VIEW) return arg.dayNumberText;
      return (
        <div className="lf-day-top">
          <HolidayLabel list={holidayMap.get(localToday(arg.date))} />
          <span className={["lf-day-num", arg.isToday && "is-today"].filter(Boolean).join(" ")}>{dayLabel(arg.date)}</span>
        </div>
      );
    },
    [holidayMap],
  );

  const renderDayHeader = useCallback(
    (arg: DayHeaderContentArg) => {
      const dow = WEEKDAY_LABELS[arg.date.getDay()];
      if (arg.view.type !== WEEK_VIEW) return <span className="lf-dow">{dow}</span>;
      const date = localToday(arg.date);
      const create = () => onCreate({ startDate: date, endDate: date });
      // FullCalendar 가 머리 칸을 <a> 로 감싸므로 버튼 대신 role="button"
      return (
        <div
          className="lf-wk-head"
          role="button"
          tabIndex={0}
          title={`${arg.date.getMonth() + 1}월 ${arg.date.getDate()}일 휴가원 작성`}
          onClick={create}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            create();
          }}
        >
          <span className="lf-dow">{dow}</span>
          <span className={["lf-day-num", arg.isToday && "is-today"].filter(Boolean).join(" ")}>{dayLabel(arg.date)}</span>
          <HolidayLabel list={holidayMap.get(date)} />
        </div>
      );
    },
    [holidayMap, onCreate],
  );

  return (
    <div className="lf-cal-main">
      <div className="lf-cal-header">
        {headerStart}
        <h1 className="lf-cal-title">{title}</h1>
        {eventsQ.isFetching && <span className="spinner lf-cal-spinner" aria-label="불러오는 중" />}
        <span className="spacer" />
        {actions}
        <ViewMenu view={view} onChange={switchView} />
        <Button title="오늘 (T)" onClick={goToday}>
          오늘
        </Button>
        <div className="lf-cal-nav">
          {(
            [
              [-1, "up", view === WEEK_VIEW ? "이전 주" : "이전 달"],
              [1, "down", view === WEEK_VIEW ? "다음 주" : "다음 달"],
            ] as const
          ).map(([dir, icon, label]) => (
            <Button key={dir} variant="ghost" icon title={label} aria-label={label} onClick={() => step(dir)}>
              <ChevronIcon dir={icon} />
            </Button>
          ))}
        </div>
        {headerEnd}
      </div>
      {eventsQ.error && <div className="lf-cal-error">일정을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</div>}
      <div className="lf-cal-body" ref={bodyRef}>
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          locale={koLocale}
          views={{ [MONTH_VIEW]: { type: "dayGrid", duration: { weeks: MONTH_WEEKS } } }}
          initialView={MONTH_VIEW}
          initialDate={initialDate}
          headerToolbar={false}
          firstDay={0}
          height="100%"
          dayMaxEvents
          eventDisplay="block"
          eventOrder="start,title"
          events={events}
          eventContent={renderEvent}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          selectable
          selectMirror={false}
          longPressDelay={300}
          selectLongPressDelay={300}
          select={handleSelect}
          datesSet={handleDatesSet}
          dayCellContent={renderDayCell}
          dayCellClassNames={dayCellClassNames}
          dayHeaderContent={renderDayHeader}
          dayHeaderClassNames={dayHeaderClassNames}
          allDaySlot={false}
          slotMinTime={slots.min}
          slotMaxTime={slots.max}
          slotDuration="00:30:00"
          snapDuration="00:10:00"
          slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
          expandRows
          nowIndicator
        />
      </div>
    </div>
  );
}
