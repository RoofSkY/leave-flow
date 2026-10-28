import {
  formatLeaveMinutes,
  dayMinutesOf,
  leaveTypeAppliesTo,
  openingBalanceInput,
  type OpeningBalance,
} from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, queryAll, queryOne, transaction } from "../db/index.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { clientIp, parseId, parseInput, queryInt } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { getEmployee, getLeaveType, openingFromRow } from "../services/queries.ts";

function getOpening(ctx: AppContext, id: number): OpeningBalance | null {
  // 영구 삭제된 직원의 기존 잔여(휴가현황용으로 숨겨 보관)는 없는 것으로
  const r = queryOne(
    ctx.db,
    "SELECT o.* FROM opening_balances o JOIN employees e ON e.id = o.employee_id WHERE o.id = ? AND e.deleted = 0",
    [id],
  );
  return r ? openingFromRow(r) : null;
}

/** "총 15일, 잔여 10일 4시간 → 기존 사용 4일 4시간" (1일 = 그 직원의 하루 근무시간) */
function describe(o: OpeningBalance, dayMinutes: number): string {
  const f = (m: number) => formatLeaveMinutes(m, dayMinutes);
  return `총 ${f(o.totalGrantedMinutes)}, 잔여 ${f(o.remainingMinutes)} → 기존 사용 ${f(o.usedMinutes)}`;
}

export function registerOpeningBalanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get("/opening-balances", async (req) => {
    const where: string[] = ["e.deleted = 0"];
    const params: number[] = [];
    const year = queryInt(req.query, "year");
    const employeeId = queryInt(req.query, "employeeId");
    if (year !== undefined) {
      where.push("o.year = ?");
      params.push(year);
    }
    if (employeeId !== undefined) {
      where.push("o.employee_id = ?");
      params.push(employeeId);
    }
    return queryAll(
      db,
      `SELECT o.* FROM opening_balances o
         JOIN employees e ON e.id = o.employee_id
         JOIN leave_types t ON t.id = o.leave_type_id
       WHERE ${where.join(" AND ")}
       ORDER BY o.year DESC, e.active DESC, e.name, e.id, t.sort_order, t.id`,
      params,
    ).map(openingFromRow);
  });

  // 직원·종류·연도 기준으로 있으면 고치고 없으면 만듦
  app.put("/opening-balances", async (req) => {
    const input = parseInput(openingBalanceInput, req.body);
    return transaction(db, () => {
      const employee = getEmployee(db, input.employeeId);
      if (!employee) throw badRequest("직원을 찾을 수 없습니다.");
      const type = getLeaveType(db, input.leaveTypeId);
      if (!type) throw badRequest("휴가 종류를 찾을 수 없습니다.");
      if (input.remainingMinutes > input.totalGrantedMinutes) {
        throw badRequest("현재 잔여량은 총 부여량보다 클 수 없습니다.");
      }
      const used = input.totalGrantedMinutes - input.remainingMinutes;
      const now = ctx.now();
      const existing = queryOne(
        db,
        "SELECT * FROM opening_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?",
        [employee.id, type.id, input.year],
      );
      const before = existing ? openingFromRow(existing) : null;
      if (!before && !leaveTypeAppliesTo(type, employee)) {
        throw badRequest(`${type.name}은(는) ${employee.name}에게 적용되지 않는 휴가 종류입니다.`);
      }
      let id: number;
      if (before) {
        id = before.id;
        execute(
          db,
          `UPDATE opening_balances SET base_date = ?, total_granted_minutes = ?, remaining_minutes = ?, used_minutes = ?, updated_at = ?
           WHERE id = ?`,
          [input.baseDate, input.totalGrantedMinutes, input.remainingMinutes, used, now, id],
        );
      } else {
        id = execute(
          db,
          `INSERT INTO opening_balances (employee_id, leave_type_id, year, base_date, total_granted_minutes, remaining_minutes,
             used_minutes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [employee.id, type.id, input.year, input.baseDate, input.totalGrantedMinutes, input.remainingMinutes, used, now, now],
        ).lastInsertRowid;
      }
      const after = getOpening(ctx, id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "opening_balance",
          entityId: id,
          employeeId: employee.id,
          action: before ? "update" : "create",
          summary: `${employee.name} ${type.name} ${input.year}년 기존 잔여량 ${before ? "수정" : "입력"} (${describe(after, dayMinutesOf(employee))})`,
          before: before ?? undefined,
          after,
        },
        now,
      );
      return after;
    });
  });

  app.delete("/opening-balances/:id", async (req, reply) => {
    const id = parseId(req.params);
    transaction(db, () => {
      const before = getOpening(ctx, id);
      if (!before) throw notFound("기존 잔여량 기록을 찾을 수 없습니다.");
      const employee = getEmployee(db, before.employeeId)!;
      const type = getLeaveType(db, before.leaveTypeId)!;
      const now = ctx.now();
      execute(db, "DELETE FROM opening_balances WHERE id = ?", [id]);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "opening_balance",
          entityId: id,
          employeeId: before.employeeId,
          action: "delete",
          summary: `${employee.name} ${type.name} ${before.year}년 기존 잔여량 삭제 (${describe(before, dayMinutesOf(employee))})`,
          before,
        },
        now,
      );
    });
    return reply.status(204).send();
  });
}
