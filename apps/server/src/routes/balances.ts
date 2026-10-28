import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { queryInt } from "../lib/http.ts";
import { getEmployeeBalances } from "../services/balances.ts";
import { getEmployee } from "../services/queries.ts";

export function registerBalanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/balances?employeeId=&year=  → BalanceRow[] (활성 휴가 종류, 표시 순서)
  app.get("/balances", async (req) => {
    const employeeId = queryInt(req.query, "employeeId");
    if (!employeeId) throw badRequest("employeeId가 필요합니다.");
    if (!getEmployee(ctx.db, employeeId)) throw notFound("직원을 찾을 수 없습니다.");
    const year = queryInt(req.query, "year") ?? Number(ctx.today().slice(0, 4));
    return getEmployeeBalances(ctx.db, employeeId, year, { today: ctx.today() });
  });
}
