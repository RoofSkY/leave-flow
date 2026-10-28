// DB 백업(로컬 backups/ + NAS)·보관 기간 정리·백업 복구.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addDays, localTimestamp, type BackupFile } from "@leave-flow/shared";
import type { Config } from "../config.ts";
import type { AppContext } from "../context.ts";
import { execute, queryAll, queryOne, transaction, type Db } from "../db/index.ts";
import { ApiError, badRequest, notFound } from "../lib/errors.ts";
import { writeAudit } from "./audit.ts";
import { SYSTEM_KEYS, setValue } from "./settings.ts";

/** 백업 사유 (파일 이름 끝에 붙음) */
export type BackupReason = "daily" | "manual" | "pre-restore" | "pre-update" | "pre-delete";

/** leave-flow-YYYYMMDD-HHMMSS[-사유][-번호].db */
const NAME_RE = /^leave-flow-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([a-z]+(?:-[a-z]+)*))?(?:-(\d+))?\.db$/;

/** 복구 대기 파일 (서버 시작 시 DB 자리로 옮김) */
export const PENDING_RESTORE_NAME = "restore-pending.db";

/** NAS 폴더 목록을 기다리는 최대 시간 (꺼져 있으면 Windows가 오래 기다림) */
const NAS_LIST_TIMEOUT_MS = 8_000;
/** 자동 백업 실패 후 다시 시도하기까지 */
const DAILY_RETRY_MS = 60 * 60_000;

export interface ParsedBackupName {
  /** "YYYYMMDD" */
  day: string;
  /** "YYYY-MM-DD HH:MM:SS" */
  at: string;
  reason: string | null;
}

export function parseBackupName(name: string): ParsedBackupName | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return {
    day: `${m[1]}${m[2]}${m[3]}`,
    at: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    reason: m[7] ?? null,
  };
}

export function isBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "2026-10-19 09:00:00" → "20261019-090000" */
function stamp(now: string): string {
  return `${now.slice(0, 10).replaceAll("-", "")}-${now.slice(11, 19).replaceAll(":", "")}`;
}

