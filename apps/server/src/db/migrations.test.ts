import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute, openDatabase, queryAll } from "./index.ts";

describe("마이그레이션 v5 reset_auto_holidays", () => {
  it("올해 이후의 자동 등록 공휴일만 지우고 변경 이력을 남김", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "leave-flow-migration-")), "leave-flow.db");
    const year = new Date().getFullYear();
    let db = openDatabase(file);
    const add = (date: string, name: string, kind: string, source: string, active = 1) =>
      execute(
        db,
        "INSERT INTO holidays (date, name, kind, source, active, created_at) VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')",
        [date, name, kind, source, active],
      );
    add(`${year}-02-17`, "설날", "public", "auto");
    add(`${year + 1}-02-06`, "설날", "public", "auto");
    add(`${year}-03-02`, "대체공휴일", "public", "auto", 0);
    add(`${year - 1}-01-01`, "새해첫날", "public", "auto");
    add(`${year}-05-01`, "근로자의 날", "public", "manual");
    add(`${year}-10-20`, "체육대회", "center", "manual");
    // v4 까지만 적용된 DB처럼 만든 뒤 다시 열어 v5 를 적용
    execute(db, "DELETE FROM schema_migrations WHERE version = 5");
    db.close();
    db = openDatabase(file);
    try {
      expect(queryAll(db, "SELECT date, source, active FROM holidays ORDER BY date").map((r) => ({ ...r }))).toEqual([
        { date: `${year - 1}-01-01`, source: "auto", active: 1 },
        { date: `${year}-03-02`, source: "auto", active: 0 },
        { date: `${year}-05-01`, source: "manual", active: 1 },
        { date: `${year}-10-20`, source: "manual", active: 1 },
      ]);
      expect(queryAll(db, "SELECT entity, action, summary FROM audit_logs").map((r) => ({ ...r }))).toEqual([
        { entity: "holiday", action: "delete", summary: "예전 자동 등록 공휴일 2건 삭제 (구글 캘린더에서 다시 가져옴)" },
      ]);
    } finally {
      db.close();
    }
  });

  it("지울 공휴일이 없으면 변경 이력도 남기지 않음", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "leave-flow-migration-")), "leave-flow.db");
    let db = openDatabase(file);
    execute(db, "DELETE FROM schema_migrations WHERE version = 5");
    db.close();
    db = openDatabase(file);
    try {
      expect(queryAll(db, "SELECT version FROM schema_migrations WHERE version = 5")).toHaveLength(1);
      expect(queryAll(db, "SELECT id FROM audit_logs")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
