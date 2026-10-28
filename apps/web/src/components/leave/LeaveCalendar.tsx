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
import interactionPlugin from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import {
  WEEKDAY_LABELS,
  addDays,
  formatTime,
  parseTime,
  weekdayOf,
  type CalendarEvent,
  type HolidayKind,
} from "@leave-flow/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../ui/index.tsx";
import { localToday } from "../../lib/format.ts";
import { useEmployees, useHolidays } from "../../lib/queries.ts";
import { filterMatches, type EmployeeFilterValue } from "../form/EmployeeFilter.tsx";
import { shortRange, tint, useCalendarEvents } from "./leaveQueries.ts";
import "./calendar.css";

/** 작성 화면에 미리 채울 기간 */
export interface EditorPrefill {
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
}

type ViewType = "dayGridMonth" | "timeGridWeek";
type HolidayMap = Map<string, { name: string; kind: HolidayKind }[]>;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 해당 날짜가 속한 주의 일요일 */
const startOfWeekSunday = (date: string) => addDays(date, -weekdayOf(date));

/** 월 보기 격자 범위 (일요일 시작, 첫 화면에서 바로 조회하기 위함) */
function monthGrid(today: string): { from: string; to: string } {
  const first = `${today.slice(0, 8)}01`;
  const lastOfMonth = addDays(`${addDays(first, 32).slice(0, 8)}01`, -1);
  return { from: startOfWeekSunday(first), to: addDays(startOfWeekSunday(lastOfMonth), 6) };
}

function viewTitle(start: Date, endExclusive: Date): string {
  const last = new Date(endExclusive.getTime() - 86_400_000);
  const y1 = start.getFullYear();
  const m1 = start.getMonth() + 1;
  const y2 = last.getFullYear();
  const m2 = last.getMonth() + 1;
  if (y1 === y2 && m1 === m2) return `${y1}년 ${m1}월`;
  if (y1 === y2) return `${y1}년 ${m1}월 – ${m2}월`;
  return `${y1}년 ${m1}월 – ${y2}년 ${m2}월`;
}

/**
 * 칸 위 + 버튼. FullCalendar가 누름을 날짜 선택(드래그)으로 받지 않도록 네이티브 이벤트 전파를 막는다.
 */
function AddButton({ label, onAdd }: { label: string; onAdd: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener("mousedown", stop);
    el.addEventListener("touchstart", stop, { passive: true });
    return () => {
      el.removeEventListener("mousedown", stop);
      el.removeEventListener("touchstart", stop);
    };
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className="lf-add"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onAdd();
      }}
    >
      +
    </button>
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

