import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createContext } from "./context.ts";
import { openDatabase } from "./db/index.ts";
import { applyPendingRestore, startBackupScheduler } from "./services/backup.ts";
import { startHolidaySync } from "./services/holidays.ts";
import { startUpdateScheduler } from "./services/updater.ts";
import { APP_VERSION } from "./version.ts";

// 배포본: server.mjs 옆의 web/ , 개발: apps/web/dist (빌드한 경우)
const here = path.dirname(fileURLToPath(import.meta.url));
const webCandidates = [path.join(here, "web"), path.resolve(here, "../../web/dist")];
const defaultWebDir = webCandidates.find((d) => existsSync(path.join(d, "index.html"))) ?? null;

const config = loadConfig(process.env, { webDir: defaultWebDir });
const restored = applyPendingRestore(config);
const db = openDatabase(config.dbPath);
const ctx = createContext(db, config, APP_VERSION);

let shuttingDown = false;
const stoppers: (() => void)[] = [];

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const stop of stoppers) {
    try {
      stop();
    } catch {
      // 무시
    }
  }
  try {
    await app.close();
  } catch {
    // 무시
  }
  try {
    db.close();
  } catch {
    // 무시
  }
  process.exit(code);
}

/** 업데이트 적용(75)·백업 복구(76) 등으로 launcher 에 재시작을 요청 */
const requestExit = (code: number) => {
  setTimeout(() => void shutdown(code), 300);
};

const app = await buildApp(ctx, { requestExit });

stoppers.push(startHolidaySync(ctx));
stoppers.push(startBackupScheduler(ctx));
stoppers.push(startUpdateScheduler(ctx, requestExit));

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

await app.listen({ host: config.host, port: config.port });
app.log.info(`leave-flow ${APP_VERSION} 시작: http://${config.host}:${config.port} (데이터: ${config.dataDir})`);
if (restored) app.log.warn("백업 파일로 DB를 복구했습니다.");
