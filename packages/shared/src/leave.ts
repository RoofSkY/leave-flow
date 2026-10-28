import {
  LEAVE_DAY_MINUTES,
  LEAVE_STEP_MINUTES,
  LUNCH,
  YEAR_RANGE_MESSAGE,
  dateToDayNumber,
  dayNumberToDate,
  formatTime,
  isInYearRange,
  overlap,
  parseDateTime,
  parseTime,
  weekdayOf,
} from "./time.ts";
import type { Employee, LeaveRequest, LeaveTypeTarget } from "./types.ts";

/** 휴가원 결재칸 (직원마다 골라 씀, 양식에는 이 순서로 나옴) */
export const APPROVAL_ROLES = ["담당", "팀장", "센터장", "대표"] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];
/** 결재칸 기본값 (새 직원, 2026 휴가원 양식) */
export const DEFAULT_APPROVAL_ROLES: ApprovalRole[] = ["담당", "센터장"];

/** 휴가 항목 하나의 최대 기간(일). 더 긴 휴가는 항목을 나눠 입력 */
export const MAX_LEAVE_SPAN_DAYS = 366;

/** 직원 근무 일정. 신청 시점 값을 휴가원에 그대로 저장해 재계산에 사용한다. */
export interface WorkSchedule {
  /** 근무 요일 (0=일 … 6=토) */
  workDays: readonly number[];
  /** "HH:MM" */
  workStart: string;
  /** "HH:MM" */
  workEnd: string;
}

export interface LeaveDayUsage {
  date: string;
  minutes: number;
}

export interface LeaveUsage {
  /** 총 사용 시간(분) */
  minutes: number;
  /** 연도별 사용 시간(분). 연도를 넘는 휴가를 연도별 잔여에 나눠 반영하기 위함 */
  byYear: Record<string, number>;
  /** 실제로 차감되는 날짜별 시간 (0분인 날은 제외) */
  byDate: LeaveDayUsage[];
}

/** 하루 근무시간(분, 점심 제외) */
export function dailyWorkMinutes(schedule: Pick<WorkSchedule, "workStart" | "workEnd">): number {
  const start = parseTime(schedule.workStart);
  const end = parseTime(schedule.workEnd);
  return end - start - overlap(start, end, LUNCH.start, LUNCH.end);
}

/** 휴가 종류의 보이는 이름: 표시 이름 (없으면 관리 이름) */
export function leaveTypeLabel(t: { name: string; displayName: string }): string {
  return t.displayName || t.name;
}

/**
 * 한 목록 안의 보이는 이름. 보이는 이름이 겹치는 종류끼리는 관리 이름으로 구별
 * (예: 구분이 바뀐 직원의 "연차(직원)"·"연차(강사)" 기록이 한 화면에 함께 나올 때).
 */
export function distinctLeaveTypeLabels<T extends { name: string; displayName: string }>(
  list: readonly T[],
): (t: T) => string {
  const counts = new Map<string, number>();
  for (const t of list) counts.set(leaveTypeLabel(t), (counts.get(leaveTypeLabel(t)) ?? 0) + 1);
  return (t) => ((counts.get(leaveTypeLabel(t)) ?? 0) > 1 ? t.name : leaveTypeLabel(t));
}

/**
 * 그 휴가 종류가 그 직원에게 적용되는지. 적용 대상을 정하지 않았으면 전체 직원.
 * 정했으면: 따로 고른 직원이거나, 소속·구분 조건에 맞으면 적용.
 * 소속·구분 조건은 고른 칸끼리 모두 맞아야 함 (예: 아동사업부 + 직원 → 아동사업부의 직원만).
 * 한 칸 안에서 여러 개를 고르면 그중 하나만 맞으면 됨 (예: 아동사업부·가족사업부 → 두 소속 모두).
 */
export function leaveTypeAppliesTo(
  type: { target: LeaveTypeTarget | null },
  employee: Pick<Employee, "id" | "department" | "category">,
): boolean {
  const t = type.target;
  if (t === null) return true;
  if (t.employeeIds.includes(employee.id)) return true;
  if (t.departments.length === 0 && t.categories.length === 0) return false;
  const departmentOk = t.departments.length === 0 || t.departments.includes(employee.department);
  const categoryOk = t.categories.length === 0 || t.categories.includes(employee.category);
  return departmentOk && categoryOk;
}

/**
 * 그 직원의 "1일"(분) = 하루 근무시간(점심 제외). 휴가 양을 일로 나타낼 때 쓴다.
 * 근무시간을 알 수 없거나 0 이하면 8시간.
 */
