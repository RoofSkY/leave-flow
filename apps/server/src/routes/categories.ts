import { categoryInput, type Category } from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, fromBool, parseJson, queryAll, queryOne, toBool, toNum, transaction, type Db, type Row } from "../db/index.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { clientIp, parseId, parseInput } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";

const SELECT = `SELECT c.*, (SELECT COUNT(*) FROM employees e WHERE e.category = c.name AND e.deleted = 0) AS employee_count
  FROM categories c`;

function categoryFromRow(r: Row): Category {
  return {
    id: toNum(r.id),
    name: String(r.name),
    socialServiceAgent: toBool(r.social_service_agent),
    sortOrder: toNum(r.sort_order),
    employeeCount: toNum(r.employee_count),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** 표시 순서, 이름순 */
function listCategories(db: Db): Category[] {
  return queryAll(db, `${SELECT} ORDER BY c.sort_order, c.name`).map(categoryFromRow);
}

function getCategory(db: Db, id: number): Category | null {
  const r = queryOne(db, `${SELECT} WHERE c.id = ?`, [id]);
  return r ? categoryFromRow(r) : null;
}

/** 구분 목록에 있는 이름인지 (직원·적용 대상 저장 시 검사) */
export function categoryExists(db: Db, name: string): boolean {
  return !!queryOne(db, "SELECT 1 AS x FROM categories WHERE name = ?", [name]);
}

function assertUniqueName(db: Db, name: string, exceptId: number | null): void {
  const dup = queryOne(db, "SELECT id FROM categories WHERE name = ? AND id <> ?", [name, exceptId ?? -1]);
  if (dup) throw conflict(`'${name}' 구분이 이미 있습니다.`);
}

/** 이 구분을 적용 대상으로 쓰는 휴가 종류 이름 */
function targetingLeaveTypes(db: Db, name: string): string[] {
  return queryAll(db, "SELECT name, target_categories FROM leave_types WHERE deleted = 0")
    .filter((t) => parseJson<string[]>(t.target_categories, []).includes(name))
    .map((t) => String(t.name));
}

/**
 * 구분: 관리 > 설정에서 추가·수정·삭제 (예: 정규직, 계약직, 사회복무요원).
 * 이름을 바꾸면 그 구분인 직원과 휴가 종류 적용 대상의 구분 이름도 함께 바뀜.
 * "사회복무요원 특별휴가 대상"인 구분의 직원만 사회복무요원 특별휴가 신청서 대상으로 고를 수 있음.
 */
export function registerCategoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get("/categories", async () => listCategories(db));

  app.post("/categories", async (req, reply) => {
    const input = parseInput(categoryInput, req.body);
    const created = transaction(db, () => {
      assertUniqueName(db, input.name, null);
      const now = ctx.now();
      const id = execute(
        db,
        "INSERT INTO categories (name, social_service_agent, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [input.name, fromBool(input.socialServiceAgent), input.sortOrder, now, now],
      ).lastInsertRowid;
      const c = getCategory(db, id)!;
      writeAudit(
        db,
        clientIp(req),
        { entity: "category", entityId: id, action: "create", summary: `구분 추가: ${c.name}`, after: c },
        now,
      );
      return c;
    });
    return reply.status(201).send(created);
  });

  app.put("/categories/:id", async (req) => {
    const id = parseId(req.params);
    const input = parseInput(categoryInput, req.body);
    return transaction(db, () => {
      const before = getCategory(db, id);
      if (!before) throw notFound("구분을 찾을 수 없습니다.");
      assertUniqueName(db, input.name, id);
      const now = ctx.now();
      execute(db, "UPDATE categories SET name = ?, social_service_agent = ?, sort_order = ?, updated_at = ? WHERE id = ?", [
        input.name,
        fromBool(input.socialServiceAgent),
        input.sortOrder,
        now,
        id,
      ]);
      let moved = 0;
      if (input.name !== before.name) {
        moved = execute(db, "UPDATE employees SET category = ?, updated_at = ? WHERE category = ? AND deleted = 0", [
          input.name,
          now,
          before.name,
        ]).changes;
        // 영구 삭제된 직원(구분은 적용 대상 판단용으로 남김)과 휴가 종류 적용 대상의 구분 이름도 함께
        execute(db, "UPDATE employees SET category = ? WHERE category = ? AND deleted = 1", [input.name, before.name]);
        for (const t of queryAll(db, "SELECT id, target_categories FROM leave_types")) {
          const names = parseJson<string[]>(t.target_categories, []);
          if (!names.includes(before.name)) continue;
          execute(db, "UPDATE leave_types SET target_categories = ? WHERE id = ?", [
            JSON.stringify(names.map((n) => (n === before.name ? input.name : n))),
            toNum(t.id),
          ]);
        }
      }
      const after = getCategory(db, id)!;
      const changes = [
        input.name !== before.name ? `이름 ${before.name} → ${after.name} (직원 ${moved}명 함께 변경)` : "",
        before.socialServiceAgent !== after.socialServiceAgent
          ? `사회복무요원 특별휴가 대상 ${after.socialServiceAgent ? "켬" : "끔"}`
          : "",
      ].filter(Boolean);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "category",
          entityId: id,
          action: "update",
          summary: `구분 수정: ${after.name}${changes.length ? ` (${changes.join(", ")})` : ""}`,
          before,
          after,
        },
        now,
      );
      return after;
    });
  });

  app.delete("/categories/:id", async (req, reply) => {
    const id = parseId(req.params);
    transaction(db, () => {
      const before = getCategory(db, id);
      if (!before) throw notFound("구분을 찾을 수 없습니다.");
      if (before.employeeCount > 0) {
        throw conflict(
          `'${before.name}' 구분인 직원이 ${before.employeeCount}명 있어 삭제할 수 없습니다. 직원의 구분을 먼저 바꾸세요.`,
        );
      }
      const targeting = targetingLeaveTypes(db, before.name);
      if (targeting.length > 0) {
        throw conflict(
          `'${before.name}' 구분을 적용 대상으로 쓰는 휴가 종류(${targeting.join(", ")})가 있어 삭제할 수 없습니다. 휴가 종류의 적용 대상을 먼저 바꾸세요.`,
        );
      }
      execute(db, "DELETE FROM categories WHERE id = ?", [id]);
      writeAudit(
        db,
        clientIp(req),
        { entity: "category", entityId: id, action: "delete", summary: `구분 삭제: ${before.name}`, before },
        ctx.now(),
      );
    });
    return reply.status(204).send();
  });
}
