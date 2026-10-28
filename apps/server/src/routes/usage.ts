import type { FastifyInstance } from "fastify";
import type { UsageReport } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { queryOne } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { queryInt } from "../lib/http.ts";
import { getEmployeeBalances } from "../services/balances.ts";
import { listEmployees, listLeaveTypes } from "../services/queries.ts";

/** 그 해 부여·기존 잔여·사용(신청 상태 휴가원) 기록이 있는지 */
const HAS_RECORDS_IN_YEAR = `SELECT (
  EXISTS (SELECT 1 FROM leave_grants WHERE employee_id = :id AND substr(grant_date, 1, 4) = :year)
  OR EXISTS (SELECT 1 FROM opening_balances WHERE employee_id = :id AND year = :yearNum)
  OR EXISTS (
    SELECT 1 FROM leave_request_items i JOIN leave_requests r ON r.id = i.request_id
     WHERE r.employee_id = :id AND r.status = 'active' AND json_extract(i.minutes_by_year, :path) > 0
  )
) AS has_records`;

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/usage?year= → UsageReport (활성 직원 + 그 해 기록이 있는 비활성 직원, 활성 휴가 종류)
  app.get("/usage", async (req): Promise<UsageReport> => {
    const year = queryInt(req.query, "year") ?? Number(ctx.today().slice(0, 4));
    if (year < 2000 || year > 2100) throw badRequest("연도 값이 올바르지 않습니다.");

    const employees = listEmployees(ctx.db, { includeInactive: true }).filter(
      (e) =>
        e.active ||
        queryOne<{ has_records: number }>(ctx.db, HAS_RECORDS_IN_YEAR, {
          id: e.id,
          year: String(year),
          yearNum: year,
          path: `$."${year}"`,
        })?.has_records === 1,
    );
    return {
      year,
      leaveTypes: listLeaveTypes(ctx.db),
      rows: employees.map((employee) => ({ employee, balances: getEmployeeBalances(ctx.db, employee.id, year, { today: ctx.today() }) })),
    };
  });
}
