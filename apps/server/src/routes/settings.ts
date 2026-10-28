import { settingsInput } from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { transaction } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { clientIp, parseInput } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { getSettings, saveSettings } from "../services/settings.ts";

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get("/settings", async () => getSettings(db));

  // 보낸 항목만 바꿈 (설정 화면의 섹션별 저장)
  app.put("/settings", async (req) => {
    const input = parseInput(settingsInput, req.body);
    return transaction(db, () => {
      if (input.defaultWorkStart === undefined || input.defaultWorkEnd === undefined) {
        throw badRequest("바꿀 설정이 없습니다.");
      }
      const before = getSettings(db);
      saveSettings(db, input);
      const after = getSettings(db);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "settings",
          action: "update",
          summary: `설정 변경: 근무시간 기본값 ${input.defaultWorkStart}~${input.defaultWorkEnd}`,
          before,
          after,
        },
        ctx.now(),
      );
      return after;
    });
  });
}
