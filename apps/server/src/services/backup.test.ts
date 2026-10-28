import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { execute, openDatabase, queryAll, queryOne } from "../db/index.ts";
import { createTestApp, insertEmployee, testConfig } from "../testing.ts";
import {
  applyPendingRestore,
  createBackup,
  createDailyBackupTask,
  isBackupName,
  listBackups,
  parseBackupName,
  pruneBackups,
  PENDING_RESTORE_NAME,
} from "./backup.ts";
import { SYSTEM_KEYS, getValue } from "./settings.ts";

describe("백업 파일 이름", () => {
  it("규칙에 맞는 이름만 인정", () => {
    expect(parseBackupName("leave-flow-20261019-123000-daily.db")).toEqual({
      day: "20261019",
      at: "2026-10-19 12:30:00",
      reason: "daily",
    });
    expect(parseBackupName("leave-flow-20261019-123000-pre-restore-2.db")?.reason).toBe("pre-restore");
    expect(isBackupName("leave-flow-20261019-123000.db")).toBe(true);
    for (const bad of [
      "../leave-flow-20261019-123000.db",
      "..\\leave-flow-20261019-123000.db",
      "sub/leave-flow-20261019-123000.db",
      "leave-flow-20261019-123000.db.partial",
      "leave-flow.db",
      "leave-flow-2026101-123000.db",
      "C:leave-flow-20261019-123000.db",
    ]) {
      expect(isBackupName(bad), bad).toBe(false);
    }
  });
});

describe("백업 만들기", () => {
  it("로컬에 만들고 NAS에 복사, 최근 백업 일시 기록", async () => {
    const nas = path.join(testConfig().homeDir, "nas");
    const { ctx, db } = await createTestApp({ config: { nasBackupDir: nas } });
    insertEmployee(db, { name: "김백업" });
    const file = await createBackup(ctx, "manual");
    expect(file).toMatchObject({ name: "leave-flow-20261019-090000-manual.db", location: "local" });
    expect(file.size).toBeGreaterThan(0);
    expect(existsSync(path.join(nas, file.name))).toBe(true);
    expect(getValue(db, SYSTEM_KEYS.lastBackupAt, null)).toBe("2026-10-19 09:00:00");
    expect(getValue(db, SYSTEM_KEYS.lastBackupError, "x")).toBeNull();

    // 백업 파일은 그대로 열 수 있는 DB
    const copy = new DatabaseSync(path.join(ctx.config.backupDir, file.name));
    expect(queryOne(copy, "SELECT name FROM employees")).toEqual({ name: "김백업" });
    copy.close();

    // 같은 초에 다시 백업해도 이름이 겹치지 않음
    const again = await createBackup(ctx, "manual");
    expect(again.name).toBe("leave-flow-20261019-090000-manual-2.db");
    const list = await listBackups(ctx.config);
    expect(list.map((b) => `${b.location}:${b.name}`)).toEqual([
      "local:leave-flow-20261019-090000-manual.db",
      "nas:leave-flow-20261019-090000-manual.db",
      "local:leave-flow-20261019-090000-manual-2.db",
      "nas:leave-flow-20261019-090000-manual-2.db",
    ]);
  });

  it("NAS 복사가 실패해도 로컬 백업은 성공하고 오류를 기록", async () => {
    const home = testConfig().homeDir;
    const blocker = path.join(home, "not-a-dir");
    writeFileSync(blocker, "x");
    const { ctx, db } = await createTestApp({ config: { nasBackupDir: path.join(blocker, "nas") } });
    const file = await createBackup(ctx, "daily");
    expect(existsSync(path.join(ctx.config.backupDir, file.name))).toBe(true);
    expect(getValue(db, SYSTEM_KEYS.lastBackupAt, null)).toBe("2026-10-19 09:00:00");
    expect(getValue<string>(db, SYSTEM_KEYS.lastBackupError, "")).toMatch(/^NAS 복사 실패/);
    // 자동 백업은 변경 이력에 남기지 않음
    expect(queryAll(db, "SELECT * FROM audit_logs")).toEqual([]);
  });

  it("보관 기간이 지난 백업만 삭제 (이름 규칙에 맞는 파일만)", async () => {
    const config = testConfig({ backupKeepDays: 30 });
    mkdirSync(config.backupDir, { recursive: true });
    const names = [
      "leave-flow-20260918-123000-daily.db", // 31일 전 → 삭제
      "leave-flow-20260919-123000-daily.db", // 30일 전 → 보관
      "leave-flow-20261019-090000-manual.db",
      "other-20200101.db",
      "notes.txt",
    ];
    for (const n of names) writeFileSync(path.join(config.backupDir, n), "x");
    writeFileSync(path.join(config.backupDir, "leave-flow-20260918-123000-daily.db-wal"), "x");
    const removed = await pruneBackups(config, "2026-10-19");
    expect(removed).toEqual(["leave-flow-20260918-123000-daily.db"]);
    expect(readdirSync(config.backupDir).sort()).toEqual(
      ["leave-flow-20260919-123000-daily.db", "leave-flow-20261019-090000-manual.db", "notes.txt", "other-20200101.db"].sort(),
    );
  });
});

