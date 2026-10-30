import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nasBackupDirInput, tableExportInput, type SystemInfo } from "@leave-flow/shared";
import { saveConfigValue } from "../config.ts";
import type { AppContext } from "../context.ts";
import { transaction } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { clientIp, parseInput } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import { checkWritableDir, createBackup, listBackups, prepareRestore } from "../services/backup.ts";
import { buildExportWorkbook, buildTableWorkbook } from "../services/excelExport.ts";
import { SYSTEM_KEYS, getValue, setValue } from "../services/settings.ts";
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

  // 설정 화면에서 NAS 백업 폴더 지정: 써 볼 수 있는지 확인한 뒤 config.json 에 저장, 재시작 없이 바로 적용
  app.put("/system/nas-backup-dir", async (req) => {
    const input = parseInput(nasBackupDirInput, req.body);
    const dir = input.nasBackupDir || null;
    if (dir) {
      const error = await checkWritableDir(dir);
      if (error) {
        throw badRequest(`NAS 백업 폴더에 쓸 수 없습니다: ${error} (주소, 공유폴더 쓰기 권한, 서버 실행 계정을 확인하세요)`);
      }
    }
    const before = ctx.config.nasBackupDir;
    saveConfigValue(ctx.config.homeDir, "nasBackupDir", dir);
    ctx.config.nasBackupDir = dir;
    transaction(ctx.db, () => {
      // 이전 폴더의 복사 실패 기록은 더 이상 맞지 않음
      setValue(ctx.db, SYSTEM_KEYS.lastBackupError, null);
      writeAudit(
        ctx.db,
        clientIp(req),
        {
          entity: "settings",
          action: "update",
          summary: dir ? `설정 변경: NAS 백업 폴더 ${dir}` : "설정 변경: NAS 백업 끔",
          before: { nasBackupDir: before },
          after: { nasBackupDir: dir },
        },
        ctx.now(),
      );
    });
    return { nasBackupDir: dir };
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
