import {
  addDays,
  dayMinutesOf,
  startOfWeekMonday,
  type AbsenceRow,
  type Absences,
  type CalendarEvent,
  type WorkSchedule,
} from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { parseJson, queryAll, toNum, type Db, type Row } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { dateQuery, queryBool } from "../lib/http.ts";
import { scheduleOf } from "../services/leaveRequests.ts";
import { parseByDate } from "../services/leaveUsage.ts";
import { typeLabelSql } from "../services/queries.ts";

/** [from, to] 날짜와 기간이 겹치는 휴가원 항목 */
function itemsInRange(db: Db, from: string, to: string, includeCancelled: boolean): Row[] {
  return queryAll(
    db,
    `SELECT i.id AS item_id, i.request_id, i.start_at, i.end_at, i.minutes, i.minutes_by_date,
            r.employee_id, r.employee_name, r.status, r.work_days, r.work_start, r.work_end,
            e.color, e.department, e.category, ${typeLabelSql("t")} AS type_name
       FROM leave_request_items i
       JOIN leave_requests r ON r.id = i.request_id
       JOIN employees e ON e.id = r.employee_id
       JOIN leave_types t ON t.id = i.leave_type_id
      WHERE i.start_at < ? AND i.end_at > ? ${includeCancelled ? "" : "AND r.status = 'active'"}
      ORDER BY i.start_at, r.employee_name, i.id`,
    [addDays(to, 1), from],
  );
}

/** 휴가원에 저장된 신청(수정) 시점 근무 일정 */
function savedSchedule(r: Row): WorkSchedule {
  return scheduleOf({
    workDays: parseJson<number[]>(r.work_days, [1, 2, 3, 4, 5]),
    workStart: String(r.work_start),
    workEnd: String(r.work_end),
  });
}

export function registerCalendarRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // 달력 일정 (휴가원 항목 단위). 주 보기에서 날마다 나눌 때 쓰도록 휴가원에 저장된 근무 일정을 함께
  app.get("/calendar/events", async (req): Promise<CalendarEvent[]> => {
    const from = dateQuery(req.query, "from");
    const to = dateQuery(req.query, "to");
    if (!from || !to) throw badRequest("조회 기간(from, to)을 지정하세요.");
    if (from > to) throw badRequest("조회 시작일은 종료일보다 앞이어야 합니다.");
    return itemsInRange(db, from, to, queryBool(req.query, "includeCancelled")).map(
      (r): CalendarEvent => {
        const schedule = savedSchedule(r);
        return {
          itemId: toNum(r.item_id),
          requestId: toNum(r.request_id),
          employeeId: toNum(r.employee_id),
          employeeName: String(r.employee_name),
          department: String(r.department),
          category: String(r.category),
          color: String(r.color),
          leaveTypeName: String(r.type_name),
          startAt: String(r.start_at),
          endAt: String(r.end_at),
          minutes: toNum(r.minutes),
          status: r.status === "cancelled" ? "cancelled" : "active",
          workDays: [...schedule.workDays],
          workStart: schedule.workStart,
          workEnd: schedule.workEnd,
        };
      },
    );
  });

  // 부재자: today = 그날 사용 시간이 있는 항목(그날 분), week = 그 주 월~일에 사용 시간이 있는 항목(그 주 분).
  // 날짜별 사용은 저장된 값 (잔여·휴가원과 같은 기준)
  app.get("/absences", async (req): Promise<Absences> => {
    const date = dateQuery(req.query, "date") ?? ctx.today();
    const weekStart = startOfWeekMonday(date);
    const weekEnd = addDays(weekStart, 6);
    const today: AbsenceRow[] = [];
    const week: AbsenceRow[] = [];
    for (const r of itemsInRange(db, weekStart, weekEnd, false)) {
      const schedule = savedSchedule(r);
      const byDate = parseByDate(r.minutes_by_date);
      const row = {
        requestId: toNum(r.request_id),
        itemId: toNum(r.item_id),
        employeeId: toNum(r.employee_id),
        employeeName: String(r.employee_name),
        color: String(r.color),
        leaveTypeName: String(r.type_name),
        startAt: String(r.start_at),
        endAt: String(r.end_at),
        dayMinutes: dayMinutesOf(schedule),
      };
      const todayMinutes = byDate.find((d) => d.date === date)?.minutes ?? 0;
      const weekMinutes = byDate
        .filter((d) => d.date >= weekStart && d.date <= weekEnd)
        .reduce((sum, d) => sum + d.minutes, 0);
      if (todayMinutes > 0) today.push({ ...row, minutes: todayMinutes });
      if (weekMinutes > 0) week.push({ ...row, minutes: weekMinutes });
    }
    return { date, weekStart, weekEnd, today, week };
  });
}
