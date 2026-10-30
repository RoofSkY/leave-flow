// GitHub Releases 자동 업데이트. 새 버전을 versions/<버전>/ 에 풀고 state.json 의 pending 을 기록한 뒤
// 종료 코드 75로 끝내면 launcher 가 새 버전으로 바꿔 띄우고, 정상 기동하지 않으면 되돌린다.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { UpdateCheckResult } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { transaction } from "../db/index.ts";
import { ApiError, conflict } from "../lib/errors.ts";
import { writeAudit } from "./audit.ts";
import { createBackup } from "./backup.ts";
import { SYSTEM_KEYS, getValue, setValue } from "./settings.ts";

/** launcher 와 같은 형식 (launcher/state.mjs) */
interface LauncherState {
  current: string;
  previous: string | null;
  pending: string | null;
  /** 새 버전 시험 기동 중 (정상 확인 전) */
  trial?: boolean;
  /** 정상 기동하지 않아 되돌린 버전 → 자동 업데이트에서 건너뜀 */
  failedVersion?: string | null;
  lastUpdateError?: { version: string; at: string; message: string } | null;
  /** 새 버전으로 바뀐 일시 (launcher 가 기록) */
  updatedAt?: string | null;
  /** 업데이트 직전 DB 백업 (되돌릴 때 launcher 가 복구) */
  preUpdateBackup?: string | null;
}

interface ReleaseInfo {
  version: string;
  zipUrl: string | null;
  shaUrl: string | null;
}

/** 업데이트 종료 코드 (launcher 와 약속) */
export const EXIT_UPDATE = 75;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const FIRST_CHECK_DELAY_MS = 2 * 60_000;
/** launcher 가 새 버전을 확정(60초 시험)한 뒤 업데이트 결과를 기록 */
const RECORD_DELAY_MS = 90_000;
/** 업데이트가 끝난 버전 (lastUpdatedAt 을 버전마다 한 번만 기록) */
const UPDATED_VERSION_KEY = "system.lastUpdatedVersion";
/** 이미 변경 이력에 남긴 되돌림 */
const ROLLBACK_NOTED_KEY = "system.lastRollbackNoted";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "v1.2.3" 처럼 앞의 v 는 무시. 시험판(-rc.1)은 정식판보다 낮음 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/i, "");
    const dash = s.indexOf("-");
    const core = dash < 0 ? s : s.slice(0, dash);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: dash < 0 ? null : s.slice(dash + 1) };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 업데이트를 쓸 수 없는 이유 (쓸 수 있으면 null) */
function updatesDisabledReason(ctx: AppContext): string | null {
  if (ctx.version === "dev") return "개발 실행 중에는 업데이트 기능을 사용할 수 없습니다.";
  if (!ctx.config.updateRepo) {
    return "config.json에 업데이트 저장소(updateRepo)가 설정되어 있지 않아 업데이트 기능이 꺼져 있습니다.";
  }
  return null;
}

/* ---------- state.json ---------- */

export function readLauncherState(homeDir: string): LauncherState | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(homeDir, "state.json"), "utf8").replace(/^﻿/, "")) as unknown;
    if (!raw || typeof raw !== "object" || typeof (raw as LauncherState).current !== "string") return null;
    return raw as LauncherState;
  } catch {
    return null;
  }
}

/** Windows 에서 다른 프로세스(launcher·백신·검색 색인)가 대상 파일을 잠깐 열고 있으면 나는 오류 */
const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 30;

/**
 * renameSync + 잠깐 열린 파일이면 다시 시도 (모두 약 5초, launcher/state.mjs 와 같은 규칙).
 * Windows 는 다른 프로세스가 읽는 중인 파일 위로 바꿔 끼우지 못하고 EPERM 을 냄.
 */
function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= RENAME_RETRIES || !SHARING_ERRORS.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25 * (i + 1), 200));
    }
  }
}