describe("자동 백업 (매일)", () => {
  it("백업 시각 전에는 하지 않고, 지나면 하루 한 번", async () => {
    const { ctx, setToday } = await createTestApp({ config: { backupTime: "12:30" } });
    const tick = createDailyBackupTask(ctx);
    expect(await tick()).toBeNull(); // 09:00 < 12:30

    ctx.config.backupTime = "08:00";
    const first = await tick();
    expect(first?.name).toBe("leave-flow-20261019-090000-daily.db");
    expect(await tick()).toBeNull();

    // 서버를 다시 켜도 오늘 자동 백업이 있으면 하지 않음
    expect(await createDailyBackupTask(ctx)()).toBeNull();

    setToday("2026-10-20");
    expect((await tick())?.name).toBe("leave-flow-20261020-090000-daily.db");
  });

  it("NAS가 꺼져 있어 복사하지 못하면 한 시간마다 NAS 복사만 다시 하고, NAS가 켜지면 복사", async () => {
    const home = testConfig().homeDir;
    // NAS 폴더 자리에 파일이 있어 폴더를 만들 수 없음 = NAS에 접근할 수 없음
    const offline = path.join(home, "nas-offline");
    writeFileSync(offline, "x");
    const nas = path.join(offline, "leave-flow");
    const { ctx, db } = await createTestApp({ config: { nasBackupDir: nas, backupTime: "08:00" } });
    let clock = Date.UTC(2026, 9, 19, 0, 0, 0);
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tick = createDailyBackupTask(ctx);
      const first = await tick();
      expect(first?.name).toBe("leave-flow-20261019-090000-daily.db");
      expect(getValue<string>(db, SYSTEM_KEYS.lastBackupError, "")).toMatch(/^NAS 복사 실패/);

      // NAS가 다시 켜졌지만 한 시간이 지나기 전에는 다시 시도하지 않음
      rmSync(offline);
      clock += 30 * 60_000;
      expect(await tick()).toBeNull();
      expect(existsSync(path.join(nas, first!.name))).toBe(false);

      clock += 31 * 60_000;
      expect(await tick()).toBeNull();
      expect(existsSync(path.join(nas, first!.name))).toBe(true);
      expect(getValue(db, SYSTEM_KEYS.lastBackupError, "x")).toBeNull();
      // 로컬 백업은 새로 만들지 않음, 그날은 더 하지 않음
      expect(readdirSync(ctx.config.backupDir).filter(isBackupName)).toEqual([first!.name]);
      clock += 2 * 60 * 60_000;
      expect(await tick()).toBeNull();
      expect(readdirSync(nas)).toEqual([first!.name]);
    } finally {
      now.mockRestore();
      errors.mockRestore();
    }
  });

  it("NAS 복사가 계속 실패하면 실패 이유를 계속 기록", async () => {
    const home = testConfig().homeDir;
    const offline = path.join(home, "nas-offline");
    writeFileSync(offline, "x");
    const { ctx, db } = await createTestApp({ config: { nasBackupDir: path.join(offline, "nas"), backupTime: "08:00" } });
    let clock = Date.UTC(2026, 9, 19, 0, 0, 0);
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tick = createDailyBackupTask(ctx);
      await tick();
      clock += 61 * 60_000;
      expect(await tick()).toBeNull();
      expect(getValue<string>(db, SYSTEM_KEYS.lastBackupError, "")).toMatch(/^NAS 복사 실패/);
      expect(readdirSync(ctx.config.backupDir).filter(isBackupName)).toHaveLength(1);
    } finally {
      now.mockRestore();
      errors.mockRestore();
    }
  });

  it("서버를 다시 켰을 때 오늘 자동 백업이 로컬에만 있으면 NAS로 복사", async () => {
    const nas = path.join(testConfig().homeDir, "nas");
    const { ctx } = await createTestApp({ config: { backupTime: "08:00" } });
    // NAS 설정 전에 만든 오늘 자동 백업
    const first = await createDailyBackupTask(ctx)();
    expect(first).not.toBeNull();

    ctx.config.nasBackupDir = nas;
    expect(await createDailyBackupTask(ctx)()).toBeNull();
    expect(existsSync(path.join(nas, first!.name))).toBe(true);
    expect(readdirSync(ctx.config.backupDir).filter(isBackupName)).toEqual([first!.name]);
    // 이미 NAS에 있으면 그대로
    expect(await createDailyBackupTask(ctx)()).toBeNull();
    expect(readdirSync(nas)).toEqual([first!.name]);
  });
});