/** 같은 초에 여러 번 백업해도 겹치지 않는 이름 */
function uniqueName(dir: string, now: string, reason: BackupReason): string {
  const base = `leave-flow-${stamp(now)}-${reason}`;
  let name = `${base}.db`;
  for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${base}-${n}.db`;
  return name;
}

/** 실행 중인 DB의 일관된 단일 파일 복사본 (VACUUM INTO). target 은 없어야 함 */
export function snapshotDatabase(db: Db, target: string): void {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
}

/** 다른 드라이브로도 옮길 수 있는 이동 */
function moveFileSync(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** 임시 이름으로 복사한 뒤 바꿔서, 복사 중인 파일이 백업 목록에 보이지 않게 함 */
async function copyInto(source: string, dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  const partial = `${target}.partial`;
  try {
    await copyFile(source, partial);
    await rename(partial, target);
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    throw err;
  }
}

function backupDirOf(config: Config, location: BackupFile["location"]): string | null {
  return location === "local" ? config.backupDir : config.nasBackupDir;
}

/** 로컬 backups/ 의 백업 파일을 NAS 폴더로 복사. 반환: 실패 이유 (성공했거나 NAS를 쓰지 않으면 null) */
export async function copyToNas(config: Config, name: string): Promise<string | null> {
  if (!config.nasBackupDir) return null;
  try {
    await copyInto(path.join(config.backupDir, name), config.nasBackupDir, name);
    return null;
  } catch (err) {
    return `NAS 복사 실패: ${errText(err)}`;
  }
}

/**
 * 지금 DB를 백업. 로컬 backups/ 에 만든 뒤 NAS 폴더로 복사.
 * NAS 복사 실패는 로컬 백업을 실패시키지 않고 lastBackupError 에 기록.
 * 수동 백업(manual)만 변경 이력에 남김.
 */
export async function createBackup(
  ctx: AppContext,
  reason: BackupReason,
  opts: { ip?: string } = {},
): Promise<BackupFile> {
  return (await backupWithNasResult(ctx, reason, opts)).file;
}

/** createBackup + NAS 복사 결과 (자동 백업이 NAS 복사만 나중에 다시 하려고 씀) */
async function backupWithNasResult(
  ctx: AppContext,
  reason: BackupReason,
  opts: { ip?: string },
): Promise<{ file: BackupFile; nasError: string | null }> {
  const { db, config } = ctx;
  const now = ctx.now();
  let file = "";
  try {
    mkdirSync(config.backupDir, { recursive: true });
    file = path.join(config.backupDir, uniqueName(config.backupDir, now, reason));
    rmSync(`${file}.partial`, { force: true });
    snapshotDatabase(db, `${file}.partial`);
    renameSync(`${file}.partial`, file);
  } catch (err) {
    if (file) rmSync(`${file}.partial`, { force: true });
    transaction(db, () => setValue(db, SYSTEM_KEYS.lastBackupError, `백업 실패: ${errText(err)}`));
    throw new ApiError(500, `백업하지 못했습니다. (${errText(err)})`);
  }
  const name = path.basename(file);

  const nasError = await copyToNas(config, name);

  transaction(db, () => {
    setValue(db, SYSTEM_KEYS.lastBackupAt, now);
    setValue(db, SYSTEM_KEYS.lastBackupError, nasError);
    if (reason === "manual") {
      writeAudit(
        db,
        opts.ip ?? "",
        {
          entity: "system",
          action: "backup",
          summary: `수동 백업: ${name}${nasError ? " (NAS 복사 실패)" : ""}`,
          after: { name, nas: config.nasBackupDir ? !nasError : null },
        },
        now,
      );
    }
  });

  await pruneBackups(config, ctx.today());
  return { file: { name, location: "local", size: statSync(file).size, modifiedAt: now }, nasError };
}

/** 보관 기간(backupKeepDays)보다 오래된 백업 삭제 (이름 규칙에 맞는 파일만). 반환: 지운 파일 이름 */
export async function pruneBackups(config: Config, today: string): Promise<string[]> {
  if (config.backupKeepDays < 1) return [];
  const cutoff = addDays(today, -config.backupKeepDays).replaceAll("-", "");
  const removed: string[] = [];
  for (const dir of [config.backupDir, config.nasBackupDir]) {
    if (!dir) continue;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const parsed = parseBackupName(name);
      if (!parsed || parsed.day >= cutoff) continue;
      try {
        await rm(path.join(dir, name), { force: true });
        // 복구 때 옮겨 둔 WAL 파일도 함께
        await rm(path.join(dir, `${name}-wal`), { force: true });
        removed.push(name);
      } catch {
        // 다음 정리 때 다시 시도
      }
    }
  }
  return removed;
}

async function listDir(dir: string, location: BackupFile["location"]): Promise<BackupFile[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: BackupFile[] = [];
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    try {
      const s = await stat(path.join(dir, name));
      if (s.isFile()) out.push({ name, location, size: s.size, modifiedAt: parsed.at });
    } catch {
      // 목록을 읽는 사이 지워진 파일
    }
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 백업 목록 (최근순, 같은 시각이면 로컬 먼저). NAS에 접근할 수 없으면 로컬만 */
export async function listBackups(config: Config): Promise<BackupFile[]> {
  const local = await listDir(config.backupDir, "local");
  const nas = config.nasBackupDir
    ? await withTimeout(listDir(config.nasBackupDir, "nas"), NAS_LIST_TIMEOUT_MS, [])
    : [];
  const desc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
  return [...local, ...nas].sort(
    (a, b) =>
      desc(a.modifiedAt, b.modifiedAt) ||
      desc(a.name, b.name) ||
      (a.location === b.location ? 0 : a.location === "local" ? -1 : 1),
  );
}

/** leave-flow DB인지 확인 (무결성 검사 + 마이그레이션 표) */
function checkBackupFile(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const check = queryOne<{ quick_check: string }>(db, "PRAGMA quick_check");
    if (check?.quick_check !== "ok") throw new Error("무결성 검사 실패");
    queryOne(db, "SELECT MAX(version) AS v FROM schema_migrations");
  } finally {
    db.close();
  }
}

/**
 * 복구할 파일에 지금의 시스템 상태(최근 백업·업데이트 기록, system.*)를 옮기고 복구 기록을 남긴 뒤 WAL 없이 닫음.
 * 백업·업데이트 기록은 업무 데이터가 아니라서 복구로 되돌아가면 안 됨.
 */
function stampRestoreFile(file: string, current: Db, ip: string, summary: string, at: string): void {
  const systemRows = queryAll<{ key: string; value: string }>(
    current,
    "SELECT key, value FROM settings WHERE key LIKE 'system.%'",
  );
  const db = new DatabaseSync(file);
  try {
    transaction(db, () => {
      execute(db, "DELETE FROM settings WHERE key LIKE 'system.%'");
      for (const r of systemRows) execute(db, "INSERT INTO settings (key, value) VALUES (?, ?)", [r.key, r.value]);
      writeAudit(db, ip, { entity: "system", action: "restore_backup", summary }, at);
    });
    db.exec("PRAGMA journal_mode = DELETE");
  } finally {
    db.close();
  }
}

/**
 * 백업 복구 준비. 고른 백업을 data/restore-pending.db 로 복사하고 지금 DB를 백업(pre-restore).
 * 실제 교체는 재시작(종료 코드 76) 후 applyPendingRestore 가 함.
 */
export async function prepareRestore(
  ctx: AppContext,
  name: string,
  location: BackupFile["location"],
  ip: string,
): Promise<void> {
  const { config, db } = ctx;
  // 이름 규칙에 맞아야 함 → 경로 구분자·".." 가 들어갈 수 없음
  if (!isBackupName(name)) throw badRequest("백업 파일 이름이 올바르지 않습니다.");
  const dir = backupDirOf(config, location);
  if (!dir) throw badRequest("NAS 백업 폴더가 설정되어 있지 않습니다.");
  const source = path.join(dir, name);
  const exists = await stat(source).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) throw notFound("백업 파일을 찾을 수 없습니다.");

  const where = location === "local" ? "로컬" : "NAS";
  const summary = `백업 복구: ${name} (${where})`;
  mkdirSync(config.dataDir, { recursive: true });
  const pending = path.join(config.dataDir, PENDING_RESTORE_NAME);
  const partial = `${pending}.partial`;
  rmSync(partial, { force: true });
  try {
    await copyFile(source, partial);
  } catch (err) {
    throw new ApiError(500, `백업 파일을 복사하지 못했습니다. (${errText(err)})`);
  }
  try {
    checkBackupFile(partial);
  } catch {
    rmSync(partial, { force: true });
    throw badRequest("올바른 leave-flow 백업 파일이 아닙니다.");
  }

  try {
    await createBackup(ctx, "pre-restore");
    stampRestoreFile(partial, db, ip, summary, ctx.now());
  } catch (err) {
    rmSync(partial, { force: true });
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, `복구를 준비하지 못했습니다. (${errText(err)})`);
  }
  renameSync(partial, pending);
  transaction(db, () =>
    writeAudit(db, ip, { entity: "system", action: "restore_backup", summary, after: { name, location } }, ctx.now()),
  );
}

/**
 * 서버 시작 시 DB를 열기 전에 호출. data/restore-pending.db 가 있으면 현재 DB(+ -wal/-shm)를
 * backups/ 에 보관한 뒤 restore-pending.db 를 DB 자리로 옮김. 반환: 복구했으면 true.
 */
export function applyPendingRestore(config: Config): boolean {
  if (config.dbPath === ":memory:") return false;
  const pending = path.join(config.dataDir, PENDING_RESTORE_NAME);
  if (!existsSync(pending)) return false;
  const dbPath = config.dbPath;

  if (existsSync(dbPath)) {
    // WAL에 남은 내용을 DB 파일에 합쳐 한 파일로 보관 (손상된 DB면 WAL 파일째 옮김)
    try {
      const old = new DatabaseSync(dbPath);
      try {
        old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        old.exec("PRAGMA journal_mode = DELETE");
      } finally {
        old.close();
      }
    } catch {
      // 그대로 옮김
    }
    mkdirSync(config.backupDir, { recursive: true });
    const target = path.join(config.backupDir, uniqueName(config.backupDir, localTimestamp(), "pre-restore"));
    moveFileSync(dbPath, target);
    if (existsSync(`${dbPath}-wal`)) moveFileSync(`${dbPath}-wal`, `${target}-wal`);
  } else if (existsSync(`${dbPath}-wal`)) {
    rmSync(`${dbPath}-wal`, { force: true });
  }
  rmSync(`${dbPath}-shm`, { force: true });

  // 복구 파일은 준비할 때 WAL 없이 닫았지만, 남아 있으면 함께 옮김
  if (existsSync(`${pending}-wal`)) moveFileSync(`${pending}-wal`, `${dbPath}-wal`);
  rmSync(`${pending}-shm`, { force: true });
  mkdirSync(path.dirname(dbPath), { recursive: true });
  moveFileSync(pending, dbPath);
  return true;
}

/** 로컬 backups/ 에 있는 그날 자동 백업(daily) 이름 (오래된 것부터) */
async function dailyBackupsOf(config: Config, today: string): Promise<string[]> {
  const day = today.replaceAll("-", "");
  const names = await readdir(config.backupDir).catch(() => [] as string[]);
  return names
    .filter((n) => {
      const p = parseBackupName(n);
      return p?.day === day && p.reason === "daily";
    })
    .sort();
}

/** 이 백업 중 하나라도 NAS 폴더에 있는지 (NAS를 쓰지 않으면 true, 접근할 수 없으면 false) */
async function someOnNas(config: Config, names: string[]): Promise<boolean> {
  if (!config.nasBackupDir) return true;
  const onNas = await withTimeout(readdir(config.nasBackupDir), NAS_LIST_TIMEOUT_MS, [] as string[]);
  return names.some((n) => onNas.includes(n));
}

/**
 * 매분 확인하는 자동 백업 작업. backupTime 이 지났고 오늘 자동 백업이 없으면 실행
 * (PC가 그 시각에 꺼져 있었어도 켜진 뒤 바로 따라잡음). 반환: 실행했으면 백업 파일.
 * NAS 복사에 실패하면(NAS 재시작·절전 등) 그날 안에 DAILY_RETRY_MS 마다 NAS 복사만 다시 함.
 * 서버를 다시 켰을 때 오늘 자동 백업이 로컬에만 있고 NAS에 없어도 NAS로 복사.
 */
export function createDailyBackupTask(ctx: AppContext): () => Promise<BackupFile | null> {
  let doneDay: string | null = null;
  let failedAt = 0;
  let running = false;
  /** 로컬에는 만들었지만 NAS 복사가 끝나지 않은 그날 자동 백업 */
  let nasPending: { day: string; name: string } | null = null;
  let nasFailedAt = 0;

  /** NAS 복사만 다시. 성공하면 그날 자동 백업 끝 */
  const retryNasCopy = async (pending: { day: string; name: string }) => {
    if (!existsSync(path.join(ctx.config.backupDir, pending.name))) {
      // 로컬 백업이 지워졌으면 다음 확인 때 새로 만듦
      nasPending = null;
      return;
    }
    const nasError = await copyToNas(ctx.config, pending.name);
    transaction(ctx.db, () => setValue(ctx.db, SYSTEM_KEYS.lastBackupError, nasError));
    if (nasError) {
      nasFailedAt = Date.now();
      console.error(`[backup] 자동 백업 ${nasError} (${DAILY_RETRY_MS / 60_000}분 뒤 다시 시도)`);
      return;
    }
    nasPending = null;
    nasFailedAt = 0;
    doneDay = pending.day;
  };

  return async () => {
    const now = ctx.now();
    const today = now.slice(0, 10);
    if (running || doneDay === today || now.slice(11, 16) < ctx.config.backupTime) return null;
    if (nasPending && (nasPending.day !== today || !ctx.config.nasBackupDir)) nasPending = null;
    if (nasPending) {
      if (Date.now() - nasFailedAt < DAILY_RETRY_MS) return null;
    } else if (failedAt && Date.now() - failedAt < DAILY_RETRY_MS) {
      return null;
    }
    running = true;
    try {
      if (nasPending) {
        await retryNasCopy(nasPending);
        return null;
      }
      const existing = await dailyBackupsOf(ctx.config, today);
      if (existing.length > 0) {
        if (await someOnNas(ctx.config, existing)) {
          doneDay = today;
        } else {
          nasPending = { day: today, name: existing[existing.length - 1]! };
          await retryNasCopy(nasPending);
        }
        return null;
      }
      const { file, nasError } = await backupWithNasResult(ctx, "daily", {});
      failedAt = 0;
      if (nasError) {
        nasPending = { day: today, name: file.name };
        nasFailedAt = Date.now();
        console.error(`[backup] 자동 백업 ${nasError} (${DAILY_RETRY_MS / 60_000}분 뒤 다시 시도)`);
      } else {
        doneDay = today;
      }
      return file;
    } catch (err) {
      failedAt = Date.now();
      console.error(`[backup] 자동 백업 실패: ${errText(err)}`);
      return null;
    } finally {
      running = false;
    }
  };
}

/**
 * 매일 config.backupTime 에 DB 백업 (로컬 backups/ + NAS), config.backupKeepDays 보다 오래된 백업 삭제.
 * PC가 그 시각에 꺼져 있었으면 서버 시작 후 오늘 백업이 없을 때 바로 실행.
 * 반환: 타이머를 정리하는 함수.
 */
export function startBackupScheduler(ctx: AppContext): () => void {
  const tick = createDailyBackupTask(ctx);
  const first = setTimeout(() => void tick(), 20_000);
  const timer = setInterval(() => void tick(), 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