export function dayMinutesOf(schedule: Pick<WorkSchedule, "workStart" | "workEnd"> | null | undefined): number {
  if (!schedule) return LEAVE_DAY_MINUTES;
  const m = dailyWorkMinutes(schedule);
  return Number.isFinite(m) && m > 0 ? m : LEAVE_DAY_MINUTES;
}

/**
 * 휴가 사용 시간 계산.
 * 날짜별로 근무 요일·근무시간 안의 시간만 합산하고, 근무 요일이 아닌 날·공휴일·휴무일·점심시간은 제외한다.
 * @param closedDates 법정공휴일 + 센터 휴무일 ("YYYY-MM-DD")
 */
export function calculateLeaveUsage(
  start: string,
  end: string,
  schedule: WorkSchedule,
  closedDates: ReadonlySet<string>,
): LeaveUsage {
  const s = parseDateTime(start);
  const e = parseDateTime(end);
  const firstDay = dateToDayNumber(s.date);
  const lastDay = dateToDayNumber(e.date);
  if (lastDay < firstDay || (lastDay === firstDay && e.minutes <= s.minutes)) {
    throw new Error("종료일시는 시작일시보다 뒤여야 합니다.");
  }

  const workStart = parseTime(schedule.workStart);
  const workEnd = parseTime(schedule.workEnd);
  const workDays = new Set(schedule.workDays);

  const byDate: LeaveDayUsage[] = [];
  const byYear: Record<string, number> = {};
  let total = 0;

  for (let day = firstDay; day <= lastDay; day++) {
    const date = dayNumberToDate(day);
    if (!workDays.has(weekdayOf(date)) || closedDates.has(date)) continue;

    const from = Math.max(workStart, day === firstDay ? s.minutes : 0);
    const to = Math.min(workEnd, day === lastDay ? e.minutes : 24 * 60);
    if (to <= from) continue;

    const minutes = to - from - overlap(from, to, LUNCH.start, LUNCH.end);
    if (minutes <= 0) continue;

    byDate.push({ date, minutes });
    const year = date.slice(0, 4);
    byYear[year] = (byYear[year] ?? 0) + minutes;
    total += minutes;
  }

  return { minutes: total, byYear, byDate };
}

/** 점심시간을 건너뛰며 from에서 amount분 근무한 뒤의 시각 */
function addWorkingMinutes(from: number, amount: number): number {
  if (from < LUNCH.start) {
    const beforeLunch = LUNCH.start - from;
    if (amount <= beforeLunch) return from + amount;
    return LUNCH.end + (amount - beforeLunch);
  }
  return Math.max(from, LUNCH.end) + amount;
}

/** 반차 경계 시각(분). 근무시간(점심 제외)의 절반 지점 */
export function halfDayMidpoint(schedule: WorkSchedule): number {
  return addWorkingMinutes(
    parseTime(schedule.workStart),
    Math.round(dailyWorkMinutes(schedule) / 2),
  );
}

export type QuickRange = "full" | "am" | "pm";

/**
 * 빠른 선택(종일/오전/오후)의 시작·종료 시각.
 * 반차는 무조건 근무시간(점심 제외)의 절반이며, 오전 = 출근 ~ 절반 지점, 오후 = 절반 지점 ~ 퇴근.
 */
export function quickRangeTimes(
  schedule: WorkSchedule,
  range: QuickRange,
): { start: string; end: string } {
  if (range === "full") return { start: schedule.workStart, end: schedule.workEnd };
  const mid = formatTime(halfDayMidpoint(schedule));
  return range === "am"
    ? { start: schedule.workStart, end: mid }
    : { start: mid, end: schedule.workEnd };
}

/**
 * 휴가 입력 시각(분)으로 허용되는지.
 * 10분 단위이거나, 반차 경계 시각(근무시간에 따라 10분 단위가 아닐 수 있음)이면 허용.
 */
export function isAllowedLeaveMinute(minutes: number, schedule: WorkSchedule): boolean {
  return minutes % LEAVE_STEP_MINUTES === 0 || minutes === halfDayMidpoint(schedule);
}

/**
 * 휴가 시작/종료 시각으로 고를 수 있는 시각 목록 (근무시간 안, 10분 단위 + 반차 경계).
 * 화면의 시각 선택 목록에 사용.
 */
export function selectableLeaveTimes(schedule: WorkSchedule): string[] {
  const start = parseTime(schedule.workStart);
  const end = parseTime(schedule.workEnd);
  const set = new Set<number>();
  for (let m = Math.ceil(start / LEAVE_STEP_MINUTES) * LEAVE_STEP_MINUTES; m <= end; m += LEAVE_STEP_MINUTES) {
    set.add(m);
  }
  set.add(start);
  set.add(end);
  set.add(halfDayMidpoint(schedule));
  return [...set].sort((a, b) => a - b).map(formatTime);
}

