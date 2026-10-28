import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tableExportInput, type SystemInfo } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { clientIp, parseInput } from "../lib/http.ts";
import { createBackup, listBackups, prepareRestore } from "../services/backup.ts";
import { buildExportWorkbook, buildTableWorkbook } from "../services/excelExport.ts";
import { SYSTEM_KEYS, getValue } from "../services/settings.ts";
import {
  applyUpdate,
  checkForUpdate,
  readLauncherState,
  recordUpdateOutcome,
} from "../services/updater.ts";

/** 백업 복구 종료 코드 (launcher 가 그냥 재시작) */
const EXIT_RESTORE = 76;

const restoreInput = z.object({
  name: z.string({ error: "복구할 백업을 선택하세요." }).min(1, "복구할 백업을 선택하세요.").max(200),
  location: z.enum(["local", "nas"], { error: "백업 위치가 올바르지 않습니다." }),
});

/**
 * 시스템: 버전·업데이트, 백업·복구, 엑셀 내려받기. docs/api.md "시스템" 참고.
 * requestExit(code): 서버를 종료시켜 launcher 가 재시작하게 함 (업데이트 적용 = 75, 백업 복구 = 76)
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  requestExit: (code: number) => void,
): void {
  const bootId = randomUUID();

  app.get("/system/info", async (): Promise<SystemInfo> => {
    recordUpdateOutcome(ctx);
    const { db, config } = ctx;
    const state = readLauncherState(config.homeDir);
    return {
      version: ctx.version,
      dataDir: config.dataDir,
      port: config.port,
      updateRepo: config.updateRepo,
      autoUpdate: config.autoUpdate && ctx.version !== "dev" && !!config.updateRepo,
      lastUpdateCheckAt: getValue<string | null>(db, SYSTEM_KEYS.lastUpdateCheckAt, null),
      lastUpdatedAt: getValue<string | null>(db, SYSTEM_KEYS.lastUpdatedAt, null),
      latestVersion: getValue<string | null>(db, SYSTEM_KEYS.latestVersion, null),
      lastBackupAt: getValue<string | null>(db, SYSTEM_KEYS.lastBackupAt, null),
      lastBackupError: getValue<string | null>(db, SYSTEM_KEYS.lastBackupError, null),
      nasBackupDir: config.nasBackupDir,
      bootId,
      backupDir: config.backupDir,
      backupTime: config.backupTime,
      backupKeepDays: config.backupKeepDays,
      updateFailure: state?.lastUpdateError ?? null,
    };
  });

  app.post("/system/update/check", async () => checkForUpdate(ctx));

  app.post("/system/update/apply", async (req) => {
    const message = await applyUpdate(ctx, requestExit, { ip: clientIp(req) });
    return { message };
  });

  app.get("/backups", async () => listBackups(ctx.config));

  app.post("/backups", async (req, reply) => {
    const file = await createBackup(ctx, "manual", { ip: clientIp(req) });
    return reply.status(201).send(file);
  });

  app.post("/backups/restore", async (req) => {
    const input = parseInput(restoreInput, req.body);
    await prepareRestore(ctx, input.name, input.location, clientIp(req));
    requestExit(EXIT_RESTORE);
    return { message: "백업으로 복구합니다. 서버가 잠시 재시작됩니다." };
  });

  app.get("/export.xlsx", async (_req, reply) => {
    const buffer = await buildExportWorkbook(ctx.db, ctx.today());
    const filename = `leave-flow-${ctx.today().replaceAll("-", "")}.xlsx`;
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header(
        "Content-Disposition",
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .header("Cache-Control", "no-store")
      .send(buffer);
  });

  // 화면 표(잔여 현황·사용 현황)를 엑셀로: 화면이 보낸 표 그대로 만듦
  app.post("/export/table.xlsx", async (req, reply) => {
    const input = parseInput(tableExportInput, req.body);
    const buffer = await buildTableWorkbook(input);
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header(
        "Content-Disposition",
        `attachment; filename="table.xlsx"; filename*=UTF-8''${encodeURIComponent(`${input.title}.xlsx`)}`,
      )
      .header("Cache-Control", "no-store")
      .send(buffer);
  });
}
