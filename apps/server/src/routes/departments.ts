import { departmentInput, type Department } from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, parseJson, queryAll, queryOne, toNum, transaction, type Db, type Row } from "../db/index.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { clientIp, parseId, parseInput } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";

const SELECT = `SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department = d.name AND e.deleted = 0) AS employee_count
  FROM departments d`;

function departmentFromRow(r: Row): Department {
  return {
    id: toNum(r.id),
    name: String(r.name),
    sortOrder: toNum(r.sort_order),
    employeeCount: toNum(r.employee_count),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** 표시 순서, 이름순 */
export function listDepartments(db: Db): Department[] {
  return queryAll(db, `${SELECT} ORDER BY d.sort_order, d.name`).map(departmentFromRow);
}

function getDepartment(db: Db, id: number): Department | null {
  const r = queryOne(db, `${SELECT} WHERE d.id = ?`, [id]);
  return r ? departmentFromRow(r) : null;
}

/** 소속 목록에 있는 이름인지 (직원 저장 시 검사) */
export function departmentExists(db: Db, name: string): boolean {
  return !!queryOne(db, "SELECT 1 AS x FROM departments WHERE name = ?", [name]);
}

function assertUniqueName(db: Db, name: string, exceptId: number | null): void {
  const dup = queryOne(db, "SELECT id FROM departments WHERE name = ? AND id <> ?", [name, exceptId ?? -1]);
  if (dup) throw conflict(`'${name}' 소속이 이미 있습니다.`);
}

/**
 * 소속: 관리 > 설정에서 추가·수정·삭제.
 * 이름을 바꾸면 그 소속인 직원과 휴가 종류 적용 대상의 소속 이름도 함께 바뀜 (이미 작성한 휴가원은 신청 시점 소속을 그대로 유지).
 */
export function registerDepartmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get("/departments", async () => listDepartments(db));

  app.post("/departments", async (req, reply) => {
    const input = parseInput(departmentInput, req.body);
    const created = transaction(db, () => {
      assertUniqueName(db, input.name, null);
      const now = ctx.now();
      const id = execute(
        db,
        "INSERT INTO departments (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [input.name, input.sortOrder, now, now],
      ).lastInsertRowid;
      const d = getDepartment(db, id)!;
      writeAudit(
        db,
        clientIp(req),
        { entity: "department", entityId: id, action: "create", summary: `소속 추가: ${d.name}`, after: d },
        now,
      );
      return d;
    });
    return reply.status(201).send(created);
  });

  app.put("/departments/:id", async (req) => {
    const id = parseId(req.params);
    const input = parseInput(departmentInput, req.body);
    return transaction(db, () => {
      const before = getDepartment(db, id);
      if (!before) throw notFound("소속을 찾을 수 없습니다.");
      assertUniqueName(db, input.name, id);
      const now = ctx.now();
      execute(db, "UPDATE departments SET name = ?, sort_order = ?, updated_at = ? WHERE id = ?", [
        input.name,
        input.sortOrder,
        now,
        id,
      ]);
      let moved = 0;
      if (input.name !== before.name) {
        moved = execute(db, "UPDATE employees SET department = ?, updated_at = ? WHERE department = ? AND deleted = 0", [
          input.name,
          now,
          before.name,
        ]).changes;
        // 영구 삭제된 직원(소속은 적용 대상 판단용으로 남김)과 휴가 종류 적용 대상의 소속 이름도 함께
        execute(db, "UPDATE employees SET department = ? WHERE department = ? AND deleted = 1", [input.name, before.name]);
        for (const t of queryAll(db, "SELECT id, target_departments FROM leave_types")) {
          const names = parseJson<string[]>(t.target_departments, []);
          if (!names.includes(before.name)) continue;
          execute(db, "UPDATE leave_types SET target_departments = ? WHERE id = ?", [
            JSON.stringify(names.map((n) => (n === before.name ? input.name : n))),
            toNum(t.id),
          ]);
        }
      }
      const after = getDepartment(db, id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "department",
          entityId: id,
          action: "update",
          summary:
            input.name !== before.name
              ? `소속 이름 변경: ${before.name} → ${after.name} (직원 ${moved}명 함께 변경)`
              : `소속 수정: ${after.name}`,
          before,
          after,
        },
        now,
      );
      return after;
    });
  });

  app.delete("/departments/:id", async (req, reply) => {
    const id = parseId(req.params);
    transaction(db, () => {
      const before = getDepartment(db, id);
      if (!before) throw notFound("소속을 찾을 수 없습니다.");
      if (before.employeeCount > 0) {
        throw conflict(
          `'${before.name}' 소속인 직원이 ${before.employeeCount}명 있어 삭제할 수 없습니다. 직원의 소속을 먼저 바꾸세요.`,
        );
      }
      const targeting = queryAll(db, "SELECT name, target_departments FROM leave_types WHERE deleted = 0")
        .filter((t) => parseJson<string[]>(t.target_departments, []).includes(before.name))
        .map((t) => String(t.name));
      if (targeting.length > 0) {
        throw conflict(
          `'${before.name}' 소속을 적용 대상으로 쓰는 휴가 종류(${targeting.join(", ")})가 있어 삭제할 수 없습니다. 휴가 종류의 적용 대상을 먼저 바꾸세요.`,
        );
      }
      execute(db, "DELETE FROM departments WHERE id = ?", [id]);
      writeAudit(
        db,
        clientIp(req),
        { entity: "department", entityId: id, action: "delete", summary: `소속 삭제: ${before.name}`, before },
        ctx.now(),
      );
    });
    return reply.status(204).send();
  });
}
