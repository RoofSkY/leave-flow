import {
  formatDotDate,
  formatLeaveMinutes,
  grantBulkInput,
  dayMinutesOf,
  daysHoursToMinutes,
  grantInput,
  leaveTypeAppliesTo,
  type Employee,
  type Grant,
  type GrantInput,
  type LeaveType,
} from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, queryAll, queryOne, transaction } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { clientIp, parseId, parseInput, queryInt } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { getEmployee, getLeaveType, grantFromRow } from "../services/queries.ts";

/** 영구 삭제된 직원의 부여는 휴가현황용으로 숨겨 보관 → 관리 화면에 안 나옴 */
const HIDDEN_EMPLOYEES = "employee_id NOT IN (SELECT id FROM employees WHERE deleted = 1)";

const OVERTIME_LOCK_MESSAGE = "시간외근무 신청서로 적립된 부여는 시간외근무 화면에서 수정하세요.";

function getGrant(ctx: AppContext, id: number): Grant | null {
  const r = queryOne(ctx.db, `SELECT * FROM leave_grants WHERE id = ? AND ${HIDDEN_EMPLOYEES}`, [id]);
  return r ? grantFromRow(r) : null;
}

/** 직접 입력한 부여만 수정·삭제 가능 */
function mustGetManual(ctx: AppContext, id: number): Grant {
  const g = getGrant(ctx, id);
  if (!g) throw notFound("부여 내역을 찾을 수 없습니다.");
  if (g.source === "overtime") throw conflict(OVERTIME_LOCK_MESSAGE);
  return g;
}

/**
 * 입력의 직원·종류 확인. 새로 만들거나 종류를 바꿀 때는 그 직원에게 적용되는 활성 종류여야 함
 * (수정 시 원래 종류가 비활성이거나 대상에서 빠졌어도 그대로 두는 것은 허용).
 */
function resolveRefs(ctx: AppContext, input: GrantInput, keepTypeId: number | null): { employee: Employee; type: LeaveType } {
  const employee = getEmployee(ctx.db, input.employeeId);
  if (!employee) throw badRequest("직원을 찾을 수 없습니다.");
  const type = getLeaveType(ctx.db, input.leaveTypeId);
  if (!type) throw badRequest("휴가 종류를 찾을 수 없습니다.");
  if (!type.active && type.id !== keepTypeId) {
    throw conflict(`비활성화된 휴가 종류(${type.name})에는 부여할 수 없습니다.`);
  }
  if (!leaveTypeAppliesTo(type, employee) && type.id !== keepTypeId) {
    throw badRequest(`${type.name}은(는) ${employee.name}에게 적용되지 않는 휴가 종류입니다.`);
  }
  return { employee, type };
}

/** 그 직원의 1일 기준 부여량 */
const amountText = (g: Grant, employee: Employee) =>
  `${formatLeaveMinutes(g.minutes, dayMinutesOf(employee))}, ${formatDotDate(g.grantDate)}`;

/** 일·시간 → 분 (1일 = 그 직원의 하루 근무시간) */
const grantMinutes = (input: { days: number; hours: number }, employee: Employee) =>
  daysHoursToMinutes(input.days, input.hours, dayMinutesOf(employee));

