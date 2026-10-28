import { deleteInput, leaveTypeInput, type LeaveType, type LeaveTypeTarget } from "@leave-flow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, fromBool, queryOne, transaction } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { clientIp, parseId, parseInput, queryBool } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { assertNoDisplayNameOverlap } from "../services/displayNames.ts";
import { deleteLeaveType, leaveTypeDeleteCheck } from "../services/purge.ts";
import { getLeaveType, listLeaveTypes } from "../services/queries.ts";
import { categoryExists } from "./categories.ts";
import { departmentExists } from "./departments.ts";

const IN_USE_LOCK_MESSAGE = "부여·사용 기록이 있는 휴가 종류는 잔여 방식(소멸일·기간 포함)을 바꿀 수 없습니다.";

function mustGet(ctx: AppContext, id: number): LeaveType {
  const t = getLeaveType(ctx.db, id);
  if (!t) throw notFound("휴가 종류를 찾을 수 없습니다.");
  return t;
}

/** 활성 종류끼리 이름 중복 검사 */
function assertNameFree(ctx: AppContext, name: string, exceptId: number | null): void {
  const dup = queryOne(ctx.db, "SELECT id FROM leave_types WHERE active = 1 AND name = ? AND id <> ?", [
    name,
    exceptId ?? -1,
  ]);
  if (dup) throw conflict(`'${name}' 휴가 종류가 이미 있습니다. 다른 이름을 쓰세요.`);
}

/**
 * 적용 대상 저장 (null = 전체 직원 → 조건·행 모두 비움).
 * 대상을 고를 때는 영구 삭제된 직원의 행(그 직원 휴가원의 휴가현황용)은 그대로 둠.
 */
function saveTargets(ctx: AppContext, leaveTypeId: number, target: LeaveTypeTarget | null): void {
  for (const name of target?.departments ?? []) {
    if (!departmentExists(ctx.db, name)) {
      throw badRequest(`'${name}' 소속이 소속 목록에 없습니다. 관리 > 설정에서 소속을 먼저 추가하세요.`);
    }
  }
  for (const name of target?.categories ?? []) {
    if (!categoryExists(ctx.db, name)) {
      throw badRequest(`'${name}' 구분이 구분 목록에 없습니다. 관리 > 설정에서 구분을 먼저 추가하세요.`);
    }
  }
  execute(ctx.db, "UPDATE leave_types SET target_departments = ?, target_categories = ? WHERE id = ?", [
    JSON.stringify(target?.departments ?? []),
    JSON.stringify(target?.categories ?? []),
    leaveTypeId,
  ]);
  execute(
    ctx.db,
    `DELETE FROM leave_type_employees WHERE leave_type_id = ?
       ${target === null ? "" : "AND employee_id NOT IN (SELECT id FROM employees WHERE deleted = 1)"}`,
    [leaveTypeId],
  );
  for (const employeeId of target?.employeeIds ?? []) {
    if (!queryOne(ctx.db, "SELECT id FROM employees WHERE id = ? AND deleted = 0", [employeeId])) {
      throw badRequest("적용 대상 직원을 찾을 수 없습니다.");
    }
    execute(ctx.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [
      leaveTypeId,
      employeeId,
    ]);
  }
}

export function registerLeaveTypeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get("/leave-types", async (req) => listLeaveTypes(db, { includeInactive: queryBool(req.query, "includeInactive") }));

  app.post("/leave-types", async (req, reply) => {
    const input = parseInput(leaveTypeInput, req.body);
    const created = transaction(db, () => {
      assertNameFree(ctx, input.name, null);
      const now = ctx.now();
      const id = execute(
        db,
        `INSERT INTO leave_types (name, display_name, deducts, balance_mode, expire_month, expire_day, valid_months,
           hide_when_empty, sort_order, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.name,
          input.displayName,
          fromBool(input.deducts),
          input.balanceMode,
          input.expireMonth,
          input.expireDay,
          input.validMonths,
          fromBool(input.hideWhenEmpty),
          input.sortOrder,
          now,
          now,
        ],
      ).lastInsertRowid;
      saveTargets(ctx, id, input.target);
      assertNoDisplayNameOverlap(db);
      const t = mustGet(ctx, id);
      writeAudit(
        db,
        clientIp(req),
        { entity: "leave_type", entityId: id, action: "create", summary: `${t.name} 휴가 종류 추가`, after: t },
        now,
      );
      return t;
    });
    return reply.status(201).send(created);
  });

  app.put("/leave-types/:id", async (req) => {
    const id = parseId(req.params);
    const input = parseInput(leaveTypeInput, req.body);
    return transaction(db, () => {
      const before = mustGet(ctx, id);
      const ruleChanged =
        input.balanceMode !== before.balanceMode ||
        input.expireMonth !== before.expireMonth ||
        input.expireDay !== before.expireDay ||
        input.validMonths !== before.validMonths;
      if (before.inUse && ruleChanged) {
        throw conflict(IN_USE_LOCK_MESSAGE);
      }
      if (before.active) assertNameFree(ctx, input.name, id);
      const now = ctx.now();
      execute(
        db,
        `UPDATE leave_types SET name = ?, display_name = ?, deducts = ?, balance_mode = ?, expire_month = ?, expire_day = ?,
           valid_months = ?, hide_when_empty = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.name,
          input.displayName,
          fromBool(input.deducts),
          input.balanceMode,
          input.expireMonth,
          input.expireDay,
          input.validMonths,
          fromBool(input.hideWhenEmpty),
          input.sortOrder,
          now,
          id,
        ],
      );
      saveTargets(ctx, id, input.target);
      assertNoDisplayNameOverlap(db);
      const after = mustGet(ctx, id);
      const renamed = before.name !== after.name ? ` (이름 → ${after.name})` : "";
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_type",
          entityId: id,
          action: "update",
          summary: `${before.name} 휴가 종류 수정${renamed}`,
          before,
          after,
        },
        now,
      );
      return after;
    });
  });

  const setActive = (active: boolean) => async (req: FastifyRequest) => {
    const id = parseId(req.params);
    return transaction(db, () => {
      const before = mustGet(ctx, id);
      if (before.active === active) {
        throw conflict(active ? "이미 활성 상태인 휴가 종류입니다." : "이미 비활성화된 휴가 종류입니다.");
      }
      if (active) assertNameFree(ctx, before.name, id);
      const now = ctx.now();
      execute(db, "UPDATE leave_types SET active = ?, updated_at = ? WHERE id = ?", [fromBool(active), now, id]);
      if (active) assertNoDisplayNameOverlap(db);
      const after = mustGet(ctx, id);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_type",
          entityId: id,
          action: active ? "activate" : "deactivate",
          summary: `${before.name} 휴가 종류 ${active ? "활성화" : "비활성화"}`,
          before,
          after,
        },
        now,
      );
      return after;
    });
  };

  // 영구 삭제: 지워지거나 남는 기록 수 확인 → 삭제 (기록이 있으면 이름 확인 + 백업)
  app.get("/leave-types/:id/delete-check", async (req) => leaveTypeDeleteCheck(db, mustGet(ctx, parseId(req.params))));
  app.post("/leave-types/:id/delete", async (req, reply) => {
    const id = parseId(req.params);
    const { confirmName } = parseInput(deleteInput, req.body ?? {});
    await deleteLeaveType(ctx, clientIp(req), id, confirmName);
    return reply.status(204).send();
  });

  app.post("/leave-types/:id/deactivate", setActive(false));
  app.post("/leave-types/:id/activate", setActive(true));
}
