import { deleteInput, employeeInput, type Employee, type EmployeeInput } from "@leave-flow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, fromBool, transaction } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { clientIp, parseId, parseInput, queryBool } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { assertNoDisplayNameOverlap } from "../services/displayNames.ts";
import { deleteEmployee, employeeDeleteCheck } from "../services/purge.ts";
import { getEmployee, listEmployees } from "../services/queries.ts";
import { categoryExists } from "./categories.ts";
import { departmentExists } from "./departments.ts";

const FIELD_LABELS: [keyof EmployeeInput, string][] = [
  ["name", "성명"],
  ["department", "소속"],
  ["color", "색상"],
  ["workDays", "근무 요일"],
  ["workStart", "근무시간"],
  ["workEnd", "근무시간"],
  ["emergencyContact", "비상연락처"],
  ["approvalRoles", "결재칸"],
  ["category", "구분"],
];

/** 바뀐 항목 이름 (변경 이력 요약용) */
function changedLabels(before: Employee, after: Employee): string[] {
  const labels = FIELD_LABELS.filter(([k]) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(
    ([, label]) => label,
  );
  return [...new Set(labels)];
}

function mustGet(ctx: AppContext, id: number): Employee {
  const e = getEmployee(ctx.db, id);
  if (!e) throw notFound("직원을 찾을 수 없습니다.");
  return e;
}

/** 구분은 비우거나 구분 목록(관리 > 설정)에 있는 것이어야 함. 수정 시 원래 구분을 그대로 두는 것은 허용 */
function assertCategory(ctx: AppContext, name: string, keep: string | null): void {
  if (name === "" || name === keep || categoryExists(ctx.db, name)) return;
  throw badRequest(`'${name}' 구분이 구분 목록에 없습니다. 관리 > 설정에서 구분을 먼저 추가하세요.`);
}

/** 소속은 비우거나 소속 목록(관리 > 설정)에 있는 것이어야 함. 수정 시 원래 소속을 그대로 두는 것은 허용 */
function assertDepartment(ctx: AppContext, name: string, keep: string | null): void {
  if (name === "" || name === keep || departmentExists(ctx.db, name)) return;
  throw badRequest(`'${name}' 소속이 소속 목록에 없습니다. 관리 > 설정에서 소속을 먼저 추가하세요.`);
}

export function registerEmployeeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // includeDeleted: 영구 삭제된 직원도 (남은 기록을 소속·구분으로 거를 때)
  app.get("/employees", async (req) =>
    listEmployees(db, {
      includeInactive: queryBool(req.query, "includeInactive"),
      includeDeleted: queryBool(req.query, "includeDeleted"),
    }),
  );

  app.post("/employees", async (req, reply) => {
    const input = parseInput(employeeInput, req.body);
    const created = transaction(db, () => {
      assertDepartment(ctx, input.department, null);
      assertCategory(ctx, input.category, null);
      const now = ctx.now();
      const id = execute(
        db,
        `INSERT INTO employees (name, department, color, work_days, work_start, work_end, emergency_contact,
           approval_roles, category, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.name,
          input.department,
          input.color.toLowerCase(),
          JSON.stringify(input.workDays),
          input.workStart,
          input.workEnd,
          input.emergencyContact,
          JSON.stringify(input.approvalRoles),
          input.category,
          now,
          now,
        ],
      ).lastInsertRowid;
      assertNoDisplayNameOverlap(db);
      const e = mustGet(ctx, id);
      writeAudit(
        db,
        clientIp(req),
        { entity: "employee", entityId: id, employeeId: id, action: "create", summary: `${e.name} 직원 등록`, after: e },
        now,
      );
      return e;
    });
    return reply.status(201).send(created);
  });

  app.put("/employees/:id", async (req) => {
    const id = parseId(req.params);
    const input = parseInput(employeeInput, req.body);
    return transaction(db, () => {
      const before = mustGet(ctx, id);
      assertDepartment(ctx, input.department, before.department);
      assertCategory(ctx, input.category, before.category);
      const now = ctx.now();
      execute(
        db,
        `UPDATE employees SET name = ?, department = ?, color = ?, work_days = ?, work_start = ?, work_end = ?,
           emergency_contact = ?, approval_roles = ?, category = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.name,
          input.department,
          input.color.toLowerCase(),
          JSON.stringify(input.workDays),
          input.workStart,
          input.workEnd,
          input.emergencyContact,
          JSON.stringify(input.approvalRoles),
          input.category,
          now,
          id,
        ],
      );
      // 소속·구분이 바뀌면 같은 표시 이름의 휴가 종류가 겹쳐 적용될 수 있음
      assertNoDisplayNameOverlap(db);
      const after = mustGet(ctx, id);
      const labels = changedLabels(before, after);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "employee",
          entityId: id,
          employeeId: id,
          action: "update",
          summary: `${before.name} 직원 정보 수정${labels.length ? ` (${labels.join(", ")})` : ""}`,
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
        throw conflict(active ? "이미 활성 상태인 직원입니다." : "이미 비활성화된 직원입니다.");
      }
      const now = ctx.now();
      execute(db, "UPDATE employees SET active = ?, updated_at = ? WHERE id = ?", [fromBool(active), now, id]);
      if (active) assertNoDisplayNameOverlap(db);
      const after = mustGet(ctx, id);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "employee",
          entityId: id,
          employeeId: id,
          action: active ? "activate" : "deactivate",
          summary: `${before.name} 직원 ${active ? "활성화" : "비활성화"}`,
          before,
          after,
        },
        now,
      );
      return after;
    });
  };

  // 영구 삭제: 지워지거나 남는 기록 수 확인 → 삭제 (기록이 있으면 이름 확인 + 백업)
  app.get("/employees/:id/delete-check", async (req) => employeeDeleteCheck(db, mustGet(ctx, parseId(req.params))));
  app.post("/employees/:id/delete", async (req, reply) => {
    const id = parseId(req.params);
    const { confirmName } = parseInput(deleteInput, req.body ?? {});
    await deleteEmployee(ctx, clientIp(req), id, confirmName);
    return reply.status(204).send();
  });

  app.post("/employees/:id/deactivate", setActive(false));
  app.post("/employees/:id/activate", setActive(true));
}
