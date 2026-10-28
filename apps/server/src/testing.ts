// 테스트 도우미: 메모리 DB로 앱을 띄우고, 다른 기능의 API 없이도 기준 데이터를 직접 넣을 수 있게 함.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";
import type { Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { execute, openDatabase, queryOne, type Db } from "./db/index.ts";

export const TEST_TODAY = "2026-10-19";

export function testConfig(overrides: Partial<Config> = {}): Config {
  const home = mkdtempSync(path.join(os.tmpdir(), "leave-flow-test-"));
  return {
    homeDir: home,
    host: "127.0.0.1",
    port: 0,
    dataDir: path.join(home, "data"),
    dbPath: ":memory:",
    backupDir: path.join(home, "backups"),
    nasBackupDir: null,
    backupKeepDays: 30,
    backupTime: "12:30",
    webDir: null,
    updateRepo: null,
    autoUpdate: false,
    updateCheckHours: 6,
    holidayYearsBefore: 1,
    holidayYearsAfter: 2,
    allowedHosts: [],
    logger: false,
    ...overrides,
  };
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  ctx: AppContext;
  /** 테스트 중 오늘 날짜 바꾸기 */
  setToday: (date: string) => void;
  exitCodes: number[];
}

export async function createTestApp(opts: { config?: Partial<Config> } = {}): Promise<TestApp> {
  const config = testConfig(opts.config);
  const db = openDatabase(config.dbPath);
  let today = TEST_TODAY;
  const ctx: AppContext = {
    db,
    config,
    version: "0.0.0-test",
    today: () => today,
    now: () => `${today} 09:00:00`,
  };
  const exitCodes: number[] = [];
  const app = await buildApp(ctx, { requestExit: (code) => exitCodes.push(code) });
  return { app, db, ctx, setToday: (d) => (today = d), exitCodes };
}

/** 지금 저장된 수정 일시 (수정 저장에 baseUpdatedAt 으로 보냄). 없으면 "" */
export function updatedAtOf(db: Db, table: "leave_requests" | "overtime_requests", id: number): string {
  return String(queryOne<{ updated_at: string }>(db, `SELECT updated_at FROM ${table} WHERE id = ?`, [id])?.updated_at ?? "");
}

const STAMP = "2026-01-01 00:00:00";

/** 직원 직접 추가 (기본: 월~금 10:00~19:00) */
export function insertEmployee(
  db: Db,
  e: Partial<{
    name: string;
    department: string;
    color: string;
    workDays: number[];
    workStart: string;
    workEnd: string;
    emergencyContact: string;
    category: string;
    /** true 면 "사회복무요원"(특별휴가 대상) 구분으로 (구분이 없으면 만듦) */
    isSocialServiceAgent: boolean;
    active: boolean;
  }> = {},
): number {
  let category = e.category ?? "";
  if (e.isSocialServiceAgent) {
    category = "사회복무요원";
    execute(
      db,
      `INSERT OR IGNORE INTO categories (name, social_service_agent, sort_order, created_at, updated_at)
       VALUES (?, 1, 0, ?, ?)`,
      [category, STAMP, STAMP],
    );
  }
  return execute(
    db,
    `INSERT INTO employees (name, department, color, work_days, work_start, work_end, emergency_contact,
       category, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.name ?? "홍길동",
      e.department ?? "아동사업부",
      e.color ?? "#4f7cff",
      JSON.stringify(e.workDays ?? [1, 2, 3, 4, 5]),
      e.workStart ?? "10:00",
      e.workEnd ?? "19:00",
      e.emergencyContact ?? "010-0000-0000",
      category,
      e.active === false ? 0 : 1,
      STAMP,
      STAMP,
    ],
  ).lastInsertRowid;
}

/** 휴가 종류 직접 추가 (기본: 차감, 연도별. 소진이면 잔여가 없을 때 숨김) */
export function insertLeaveType(
  db: Db,
  t: Partial<{
    name: string;
    deducts: boolean;
    balanceMode: "yearly" | "cumulative" | "used_up";
    hideWhenEmpty: boolean;
    sortOrder: number;
    active: boolean;
  }> = {},
): number {
  const balanceMode = t.balanceMode ?? "yearly";
  return execute(
    db,
    `INSERT INTO leave_types (name, deducts, balance_mode, hide_when_empty, sort_order, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.name ?? "연차",
      t.deducts === false ? 0 : 1,
      balanceMode,
      (t.hideWhenEmpty ?? balanceMode === "used_up") ? 1 : 0,
      t.sortOrder ?? 0,
      t.active === false ? 0 : 1,
      STAMP,
      STAMP,
    ],
  ).lastInsertRowid;
}

/** 직접 입력 부여 추가 (분 단위) */
export function insertGrant(
  db: Db,
  g: { employeeId: number; leaveTypeId: number; grantDate: string; minutes: number; note?: string },
): number {
  return execute(
    db,
    `INSERT INTO leave_grants (employee_id, leave_type_id, grant_date, minutes, note, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
    [g.employeeId, g.leaveTypeId, g.grantDate, g.minutes, g.note ?? "", STAMP, STAMP],
  ).lastInsertRowid;
}

/** 공휴일·휴무일 직접 추가 */
export function insertHoliday(
  db: Db,
  h: { date: string; name: string; kind?: "public" | "center"; source?: "auto" | "manual" },
): number {
  return execute(
    db,
    "INSERT INTO holidays (date, name, kind, source, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    [h.date, h.name, h.kind ?? "public", h.source ?? "manual", STAMP],
  ).lastInsertRowid;
}

/** 구분 직접 추가 */
export function insertCategory(db: Db, name: string, socialServiceAgent = false): number {
  return execute(
    db,
    "INSERT INTO categories (name, social_service_agent, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    [name, socialServiceAgent ? 1 : 0, STAMP, STAMP],
  ).lastInsertRowid;
}

/** 소속 직접 추가 */
export function insertDepartment(db: Db, name: string, sortOrder = 0): number {
  return execute(db, "INSERT INTO departments (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    name,
    sortOrder,
    STAMP,
    STAMP,
  ]).lastInsertRowid;
}