export function registerGrantRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get("/grants", async (req) => {
    const where: string[] = [HIDDEN_EMPLOYEES];
    const params: (number | string)[] = [];
    const employeeId = queryInt(req.query, "employeeId");
    const leaveTypeId = queryInt(req.query, "leaveTypeId");
    const year = queryInt(req.query, "year");
    if (employeeId !== undefined) {
      where.push("employee_id = ?");
      params.push(employeeId);
    }
    if (leaveTypeId !== undefined) {
      where.push("leave_type_id = ?");
      params.push(leaveTypeId);
    }
    if (year !== undefined) {
      where.push("substr(grant_date, 1, 4) = ?");
      params.push(String(year));
    }
    return queryAll(
      db,
      `SELECT * FROM leave_grants WHERE ${where.join(" AND ")}
       ORDER BY grant_date DESC, id DESC`,
      params,
    ).map(grantFromRow);
  });

  app.post("/grants", async (req, reply) => {
    const input = parseInput(grantInput, req.body);
    const created = transaction(db, () => {
      const { employee, type } = resolveRefs(ctx, input, null);
      const now = ctx.now();
      const id = execute(
        db,
        `INSERT INTO leave_grants (employee_id, leave_type_id, grant_date, minutes, note, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
        [employee.id, type.id, input.grantDate, grantMinutes(input, employee), input.note, now, now],
      ).lastInsertRowid;
      const g = getGrant(ctx, id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_grant",
          entityId: id,
          employeeId: employee.id,
          action: "create",
          summary: `${employee.name} ${type.name} 부여 (${amountText(g, employee)})`,
          after: g,
        },
        now,
      );
      return g;
    });
    return reply.status(201).send(created);
  });

  // 여러 직원에게 같은 부여를 한 번에 (직원마다 부여 내역 1건, 변경 이력도 직원마다)
  app.post("/grants/bulk", async (req, reply) => {
    const input = parseInput(grantBulkInput, req.body);
    const created = transaction(db, () => {
      const now = ctx.now();
      const ip = clientIp(req);
      return input.employeeIds.map((employeeId) => {
        const { employee, type } = resolveRefs(ctx, { ...input, employeeId }, null);
        const id = execute(
          db,
          `INSERT INTO leave_grants (employee_id, leave_type_id, grant_date, minutes, note, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
          [employee.id, type.id, input.grantDate, grantMinutes(input, employee), input.note, now, now],
        ).lastInsertRowid;
        const g = getGrant(ctx, id)!;
        writeAudit(
          db,
          ip,
          {
            entity: "leave_grant",
            entityId: id,
            employeeId: employee.id,
            action: "create",
            summary: `${employee.name} ${type.name} 부여 (${amountText(g, employee)}, ${input.employeeIds.length}명 일괄)`,
            after: g,
          },
          now,
        );
        return g;
      });
    });
    return reply.status(201).send(created);
  });

  app.put("/grants/:id", async (req) => {
    const id = parseId(req.params);
    const input = parseInput(grantInput, req.body);
    return transaction(db, () => {
      const before = mustGetManual(ctx, id);
      // 직원을 바꾸면 원래 직원의 이력에 흔적이 남지 않으므로 휴가원처럼 직원 변경은 막음
      if (input.employeeId !== before.employeeId) throw badRequest("부여 내역의 직원은 바꿀 수 없습니다. 삭제 후 새로 추가하세요.");
      const { employee, type } = resolveRefs(ctx, input, before.leaveTypeId);
      const now = ctx.now();
      execute(
        db,
        `UPDATE leave_grants SET leave_type_id = ?, grant_date = ?, minutes = ?, note = ?, updated_at = ? WHERE id = ?`,
        [type.id, input.grantDate, grantMinutes(input, employee), input.note, now, id],
      );
      const after = getGrant(ctx, id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_grant",
          entityId: id,
          employeeId: before.employeeId,
          action: "update",
          summary: `${employee.name} ${type.name} 부여 수정 (${amountText(before, employee)} → ${amountText(after, employee)})`,
          before,
          after,
        },
        now,
      );
      return after;
    });
  });

  app.delete("/grants/:id", async (req, reply) => {
    const id = parseId(req.params);
    transaction(db, () => {
      const before = mustGetManual(ctx, id);
      const employee = getEmployee(db, before.employeeId)!;
      const type = getLeaveType(db, before.leaveTypeId)!;
      const now = ctx.now();
      execute(db, "DELETE FROM leave_grants WHERE id = ?", [id]);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_grant",
          entityId: id,
          employeeId: before.employeeId,
          action: "delete",
          summary: `${employee.name} ${type.name} 부여 삭제 (${amountText(before, employee)})`,
          before,
        },
        now,
      );
    });
    return reply.status(204).send();
  });
}