export function LeaveCalendar({
  showCancelled,
  filter,
  onCreate,
  onOpenRequest,
  actions,
}: {
  showCancelled: boolean;
  filter: EmployeeFilterValue;
  onCreate: (prefill: EditorPrefill) => void;
  onOpenRequest: (requestId: number) => void;
  /** 머리 오른쪽에 붙는 버튼들 */
  actions?: ReactNode;
}) {
  const calRef = useRef<FullCalendar>(null);
  const [view, setView] = useState<ViewType>("dayGridMonth");
  const [title, setTitle] = useState(() => {
    const t = localToday();
    return `${t.slice(0, 4)}년 ${Number(t.slice(5, 7))}월`;
  });
  const [range, setRange] = useState(() => monthGrid(localToday()));

  const eventsQ = useCalendarEvents(range.from, range.to);
  const holidaysQ = useHolidays(range.from, range.to);
  const employeesQ = useEmployees(true);

  const api = (): CalendarApi | undefined => calRef.current?.getApi();

  // 공휴일 조회가 실패하면 공휴일 없이 표시
  const holidayMap = useMemo<HolidayMap>(() => {
    const map: HolidayMap = new Map();
    for (const h of holidaysQ.data ?? []) {
      if (!h.active) continue;
      map.set(h.date, [...(map.get(h.date) ?? []), { name: h.name, kind: h.kind }]);
    }
    return map;
  }, [holidaysQ.data]);

  // 월 보기: 여러 날 휴가는 한 줄로 이어서. 주 보기: 날마다 근무시간 안만 (근무하지 않는 날·휴일 제외)
  // 날마다 나눌 때는 직원의 지금 근무 일정이 아니라 휴가원에 저장된 근무 일정(사용 시간 계산 기준)을 씀
  const events = useMemo<EventInput[]>(() => {
    const out: EventInput[] = [];
    for (const e of eventsQ.data ?? []) {
      if (!showCancelled && e.status !== "active") continue;
      if (!filterMatches(filter, { id: e.employeeId, department: e.department, category: e.category })) continue;
      const base = { title: `${e.employeeName} · ${e.leaveTypeName}`, extendedProps: { ev: e } };
      const first = e.startAt.slice(0, 10);
      const last = e.endAt.slice(0, 10);
      if (view !== "timeGridWeek" || first === last) {
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
  }, [eventsQ.data, filter, holidayMap, showCancelled, view]);

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

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    setRange({ from: localToday(arg.start), to: addDays(localToday(arg.end), -1) });
    setView(arg.view.type === "timeGridWeek" ? "timeGridWeek" : "dayGridMonth");
    setTitle(viewTitle(arg.view.currentStart, arg.view.currentEnd));
  }, []);

  const handleSelect = useCallback(
    (arg: DateSelectArg) => {
      arg.view.calendar.unselect();
      const touch = !!arg.jsEvent && "changedTouches" in arg.jsEvent;
      const startDate = localToday(arg.start);
      if (arg.allDay) {
        const endDate = addDays(localToday(arg.end), -1);
        // 한 칸 클릭은 무시 (+ 버튼으로 작성). 드래그한 범위나 터치 길게 누르기만 작성
        if (startDate === endDate && !touch) return;
        onCreate({ startDate, endDate });
        return;
      }
      if (arg.end.getTime() - arg.start.getTime() <= 10 * 60_000 && !touch) return;
      onCreate({ startDate, startTime: hhmm(arg.start), endDate: localToday(arg.end), endTime: hhmm(arg.end) });
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
        {arg.view.type === "timeGridWeek" && arg.event.start && arg.event.end && (
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
      const list = holidayMap.get(localToday(arg.date));
      const out: string[] = [];
      const dow = arg.date.getDay();
      if (dow === 0 || dow === 6) out.push("lf-weekend");
      if (list?.some((h) => h.kind === "public")) out.push("lf-holiday");
      else if (list?.length) out.push("lf-closed");
      return out;
    },
    [holidayMap],
  );

  const renderDayCell = useCallback(
    (arg: DayCellContentArg) => {
      if (arg.view.type !== "dayGridMonth") return arg.dayNumberText;
      const date = localToday(arg.date);
      return (
        <div className="lf-day-top">
          <AddButton
            label={`${arg.date.getMonth() + 1}월 ${arg.date.getDate()}일 휴가원 작성`}
            onAdd={() => onCreate({ startDate: date, endDate: date })}
          />
          <HolidayLabel list={holidayMap.get(date)} />
          <span className={["lf-day-num", arg.isToday && "is-today"].filter(Boolean).join(" ")}>
            {arg.date.getDate()}
          </span>
        </div>
      );
    },
    [holidayMap, onCreate],
  );

  const renderDayHeader = useCallback(
    (arg: DayHeaderContentArg) => {
      const dow = WEEKDAY_LABELS[arg.date.getDay()];
      if (arg.view.type === "dayGridMonth") return <span className="lf-dow">{dow}</span>;
      const date = localToday(arg.date);
      return (
        <div className="lf-wk-head">
          <AddButton
            label={`${arg.date.getMonth() + 1}월 ${arg.date.getDate()}일 휴가원 작성`}
            onAdd={() => onCreate({ startDate: date, endDate: date })}
          />
          <span className="lf-dow">{dow}</span>
          <span className={["lf-day-num", arg.isToday && "is-today"].filter(Boolean).join(" ")}>
            {arg.date.getDate()}
          </span>
          <HolidayLabel list={holidayMap.get(date)} />
        </div>
      );
    },
    [holidayMap, onCreate],
  );

  return (
    <div className="lf-cal-main">
      <div className="lf-cal-header">
        <div className="row" style={{ gap: 4 }}>
          <Button variant="ghost" size="sm" icon title="이전" aria-label="이전" onClick={() => api()?.prev()}>
            ‹
          </Button>
          <Button size="sm" onClick={() => api()?.today()}>
            오늘
          </Button>
          <Button variant="ghost" size="sm" icon title="다음" aria-label="다음" onClick={() => api()?.next()}>
            ›
          </Button>
        </div>
        <h1 className="lf-cal-title">{title}</h1>
        {eventsQ.isFetching && <span className="spinner lf-cal-spinner" aria-label="불러오는 중" />}
        <span className="spacer" />
        <div className="lf-seg" role="group" aria-label="보기">
          {(
            [
              ["dayGridMonth", "월"],
              ["timeGridWeek", "주"],
            ] as const
          ).map(([type, label]) => (
            <button
              key={type}
              type="button"
              aria-pressed={view === type}
              onClick={() => api()?.changeView(type)}
            >
              {label}
            </button>
          ))}
        </div>
        {actions}
      </div>
      {eventsQ.error && <div className="lf-cal-error">일정을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</div>}
      <div className="lf-cal-body">
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          locale={koLocale}
          initialView="dayGridMonth"
          headerToolbar={false}
          firstDay={0}
          height="100%"
          fixedWeekCount={false}
          dayMaxEvents
          eventDisplay="block"
          eventOrder="start,title"
          events={events}
          eventContent={renderEvent}
          eventClick={handleEventClick}
          selectable
          selectMirror={false}
          longPressDelay={300}
          selectLongPressDelay={300}
          select={handleSelect}
          datesSet={handleDatesSet}
          dayCellContent={renderDayCell}
          dayCellClassNames={dayCellClassNames}
          dayHeaderContent={renderDayHeader}
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
