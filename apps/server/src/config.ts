import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isTimeString } from "@leave-flow/shared";

// 5000번은 같은 PC의 auto-ansimtalk가 사용하므로 금지
const DEFAULT_PORT = 8080;
const FORBIDDEN_PORTS = new Set([5000]);

export interface Config {
  /** 설치 폴더 (config.json, data/, backups/ 가 있는 곳) */
  homeDir: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  /** 로컬 백업 폴더 */
  backupDir: string;
  /** NAS 백업 폴더 (예: \\NAS주소\backup\leave-flow). 없으면 null */
  nasBackupDir: string | null;
  /** 백업 보관 일수 */
  backupKeepDays: number;
  /** 매일 자동 백업 시각 "HH:MM" */
  backupTime: string;
  /** 빌드된 화면 폴더. 없으면 null (개발 중에는 Vite가 화면을 제공) */
  webDir: string | null;
  /** 자동 업데이트용 공개 GitHub 저장소 "owner/repo". 없으면 업데이트 기능 끔 */
  updateRepo: string | null;
  autoUpdate: boolean;
  /** 업데이트 확인 주기(시간) */
  updateCheckHours: number;
  /** 법정공휴일 자동 등록 범위: 올해 기준 앞뒤 몇 년 */
  holidayYearsBefore: number;
  holidayYearsAfter: number;
  /**
   * API 접속을 허용할 추가 호스트 이름 (소문자, 포트 제외. 예: ["leave.office.lan"]).
   * IP 주소·localhost·이 PC 이름은 항상 허용. 그 밖의 이름으로 접속하면 403 (DNS 리바인딩 차단).
   */
  allowedHosts: string[];
  logger: boolean;
}

/** config.json 에 쓸 수 있는 값 (모두 선택) */
export interface ConfigFile {
  host?: string;
  port?: number;
  dataDir?: string;
  backupDir?: string;
  nasBackupDir?: string | null;
  backupKeepDays?: number;
  backupTime?: string;
  updateRepo?: string | null;
  autoUpdate?: boolean;
  updateCheckHours?: number;
  /** IP 주소·localhost·이 PC 이름 외에 접속을 허용할 호스트 이름 */
  allowedHosts?: string[];
  logger?: boolean;
}

export function readConfigFile(homeDir: string): ConfigFile {
  const file = path.join(homeDir, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as ConfigFile;
  } catch (err) {
    throw new Error(`config.json 을 읽을 수 없습니다: ${(err as Error).message}`);
  }
}

/** 업데이트 확인 주기(시간): 1~576으로 보정, 숫자가 아니면 6 (setInterval 한계 약 596시간) */
function checkUpdateHours(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 6;
  return Math.min(576, Math.max(1, v));
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { webDir?: string | null } = {},
): Config {
  const homeDir = path.resolve(env.LEAVE_FLOW_HOME ?? process.cwd());
  const file = readConfigFile(homeDir);
  const resolve = (p: string) => path.resolve(homeDir, p);

  const port = Number(env.LEAVE_FLOW_PORT ?? file.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`포트 값이 올바르지 않습니다: ${port}`);
  }
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(`${port}번 포트는 auto-ansimtalk가 사용 중이라 쓸 수 없습니다.`);
  }

  const backupTime = file.backupTime ?? "12:30";
  if (!isTimeString(backupTime)) throw new Error(`backupTime 형식이 올바르지 않습니다: ${backupTime}`);

  const dataDir = resolve(env.LEAVE_FLOW_DATA_DIR ?? file.dataDir ?? "data");
  const webDirRaw = env.LEAVE_FLOW_WEB_DIR ?? defaults.webDir ?? null;
  const webDir = webDirRaw && existsSync(path.join(webDirRaw, "index.html")) ? path.resolve(webDirRaw) : null;
  const repo = (file.updateRepo ?? "").trim();

  return {
    homeDir,
    // 사무실 LAN의 다른 PC가 접속해야 하므로 기본은 모든 인터페이스
    host: env.LEAVE_FLOW_HOST ?? file.host ?? "0.0.0.0",
    port,
    dataDir,
    dbPath: path.join(dataDir, "leave-flow.db"),
    backupDir: resolve(file.backupDir ?? "backups"),
    nasBackupDir: file.nasBackupDir?.trim() ? file.nasBackupDir.trim() : null,
    backupKeepDays: file.backupKeepDays ?? 30,
    backupTime,
    webDir,
    updateRepo: /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    autoUpdate: file.autoUpdate ?? true,
    updateCheckHours: checkUpdateHours(file.updateCheckHours),
    holidayYearsBefore: 1,
    holidayYearsAfter: 2,
    allowedHosts: Array.isArray(file.allowedHosts)
      ? file.allowedHosts
          .filter((h): h is string => typeof h === "string")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean)
      : [],
    logger: file.logger ?? true,
  };
}