describe("백업 복구 적용 (서버 시작 시)", () => {
  function fileDb(file: string, name: string) {
    const db = openDatabase(file);
    execute(
      db,
      "INSERT INTO employees (name, created_at, updated_at) VALUES (?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
      [name],
    );
    return db;
  }

  it("복구 대기 파일이 없으면 아무것도 하지 않음", () => {
    const config = testConfig({ dbPath: "" });
    config.dbPath = path.join(config.dataDir, "leave-flow.db");
    expect(applyPendingRestore(config)).toBe(false);
    expect(existsSync(config.dataDir)).toBe(false);
  });

  it("현재 DB를 backups/ 에 보관하고 복구 파일로 바꿈", () => {
    const config = testConfig();
    config.dbPath = path.join(config.dataDir, "leave-flow.db");
    fileDb(config.dbPath, "현재").close();
    const pending = path.join(config.dataDir, PENDING_RESTORE_NAME);
    const restored = fileDb(pending, "복구본");
    restored.exec("PRAGMA journal_mode = DELETE");
    restored.close();

    expect(applyPendingRestore(config)).toBe(true);
    expect(existsSync(pending)).toBe(false);
    const db = openDatabase(config.dbPath);
    expect(queryAll(db, "SELECT name FROM employees")).toEqual([{ name: "복구본" }]);
    db.close();

    const kept = readdirSync(config.backupDir).filter((n) => n.endsWith(".db"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^leave-flow-\d{8}-\d{6}-pre-restore\.db$/);
    const old = new DatabaseSync(path.join(config.backupDir, kept[0]!));
    expect(queryAll(old, "SELECT name FROM employees")).toEqual([{ name: "현재" }]);
    old.close();
  });

  it("현재 DB가 없어도 복구 파일을 DB 자리로 옮김", () => {
    const config = testConfig();
    config.dbPath = path.join(config.dataDir, "leave-flow.db");
    const pending = path.join(config.dataDir, PENDING_RESTORE_NAME);
    fileDb(pending, "복구본").close();
    expect(applyPendingRestore(config)).toBe(true);
    expect(existsSync(config.dbPath)).toBe(true);
    expect(existsSync(pending)).toBe(false);
  });
});
