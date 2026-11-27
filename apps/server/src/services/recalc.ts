import { dayMinutesOf, formatPeriod, type RecalcChange } from "@leave-flow/shared";
import { execute, parseJson, queryAll, toNum, transaction, type Db } from "../db/index.ts";
import { writeAudit } from "./audit.ts";
import { byDateJson, itemUsage } from "./leaveUsage.ts";

/**
 * 공휴일·휴무일이 바뀐 뒤, 아직 끝나지 않은 휴가원을 다시 계산.
 * 대상: 종료일(마지막 항목 종료일) ≥ 오늘인 신청 상태 휴가원의 모든 항목 (이미 지난 항목 포함).
 * 신청 시 저장한 근무 요일·근무시간 기준. 바뀐 항목만 저장하고 변경 이력에 기록.
 * @param at 변경 이력 일시 (ctx.now())
 */
export function recalcFutureRequests(
  db: Db,
  today: string,
  ip: string,
  reason: string,
  at: string,
): RecalcChange[] {
  return transaction(db, () => {
    const rows = queryAll(
      db,
      `SELECT i.id, i.request_id, i.start_at, i.end_at, i.minutes, i.minutes_by_year, i.minutes_by_date, i.manual_minutes,
              r.employee_id, r.employee_name, r.work_days, r.work_start, r.work_end,
              t.name AS type_name
         FROM leave_request_items i
         JOIN leave_requests r ON r.id = i.request_id
         JOIN leave_types t ON t.id = i.leave_type_id
        WHERE r.status = 'active'
          AND r.id IN (SELECT request_id FROM leave_request_items
                        GROUP BY request_id HAVING MAX(substr(end_at, 1, 10)) >= ?)
        ORDER BY i.start_at, i.id`,
      [today],
    );
    const changes: RecalcChange[] = [];
    for (const r of rows) {
      const schedule = {
        workDays: parseJson<number[]>(r.work_days, [1, 2, 3, 4, 5]),
        workStart: String(r.work_start),
        workEnd: String(r.work_end),
      };
      // 직접 입력한 항목은 합계는 그대로, 연도별·날짜별만 다시 나눔
      const manual = r.manual_minutes == null ? null : toNum(r.manual_minutes);
      const usage = itemUsage(db, String(r.start_at), String(r.end_at), schedule, manual);
      const before = toNum(r.minutes);
      const beforeByYear = String(r.minutes_by_year);
      const afterByYear = JSON.stringify(usage.byYear);
      const afterByDate = byDateJson(usage.byDate);
      if (usage.minutes === before && afterByYear === beforeByYear) {
        // 직접 입력 항목은 합계가 그대로라 같은 해 안에서는 날짜별 배분만 바뀜 → 사용 시간 변경이 아니므로 목록·이력 없이 저장
        if (afterByDate !== String(r.minutes_by_date)) {
          execute(db, "UPDATE leave_request_items SET minutes_by_date = ? WHERE id = ?", [afterByDate, toNum(r.id)]);
        }
        continue;
      }

      execute(db, "UPDATE leave_request_items SET minutes = ?, minutes_by_year = ?, minutes_by_date = ? WHERE id = ?", [
        usage.minutes,
        afterByYear,
        afterByDate,
        toNum(r.id),
      ]);
      const change: RecalcChange = {
        requestId: toNum(r.request_id),
        itemId: toNum(r.id),
        employeeName: String(r.employee_name),
        dayMinutes: dayMinutesOf(schedule),
        leaveTypeName: String(r.type_name),
        startAt: String(r.start_at),
        endAt: String(r.end_at),
        beforeMinutes: before,
        afterMinutes: usage.minutes,
      };
      changes.push(change);
      writeAudit(db, ip, {
        entity: "leave_request",
        entityId: change.requestId,
        employeeId: toNum(r.employee_id),
        action: "recalculate",
        summary: `${change.employeeName} ${change.leaveTypeName} ${formatPeriod(change.startAt, change.endAt)} 사용 시간 재계산 (${reason})`,
        before: { itemId: change.itemId, minutes: before, minutesByYear: parseJson(beforeByYear, {}) },
        after: { itemId: change.itemId, minutes: usage.minutes, minutesByYear: usage.byYear },
      }, at);
    }
    return changes;
  });
}