/**
 * 휴가 항목 일시가 직원 근무 일정에 맞는지 검사. 문제가 없으면 null, 있으면 한국어 오류 메시지.
 * (연도가 입력 범위 안이고 기간이 1년 이내이며, 시작·종료 날짜가 근무 요일이고, 시각이 근무시간 안이며, 허용된 단위인지)
 */
export function validateLeaveRange(
  startAt: string,
  endAt: string,
  schedule: WorkSchedule,
): string | null {
  let s: { date: string; minutes: number };
  let e: { date: string; minutes: number };
  try {
    s = parseDateTime(startAt);
    e = parseDateTime(endAt);
  } catch {
    return "일시 형식이 올바르지 않습니다.";
  }
  if (`${e.date}T${formatTime(e.minutes)}` <= `${s.date}T${formatTime(s.minutes)}`) {
    return "종료일시는 시작일시보다 뒤여야 합니다.";
  }
  if (!isInYearRange(s.date) || !isInYearRange(e.date)) return YEAR_RANGE_MESSAGE;
  if (dateToDayNumber(e.date) - dateToDayNumber(s.date) > MAX_LEAVE_SPAN_DAYS) {
    return `휴가 기간은 1년(${MAX_LEAVE_SPAN_DAYS}일) 이내로 입력하세요. 더 긴 휴가는 항목을 나눠 입력하세요.`;
  }
  const workDays = new Set(schedule.workDays);
  if (!workDays.has(weekdayOf(s.date))) return "시작일이 근무 요일이 아닙니다.";
  if (!workDays.has(weekdayOf(e.date))) return "종료일이 근무 요일이 아닙니다.";
  const ws = parseTime(schedule.workStart);
  const we = parseTime(schedule.workEnd);
  if (s.minutes < ws || s.minutes > we) return "시작 시각이 근무시간 밖입니다.";
  if (e.minutes < ws || e.minutes > we) return "종료 시각이 근무시간 밖입니다.";
  if (!isAllowedLeaveMinute(s.minutes, schedule) || !isAllowedLeaveMinute(e.minutes, schedule)) {
    return "휴가는 10분 단위로 입력해야 합니다.";
  }
  return null;
}

/** 분 → { 일, 시간, 분 } (1일 = dayMinutes, 그 직원의 하루 근무시간) */
export function splitLeaveMinutes(minutes: number, dayMinutes: number): { days: number; hours: number; minutes: number } {
  const perDay = dayMinutes > 0 ? dayMinutes : LEAVE_DAY_MINUTES;
  const days = Math.floor(minutes / perDay);
  const rest = minutes - days * perDay;
  return { days, hours: Math.floor(rest / 60), minutes: rest % 60 };
}

/**
 * 분 → 표시 문자열. 1일 = dayMinutes (그 직원의 하루 근무시간).
 * 0인 부분은 빼고 "12일 10분", "2시간 30분", 전부 0이면 "0일".
 */
export function formatLeaveMinutes(minutes: number, dayMinutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const p = splitLeaveMinutes(Math.abs(minutes), dayMinutes);
  const parts = [p.days && `${p.days}일`, p.hours && `${p.hours}시간`, p.minutes && `${p.minutes}분`].filter(Boolean);
  return parts.length ? `${sign}${parts.join(" ")}` : "0일";
}

/** 분 → "2시간 30분" (일로 묶지 않음. 여러 직원에게 같은 시간을 적립하는 일반 시간외근무용). 0이면 "0시간" */
export function formatHoursMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const rest = Math.abs(minutes);
  const h = Math.floor(rest / 60);
  const m = rest % 60;
  const parts = [h && `${h}시간`, m && `${m}분`].filter(Boolean);
  return parts.length ? `${sign}${parts.join(" ")}` : "0시간";
}

/** 일·시간 → 분 (1일 = dayMinutes) */
export function daysHoursToMinutes(days: number, hours: number, dayMinutes: number): number {
  return Math.round(days * dayMinutes + hours * 60);
}

/**
 * 출력한 뒤에 휴가원을 수정하거나 복구해서 출력한 종이(서명본)와 내용이 다를 수 있음 → 다시 출력해야 함.
 * 공휴일·휴무일 변경에 따른 자동 재계산은 수정 일시를 바꾸지 않으므로 여기에 들지 않음
 */
export function needsReprint(r: Pick<LeaveRequest, "status" | "lastPrintedAt" | "updatedAt">): boolean {
  return r.status === "active" && r.lastPrintedAt !== null && r.updatedAt > r.lastPrintedAt;
}
