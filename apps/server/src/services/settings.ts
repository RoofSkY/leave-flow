import type { Settings } from "@leave-flow/shared";
import { execute, queryOne, type Db } from "../db/index.ts";

/** settings 테이블 값 읽기 (JSON) */
export function getValue<T>(db: Db, key: string, fallback: T): T {
  const row = queryOne<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setValue(db: Db, key: string, value: unknown): void {
  execute(
    db,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

const WORK_START_KEY = "employee.defaultWorkStart";
const WORK_END_KEY = "employee.defaultWorkEnd";

/** 직원 근무시간 기본값 (설정하지 않았을 때) */
export const DEFAULT_WORK_START = "09:00";
export const DEFAULT_WORK_END = "18:00";

export function getSettings(db: Db): Settings {
  return {
    defaultWorkStart: getValue<string>(db, WORK_START_KEY, DEFAULT_WORK_START),
    defaultWorkEnd: getValue<string>(db, WORK_END_KEY, DEFAULT_WORK_END),
  };
}

/** 보낸 항목만 저장 */
export function saveSettings(db: Db, s: Partial<Settings>): void {
  if (s.defaultWorkStart !== undefined) setValue(db, WORK_START_KEY, s.defaultWorkStart);
  if (s.defaultWorkEnd !== undefined) setValue(db, WORK_END_KEY, s.defaultWorkEnd);
}

/** 시스템 상태 값 키 (백업·업데이트 기록) */
export const SYSTEM_KEYS = {
  lastBackupAt: "system.lastBackupAt",
  lastBackupError: "system.lastBackupError",
  lastUpdateCheckAt: "system.lastUpdateCheckAt",
  lastUpdatedAt: "system.lastUpdatedAt",
  latestVersion: "system.latestVersion",
} as const;
