import type { FastifyInstance } from "fastify";
import type { UsageReport } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { badRequest } from "../lib/errors.ts";
import { queryInt } from "../lib/http.ts";
import { getEmployeeBalances, listReportEmployees } from "../services/balances.ts";
import { listLeaveTypes } from "../services/queries.ts";

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/usage?year= → UsageReport (활성 직원 + 그 해 기록이 있는 비활성 직원, 활성 휴가 종류)
  app.get("/usage", async (req): Promise<UsageReport> => {
    const year = queryInt(req.query, "year") ?? Number(ctx.today().slice(0, 4));
    if (year < 2000 || year > 2100) throw badRequest("연도 값이 올바르지 않습니다.");

    const employees = listReportEmployees(ctx.db, year);
    return {
      year,
      leaveTypes: listLeaveTypes(ctx.db),
      rows: employees.map((employee) => ({ employee, balances: getEmployeeBalances(ctx.db, employee.id, year, { today: ctx.today() }) })),
    };
  });
}
