import { calculateLeaveUsage, type LeaveDayUsage, type LeaveUsage, type WorkSchedule } from "@leave-flow/shared";
import { parseJson, queryAll, type Db } from "../db/index.ts";

/** 기간 안의 휴무일 (활성 법정공휴일 + 센터 휴무일) */
export function getClosedDates(db: Db, fromDate: string, toDate: string): Set<string> {
  const rows = queryAll<{ date: string }>(
    db,
    "SELECT DISTINCT date FROM holidays WHERE active = 1 AND date >= ? AND date <= ?",
    [fromDate, toDate],
  );
  return new Set(rows.map((r) => r.date));
}

/** 휴가 항목 사용 시간 계산 (현재 DB의 공휴일·휴무일 반영) */
export function computeItemUsage(
  db: Db,
  startAt: string,
  endAt: string,
  schedule: WorkSchedule,
): LeaveUsage {
  const closed = getClosedDates(db, startAt.slice(0, 10), endAt.slice(0, 10));
  return calculateLeaveUsage(startAt, endAt, schedule, closed);
}

/** 날짜별 사용 → 저장용 JSON {"2026-10-06": 480} (leave_request_items.minutes_by_date) */
export function byDateJson(byDate: readonly LeaveDayUsage[]): string {
  return JSON.stringify(Object.fromEntries(byDate.map((d) => [d.date, d.minutes])));
}

/** 저장된 날짜별 사용 (날짜순). 계산 당시 공휴일 기준이라 지난 휴가의 잔여가 공휴일 변경에 흔들리지 않음 */
export function parseByDate(raw: unknown): LeaveDayUsage[] {
  return Object.entries(parseJson<Record<string, number>>(raw, {}))
    .map(([date, minutes]) => ({ date, minutes }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
