// 화면 표시용 형식 (출력 양식용 형식은 @leave-flow/shared 의 formatPeriod·formatDotDate 사용)
import { WEEKDAY_LABELS, localToday, weekdayOf } from "@leave-flow/shared";

/** "2026-10-01" → "10월 1일 (목)" */
export function formatDateKo(date: string, withYear = false): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const wd = WEEKDAY_LABELS[weekdayOf(date)];
  return `${withYear ? `${y}년 ` : ""}${m}월 ${d}일 (${wd})`;
}

/** "2026-10-01T10:00" → "10월 1일 (목) 10:00" */
function formatDateTimeKo(dateTime: string, withYear = false): string {
  return `${formatDateKo(dateTime.slice(0, 10), withYear)} ${dateTime.slice(11, 16)}`;
}

/** 기간: 같은 날이면 "10월 1일 (목) 10:00~19:00" */
export function formatRangeKo(startAt: string, endAt: string): string {
  if (startAt.slice(0, 10) === endAt.slice(0, 10)) {
    return `${formatDateKo(startAt.slice(0, 10))} ${startAt.slice(11, 16)}~${endAt.slice(11, 16)}`;
  }
  return `${formatDateTimeKo(startAt)} ~ ${formatDateTimeKo(endAt)}`;
}

/** 기록 일시 "2026-10-19 09:00:00" → "2026.10.19 09:00" */
export function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "-";
  return `${ts.slice(0, 4)}.${ts.slice(5, 7)}.${ts.slice(8, 10)} ${ts.slice(11, 16)}`;
}

/** 분 → "2시간 30분" (단위 없이 시간으로) */
export function formatHoursKo(minutes: number): string {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  const sign = minutes < 0 ? "-" : "";
  if (h && m) return `${sign}${h}시간 ${m}분`;
  if (h) return `${sign}${h}시간`;
  return `${sign}${m}분`;
}

export function currentYear(): number {
  return Number(localToday().slice(0, 4));
}

export { localToday };
