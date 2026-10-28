import type { FastifyInstance } from "fastify";
import {
  formatDotDate,
  holidayInput,
  type Holiday,
  type HolidayChangeResult,
  type HolidayKind,
} from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { execute, queryAll, queryOne, transaction } from "../db/index.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { clientIp, dateQuery, parseId, parseInput, queryBool } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { runHolidaySync } from "../services/holidays.ts";
import { holidayFromRow } from "../services/queries.ts";
import { recalcFutureRequests } from "../services/recalc.ts";

const KIND_LABEL: Record<HolidayKind, string> = { public: "공휴일", center: "센터 휴무일" };

/** 변경 이력·재계산 사유에 쓰는 설명. 예: "센터 휴무일 2026.10.20. 체육대회" */
const holidayLabel = (h: Holiday) => `${KIND_LABEL[h.kind]} ${formatDotDate(h.date)} ${h.name}`;

export function registerHolidayRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const getHoliday = (id: number): Holiday | null => {
    const r = queryOne(db, "SELECT * FROM holidays WHERE id = ?", [id]);
    return r ? holidayFromRow(r) : null;
  };

  const recalc = (ip: string, reason: string) => recalcFutureRequests(db, ctx.today(), ip, reason, ctx.now());

  // GET /api/holidays?from=&to=&includeInactive=1 → Holiday[] (날짜순)
  app.get("/holidays", async (req) => {
    const from = dateQuery(req.query, "from");
    const to = dateQuery(req.query, "to");
    const where: string[] = [];
    const params: string[] = [];
    if (!queryBool(req.query, "includeInactive")) where.push("active = 1");
    if (from) {
      where.push("date >= ?");
      params.push(from);
    }
    if (to) {
      where.push("date <= ?");
      params.push(to);
    }
    return queryAll(
      db,
      `SELECT * FROM holidays ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date, kind DESC, name, id`,
      params,
    ).map(holidayFromRow);
  });

  // POST /api/holidays → 201 HolidayChangeResult. 지워진 같은 자동 등록분이 있으면 되살림
  app.post("/holidays", async (req, reply) => {
    const input = parseInput(holidayInput, req.body);
    const ip = clientIp(req);
    const result = transaction(db, (): HolidayChangeResult => {
      const existing = queryOne(db, "SELECT * FROM holidays WHERE date = ? AND kind = ? AND name = ?", [
        input.date,
        input.kind,
        input.name,
      ]);
      if (existing) {
        const before = holidayFromRow(existing);
        if (before.active) throw conflict(`이미 등록되어 있습니다. (${holidayLabel(before)})`);
        execute(db, "UPDATE holidays SET active = 1 WHERE id = ?", [before.id]);
        const holiday = getHoliday(before.id)!;
        writeAudit(
          db,
          ip,
          {
            entity: "holiday",
            entityId: holiday.id,
            action: "restore",
            summary: `${holidayLabel(holiday)} 추가 (지웠던 자동 등록분 되살림)`,
            before,
            after: holiday,
          },
          ctx.now(),
        );
        return { holiday, recalculated: recalc(ip, `${holidayLabel(holiday)} 추가`) };
      }
      const id = execute(
        db,
        "INSERT INTO holidays (date, name, kind, source, active, created_at) VALUES (?, ?, ?, 'manual', 1, ?)",
        [input.date, input.name, input.kind, ctx.now()],
      ).lastInsertRowid;
      const holiday = getHoliday(id)!;
      writeAudit(
        db,
        ip,
        { entity: "holiday", entityId: id, action: "create", summary: `${holidayLabel(holiday)} 추가`, after: holiday },
        ctx.now(),
      );
      return { holiday, recalculated: recalc(ip, `${holidayLabel(holiday)} 추가`) };
    });
    return reply.status(201).send(result);
  });

  // DELETE /api/holidays/:id → HolidayChangeResult (holiday = null). 수동 등록분은 행 삭제, 자동 등록분은 active = 0
  app.delete("/holidays/:id", async (req): Promise<HolidayChangeResult> => {
    const id = parseId(req.params);
    const ip = clientIp(req);
    return transaction(db, () => {
      const before = getHoliday(id);
      if (!before) throw notFound("공휴일·휴무일을 찾을 수 없습니다.");
      if (!before.active) throw conflict("이미 삭제된 공휴일입니다.");
      if (before.source === "manual") {
        execute(db, "DELETE FROM holidays WHERE id = ?", [id]);
      } else {
        execute(db, "UPDATE holidays SET active = 0 WHERE id = ?", [id]);
      }
      writeAudit(
        db,
        ip,
        {
          entity: "holiday",
          entityId: id,
          action: "delete",
          summary: `${holidayLabel(before)} 삭제`,
          before,
          after: before.source === "manual" ? null : getHoliday(id),
        },
        ctx.now(),
      );
      return { holiday: null, recalculated: recalc(ip, `${holidayLabel(before)} 삭제`) };
    });
  });

  // POST /api/holidays/:id/restore → HolidayChangeResult (지웠던 자동 등록분 되살리기)
  app.post("/holidays/:id/restore", async (req): Promise<HolidayChangeResult> => {
    const id = parseId(req.params);
    const ip = clientIp(req);
    return transaction(db, () => {
      const before = getHoliday(id);
      if (!before) throw notFound("공휴일·휴무일을 찾을 수 없습니다.");
      if (before.active) throw conflict("삭제되지 않은 공휴일입니다.");
      execute(db, "UPDATE holidays SET active = 1 WHERE id = ?", [id]);
      const holiday = getHoliday(id)!;
      writeAudit(
        db,
        ip,
        {
          entity: "holiday",
          entityId: id,
          action: "restore",
          summary: `${holidayLabel(holiday)} 되살리기`,
          before,
          after: holiday,
        },
        ctx.now(),
      );
      return { holiday, recalculated: recalc(ip, `${holidayLabel(holiday)} 되살리기`) };
    });
  });

  // POST /api/holidays/sync → { added, recalculated } (법정공휴일 자동 등록 다시 실행)
  app.post("/holidays/sync", async (req) => runHolidaySync(ctx, clientIp(req)));
}
