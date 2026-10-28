import type { DocStatus, OvertimeKind } from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { badRequest } from "../lib/errors.ts";
import { clientIp, parseId, queryInt, queryStr } from "../lib/http.ts";
import {
  cancelOvertime,
  createOvertime,
  findOvertime,
  listOvertime,
  overtimePrintData,
  printOvertime,
  restoreOvertime,
  updateOvertime,
} from "../services/overtime.ts";

/** 시간외근무 신청서 (일반 / 사회복무요원 특별휴가 / 특별휴가(시상)). 적립 규칙은 services/overtime.ts */
export function registerOvertimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/overtime?kind=general|soldier|award&status=active|cancelled|all&year=
  app.get("/overtime", async (req) => {
    const kind = queryStr(req.query, "kind");
    if (kind !== undefined && kind !== "general" && kind !== "soldier" && kind !== "award") {
      throw badRequest("신청서 종류가 올바르지 않습니다.");
    }
    const status = queryStr(req.query, "status") ?? "active";
    if (status !== "active" && status !== "cancelled" && status !== "all") {
      throw badRequest("상태 값이 올바르지 않습니다.");
    }
    return listOvertime(ctx.db, {
      kind: kind as OvertimeKind | undefined,
      status: status as DocStatus | "all",
      year: queryInt(req.query, "year"),
    });
  });

  app.get("/overtime/:id", async (req) => findOvertime(ctx.db, parseId(req.params)));

  app.post("/overtime", async (req, reply) =>
    reply.status(201).send(createOvertime(ctx, clientIp(req), req.body)),
  );

  app.put("/overtime/:id", async (req) => updateOvertime(ctx, clientIp(req), parseId(req.params), req.body));

  app.post("/overtime/:id/cancel", async (req) => cancelOvertime(ctx, clientIp(req), parseId(req.params)));

  app.post("/overtime/:id/restore", async (req) => restoreOvertime(ctx, clientIp(req), parseId(req.params)));

  // 미리보기: 기록·적립 없음
  app.get("/overtime/:id/print-data", async (req) =>
    overtimePrintData(ctx, findOvertime(ctx.db, parseId(req.params))),
  );

  // 출력 기록 (일반은 첫 출력 때 제출·적립)
  app.post("/overtime/:id/print", async (req) => printOvertime(ctx, clientIp(req), parseId(req.params)));
}
