import { calculateLeaveUsage, type LeaveDayUsage, type LeaveUsage, type WorkSchedule } from "@leave-flow/shared";
import { parseJson, queryAll, type Db } from "../db/index.ts";

/** 기간 안의 휴무일 (활성 법정공휴일 + 센터 휴무일) */
function getClosedDates(db: Db, fromDate: string, toDate: string): Set<string> {
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

/**
 * 직접 입력한 사용 시간으로 바꿈. 날짜별은 계산값 비율로 나누고(합이 정확히 맞게 누적 반올림),
 * 계산값이 0이면 (공휴일만 고른 경우 등) 시작일에 모두 둠. 0이면 날짜별·연도별 없음
 */
export function withManualMinutes(usage: LeaveUsage, manualMinutes: number, startDate: string): LeaveUsage {
  const computed = usage.byDate.reduce((s, d) => s + d.minutes, 0);
  let byDate: LeaveDayUsage[];
  if (manualMinutes === 0) {
    byDate = [];
  } else if (computed === 0) {
    byDate = [{ date: startDate, minutes: manualMinutes }];
  } else {
    let cum = 0;
    let given = 0;
    byDate = usage.byDate
      .map((d) => {
        cum += d.minutes;
        const upTo = Math.round((manualMinutes * cum) / computed);
        const minutes = upTo - given;
        given = upTo;
        return { date: d.date, minutes };
      })
      .filter((d) => d.minutes > 0);
  }
  const byYear: Record<string, number> = {};
  for (const d of byDate) byYear[d.date.slice(0, 4)] = (byYear[d.date.slice(0, 4)] ?? 0) + d.minutes;
  return { minutes: manualMinutes, byYear, byDate };
}

/** 항목 사용 시간: 직접 입력한 값이 있으면 그 값 (manualMinutes = null 이면 계산값) */
export function itemUsage(
  db: Db,
  startAt: string,
  endAt: string,
  schedule: WorkSchedule,
  manualMinutes: number | null | undefined,
): LeaveUsage {
  const usage = computeItemUsage(db, startAt, endAt, schedule);
  return manualMinutes == null ? usage : withManualMinutes(usage, manualMinutes, startAt.slice(0, 10));
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