/** 임시 파일에 쓴 뒤 바꿔 끼움 (쓰는 도중 꺼져도 state.json 이 깨지지 않게) */
export function writeLauncherState(homeDir: string, state: LauncherState): void {
  const file = path.join(homeDir, "state.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameWithRetry(tmp, file);
}

/* ---------- GitHub ---------- */

function userAgent(ctx: AppContext): string {
  return `leave-flow/${ctx.version}`;
}

/** 최신 릴리스 (없으면 null) */
async function fetchLatestRelease(ctx: AppContext): Promise<ReleaseInfo | null> {
  const res = await fetch(`https://api.github.com/repos/${ctx.config.updateRepo}/releases/latest`, {
    headers: { "User-Agent": userAgent(ctx), Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; assets?: { name?: string; browser_download_url?: string }[] };
  const version = String(body.tag_name ?? "").replace(/^v/i, "");
  if (!VERSION_RE.test(version)) throw new Error(`알 수 없는 버전 형식: ${body.tag_name}`);
  const asset = (name: string) => body.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
  return {
    version,
    zipUrl: asset(`leave-flow-${version}.zip`),
    shaUrl: asset(`leave-flow-${version}.zip.sha256`),
  };
}

async function getLatestRelease(ctx: AppContext): Promise<ReleaseInfo | null> {
  try {
    return await fetchLatestRelease(ctx);
  } catch (err) {
    throw new ApiError(502, `업데이트 정보를 가져오지 못했습니다. 인터넷 연결을 확인하세요. (${errText(err)})`);
  }
}

async function download(ctx: AppContext, url: string, timeoutMs: number): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(ctx) },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** sha256 파일 내용: "<hex>  <파일 이름>" 또는 hex 만 */
export function parseSha256(text: string): string | null {
  return /\b([a-f0-9]{64})\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

/* ---------- 압축 해제 ---------- */

/** zip 안의 경로를 안전한 상대 경로로. 절대 경로·드라이브 문자·".."·":" 가 있으면 null */
export function safeEntryPath(name: string): string | null {
  const n = name.replaceAll("\\", "/");
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === ".." || p.includes(":"))) return null;
  return parts.join("/");
}

/** 릴리스 zip 을 targetDir 에 풀기. 잘못된 경로가 하나라도 있으면 아무것도 쓰지 않고 실패 */
export function extractRelease(zip: Uint8Array, targetDir: string): void {
  const files = unzipSync(zip);
  const entries: [string, Uint8Array][] = [];
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/") && data.length === 0) continue;
    const rel = safeEntryPath(name);
    if (!rel) throw new Error(`업데이트 파일에 올바르지 않은 경로가 있습니다: ${name}`);
    entries.push([rel, data]);
  }
  if (!entries.some(([rel]) => rel === "server.mjs")) throw new Error("업데이트 파일에 server.mjs가 없습니다.");

  const partial = `${targetDir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  for (const [rel, data] of entries) {
    const file = path.join(partial, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(partial, targetDir);
}

/* ---------- 확인·적용 ---------- */

export async function checkForUpdate(ctx: AppContext): Promise<UpdateCheckResult> {
  const disabled = updatesDisabledReason(ctx);
  if (disabled) throw conflict(disabled);
  const release = await getLatestRelease(ctx);
  const latest = release?.version ?? null;
  transaction(ctx.db, () => {
    setValue(ctx.db, SYSTEM_KEYS.lastUpdateCheckAt, ctx.now());
    setValue(ctx.db, SYSTEM_KEYS.latestVersion, latest);
  });

  const result: UpdateCheckResult = {
    currentVersion: ctx.version,
    latestVersion: latest,
    updateAvailable: false,
    message: "",
  };
  if (!release) return { ...result, message: "아직 배포된 버전이 없습니다." };
  if (compareVersions(release.version, ctx.version) <= 0) {
    return { ...result, message: `최신 버전(${ctx.version})을 사용 중입니다.` };
  }
  if (!release.zipUrl || !release.shaUrl) {
    return { ...result, message: `새 버전(${release.version})의 업데이트 파일이 아직 올라오지 않았습니다.` };
  }
  const state = readLauncherState(ctx.config.homeDir);
  // failedVersion: 시험 기동에 실패해 되돌린 버전, 또는 install.ps1 로 낮은 버전을 설치해 건너뛰는 버전
  const skipped = state?.failedVersion === release.version;
  const failed = skipped && state?.lastUpdateError?.version === release.version;
  return {
    ...result,
    updateAvailable: true,
    message: failed
      ? `새 버전(${release.version})이 있습니다. 이전에 이 버전으로 바꾸다 실패해 자동으로는 적용하지 않습니다. '지금 업데이트'로 다시 시도할 수 있습니다.`
      : skipped
        ? `새 버전(${release.version})이 있습니다. 낮은 버전으로 다시 설치해서 이 버전은 자동으로는 적용하지 않습니다. '지금 업데이트'로 설치할 수 있습니다.`
        : `새 버전(${release.version})이 있습니다.`,
  };
}

const applying = new WeakSet<AppContext>();

/**
 * 최신 릴리스를 받아 적용 준비 후 requestExit(75).
 * 순서: 내려받기(updates/) → SHA-256 확인 → DB 백업 → versions/<버전>/ 에 풀기 → state.json pending → 종료.
 * 반환: 화면에 보여줄 메시지.
 */
export async function applyUpdate(
  ctx: AppContext,
  requestExit: (code: number) => void,
  opts: { ip: string },
): Promise<string> {
  const disabled = updatesDisabledReason(ctx);
  if (disabled) throw conflict(disabled);
  const home = ctx.config.homeDir;
  const state = readLauncherState(home);
  if (!state) {
    throw conflict("설치 폴더에 state.json이 없어 업데이트를 적용할 수 없습니다. launcher로 실행 중인지 확인하세요.");
  }
  if (applying.has(ctx)) throw conflict("업데이트를 이미 진행하고 있습니다. 잠시 기다려 주세요.");
  applying.add(ctx);
  let started = false;
  try {
    const release = await getLatestRelease(ctx);
    if (!release || compareVersions(release.version, ctx.version) <= 0) throw conflict("이미 최신 버전입니다.");
    if (!release.zipUrl || !release.shaUrl) {
      throw conflict(`새 버전(${release.version})의 업데이트 파일이 아직 올라오지 않았습니다.`);
    }
    const version = release.version;
    const zipName = `leave-flow-${version}.zip`;

    let zip: Uint8Array;
    let shaText: string;
    try {
      [zip, shaText] = await Promise.all([
        download(ctx, release.zipUrl, DOWNLOAD_TIMEOUT_MS),
        download(ctx, release.shaUrl, API_TIMEOUT_MS).then((b) => new TextDecoder().decode(b)),
      ]);
    } catch (err) {
      throw new ApiError(502, `업데이트 파일을 내려받지 못했습니다. (${errText(err)})`);
    }
    const updatesDir = path.join(home, "updates");
    mkdirSync(updatesDir, { recursive: true });
    for (const old of readdirSync(updatesDir)) rmSync(path.join(updatesDir, old), { recursive: true, force: true });
    writeFileSync(path.join(updatesDir, zipName), zip);
    writeFileSync(path.join(updatesDir, `${zipName}.sha256`), shaText);

    const expected = parseSha256(shaText);
    const actual = createHash("sha256").update(zip).digest("hex");
    if (!expected || expected !== actual) {
      throw new ApiError(502, "내려받은 업데이트 파일의 무결성(SHA-256) 확인에 실패했습니다. 잠시 후 다시 시도하세요.");
    }

    const backup = await createBackup(ctx, "pre-update");
    try {
      extractRelease(zip, path.join(home, "versions", version));
    } catch (err) {
      throw new ApiError(502, `업데이트 파일을 풀지 못했습니다. (${errText(err)})`);
    }
    writeLauncherState(home, {
      ...state,
      pending: version,
      preUpdateBackup: path.join(ctx.config.backupDir, backup.name),
    });

    const now = ctx.now();
    transaction(ctx.db, () => {
      setValue(ctx.db, SYSTEM_KEYS.latestVersion, version);
      setValue(ctx.db, SYSTEM_KEYS.lastUpdateCheckAt, now);
      writeAudit(
        ctx.db,
        opts.ip,
        {
          entity: "system",
          action: "update_app",
          summary: `프로그램 업데이트 시작: ${ctx.version} → ${version}`,
          before: { version: ctx.version },
          after: { version, backup: backup.name },
        },
        now,
      );
    });
    started = true;
    requestExit(EXIT_UPDATE);
    return `새 버전(${version})을 설치했습니다. 서버가 잠시 재시작됩니다.`;
  } finally {
    // 성공하면 종료될 때까지 잠가 두어 두 번 적용하지 않게 함
    if (!started) applying.delete(ctx);
  }
}

/** 자동 업데이트 한 번: 새 버전이 있고 이전에 실패한 버전이 아니면 적용 */
export async function runAutoUpdate(
  ctx: AppContext,
  requestExit: (code: number) => void,
): Promise<"applied" | "none" | "skipped"> {
  const check = await checkForUpdate(ctx);
  if (!check.updateAvailable || !check.latestVersion) return "none";
  if (readLauncherState(ctx.config.homeDir)?.failedVersion === check.latestVersion) return "skipped";
  await applyUpdate(ctx, requestExit, { ip: "" });
  return "applied";
}

/**
 * launcher 가 남긴 결과를 기록 (서버 시작 시 + 시험 기동이 끝날 즈음 + 시스템 정보 조회 시).
 * - 새 버전으로 바뀌었으면 lastUpdatedAt (버전마다 한 번)
 * - 새 버전이 정상 기동하지 않아 되돌렸으면 변경 이력에 한 번 남김
 */
export function recordUpdateOutcome(ctx: AppContext): void {
  if (ctx.version === "dev") return;
  const state = readLauncherState(ctx.config.homeDir);
  if (!state) return;
  const { db } = ctx;

  if (
    !state.trial &&
    state.current === ctx.version &&
    state.previous &&
    state.previous !== ctx.version &&
    getValue<string | null>(db, UPDATED_VERSION_KEY, null) !== ctx.version
  ) {
    const at = state.updatedAt ?? ctx.now();
    transaction(db, () => {
      setValue(db, SYSTEM_KEYS.lastUpdatedAt, at);
      setValue(db, UPDATED_VERSION_KEY, ctx.version);
      writeAudit(db, "", {
        entity: "system",
        action: "update_app",
        summary: `프로그램 업데이트 완료: ${state.previous} → ${ctx.version}`,
        after: { version: ctx.version },
      }, ctx.now());
    });
  }

  const failure = state.lastUpdateError;
  if (failure) {
    const key = `${failure.version}@${failure.at}`;
    if (getValue<string | null>(db, ROLLBACK_NOTED_KEY, null) !== key) {
      transaction(db, () => {
        setValue(db, ROLLBACK_NOTED_KEY, key);
        writeAudit(db, "", {
          entity: "system",
          action: "update_app",
          summary: `업데이트 실패로 이전 버전으로 되돌림: ${failure.version} → ${state.current} (${failure.message})`,
          after: failure,
        }, ctx.now());
      });
    }
  }
}

/** setTimeout 이 받을 수 있는 가장 긴 시간. 이보다 길거나 NaN 이면 Node 가 1ms 로 바꿔 계속 실행됨 */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_CHECK_HOURS = 6;
/** 확인 주기 상한 24일 (MAX_TIMER_MS 보다 짧음) */
const MAX_CHECK_HOURS = 24 * 24;

/** config.updateCheckHours → 확인 주기(ms). 숫자가 아니거나 0 이하면 6시간, 그 밖에는 1시간~24일 */
export function updateCheckPeriodMs(hours: unknown): number {
  const h = typeof hours === "number" || typeof hours === "string" ? Number(hours) : Number.NaN;
  const bounded = Number.isFinite(h) && h > 0 ? Math.min(Math.max(h, 1), MAX_CHECK_HOURS) : DEFAULT_CHECK_HOURS;
  return Math.min(bounded * 3_600_000, MAX_TIMER_MS);
}

const checking = new WeakSet<AppContext>();

/**
 * 예약된 확인 한 번: autoUpdate 이면 새 버전을 받아 적용, 아니면 확인만 (최신 버전·최근 확인 일시 기록 → 관리 화면에 '새 버전' 표시).
 * 이전 확인이 아직 끝나지 않았으면 건너뜀 ("busy").
 */
export async function runScheduledUpdateCheck(
  ctx: AppContext,
  requestExit: (code: number) => void,
): Promise<"applied" | "none" | "skipped" | "checked" | "busy"> {
  if (checking.has(ctx)) return "busy";
  checking.add(ctx);
  try {
    if (ctx.config.autoUpdate) return await runAutoUpdate(ctx, requestExit);
    await checkForUpdate(ctx);
    return "checked";
  } finally {
    checking.delete(ctx);
  }
}

/**
 * config.updateRepo 의 GitHub Releases 를 서버 시작 약 2분 뒤와 config.updateCheckHours 마다 확인
 * (autoUpdate 가 꺼져 있어도 확인은 함). config.autoUpdate 이면 새 버전을 받아 적용 (launcher 와 연동).
 * 다음 확인은 이번 확인이 끝난 뒤에 예약함. docs/api.md "자동 업데이트" 참고.
 * 반환: 타이머를 정리하는 함수.
 */
export function startUpdateScheduler(ctx: AppContext, requestExit: (code: number) => void): () => void {
  const record = () => {
    try {
      recordUpdateOutcome(ctx);
    } catch (err) {
      console.error(`[update] 업데이트 결과 기록 실패: ${errText(err)}`);
    }
  };
  record();

  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, Math.min(ms, MAX_TIMER_MS));
    t.unref();
    timers.add(t);
  };
  later(record, RECORD_DELAY_MS);

  if (!updatesDisabledReason(ctx) && existsSync(path.join(ctx.config.homeDir, "state.json"))) {
    const periodMs = updateCheckPeriodMs(ctx.config.updateCheckHours);
    const run = () => {
      void runScheduledUpdateCheck(ctx, requestExit)
        .catch((err: unknown) =>
          console.error(`[update] ${ctx.config.autoUpdate ? "자동 업데이트" : "업데이트 확인"} 실패: ${errText(err)}`),
        )
        .finally(() => {
          if (!stopped) later(run, periodMs);
        });
    };
    later(run, FIRST_CHECK_DELAY_MS);
  }
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
