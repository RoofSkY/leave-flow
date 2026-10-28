import type { FastifyInstance } from "fastify";
import { addDays, type AuditAction, type AuditEntity, type AuditLogPage } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { queryAll, queryOne, type Params } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { dateQuery, queryInt, queryStr } from "../lib/http.ts";
import { auditFromRow } from "../services/queries.ts";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// 필터 값 검사용 (타입에 새 값이 생기면 여기서 컴파일 오류가 나도록 Record 로 둠)
const ENTITIES: Record<AuditEntity, true> = {
  leave_request: true,
  overtime_request: true,
  employee: true,
  leave_type: true,
  leave_grant: true,
  opening_balance: true,
  holiday: true,
  department: true,
  category: true,
  settings: true,
  system: true,
};
const ACTIONS: Record<AuditAction, true> = {
  create: true,
  update: true,
  cancel: true,
  restore: true,
  activate: true,
  deactivate: true,
  delete: true,
  print: true,
  accrue: true,
  recalculate: true,
  backup: true,
  restore_backup: true,
  update_app: true,
};

export function registerAuditLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/audit-logs?from=&to=&entity=&employeeId=&action=&page=1&pageSize=50 → AuditLogPage (최근순)
  app.get("/audit-logs", async (req): Promise<AuditLogPage> => {
    const from = dateQuery(req.query, "from");
    const to = dateQuery(req.query, "to");
    const entity = queryStr(req.query, "entity");
    const action = queryStr(req.query, "action");
    const employeeId = queryInt(req.query, "employeeId");
    if (entity !== undefined && !Object.hasOwn(ENTITIES, entity)) throw badRequest("대상 종류 값이 올바르지 않습니다.");
    if (action !== undefined && !Object.hasOwn(ACTIONS, action)) throw badRequest("작업 종류 값이 올바르지 않습니다.");
    const page = Math.max(1, queryInt(req.query, "page") ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, queryInt(req.query, "pageSize") ?? DEFAULT_PAGE_SIZE));

    const where: string[] = [];
    const params: Record<string, string | number> = {};
    // at = "YYYY-MM-DD HH:MM:SS" → 날짜 문자열과 사전순 비교
    if (from) {
      where.push("at >= :from");
      params.from = from;
    }
    if (to) {
      where.push("at < :toNext");
      params.toNext = addDays(to, 1);
    }
    if (entity) {
      where.push("entity = :entity");
      params.entity = entity;
    }
    if (action) {
      where.push("action = :action");
      params.action = action;
    }
    if (employeeId !== undefined) {
      // 시간외근무 신청서는 대상이 여러 명이면 employee_id 가 NULL → 대상으로도 찾는다.
      //  - 현재 대상: 그 신청서의 기록 전체 (새로 들어온 직원도 이전 기록이 보임)
      //  - after.targets: 기록 당시 대상 ({ targets: [{ employeeId, ... }] })
      //  - before.targets: 수정으로 대상에서 빠진 직원의 그 수정 기록
      where.push(`(employee_id = :employeeId OR (entity = 'overtime_request' AND (
        entity_id IN (SELECT overtime_request_id FROM overtime_targets WHERE employee_id = :employeeId)
        OR EXISTS (SELECT 1 FROM json_each(audit_logs.after_json, '$.targets') j WHERE json_extract(j.value, '$.employeeId') = :employeeId)
        OR EXISTS (SELECT 1 FROM json_each(audit_logs.before_json, '$.targets') j WHERE json_extract(j.value, '$.employeeId') = :employeeId))))`);
      params.employeeId = employeeId;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      queryOne<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM audit_logs ${whereSql}`, params as Params)?.n ?? 0,
    );
    const rows = queryAll(
      ctx.db,
      `SELECT * FROM audit_logs ${whereSql} ORDER BY at DESC, id DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit: pageSize, offset: (page - 1) * pageSize },
    ).map(auditFromRow);
    return { rows, total };
  });
}
