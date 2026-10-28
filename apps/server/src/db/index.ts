import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { localTimestamp } from "@leave-flow/shared";
import { migrations } from "./migrations.ts";

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue> | readonly SQLInputValue[];
export type Row = Record<string, unknown>;

export function openDatabase(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** 아직 적용하지 않은 마이그레이션을 순서대로 적용 */
function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    queryAll<{ version: number }>(db, "SELECT version FROM schema_migrations").map((r) => r.version),
  );
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      execute(db, "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        m.version,
        m.name,
        localTimestamp(),
      ]);
    });
  }
}

function bind(params: Params | undefined): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...(params as SQLInputValue[])] : [params as Record<string, SQLInputValue>];
}

export function queryAll<T = Row>(db: Db, sql: string, params?: Params): T[] {
  return db.prepare(sql).all(...(bind(params) as SQLInputValue[])) as T[];
}

export function queryOne<T = Row>(db: Db, sql: string, params?: Params): T | undefined {
  return db.prepare(sql).get(...(bind(params) as SQLInputValue[])) as T | undefined;
}

export function execute(db: Db, sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...(bind(params) as SQLInputValue[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

const depth = new WeakMap<Db, number>();

/** 트랜잭션. 중첩 호출은 SAVEPOINT로 처리. fn이 예외를 던지면 되돌림. */
export function transaction<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const sp = `sp_${d}`;
  db.exec(d === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const result = fn();
    db.exec(d === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(d === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, d);
  }
}

export const toBool = (v: unknown): boolean => v === 1 || v === 1n || v === true;
export const fromBool = (v: boolean): number => (v ? 1 : 0);
export const toNum = (v: unknown): number => Number(v);
export const toNullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const toNullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
