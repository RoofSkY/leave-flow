import { describe, expect, it } from "vitest";
import type { Holiday, HolidayChangeResult } from "@leave-flow/shared";
import { execute, queryAll, queryOne, type Db } from "../db/index.ts";
import { createTestApp, insertEmployee, insertHoliday, insertLeaveType } from "../testing.ts";

/** 신청 상태 휴가원 + 항목 1개 (근무 월~금 10:00~19:00) */
function insertLeave(db: Db, employeeId: number, leaveTypeId: number, startAt: string, endAt: string, minutes: number) {
  const rid = execute(
    db,
    `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
       status, created_at, updated_at) VALUES (?, '홍길동', '', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', 'active', 'x', 'x')`,
    [employeeId],
  ).lastInsertRowid;
  execute(
    db,
    `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [rid, leaveTypeId, startAt, endAt, minutes, JSON.stringify({ [startAt.slice(0, 4)]: minutes })],
  );
  return rid;
}

const itemMinutes = (db: Db, rid: number) =>
  Number(queryOne<{ minutes: number }>(db, "SELECT minutes FROM leave_request_items WHERE request_id = ?", [rid])!.minutes);

async function setup() {
  const t = await createTestApp();
  const emp = insertEmployee(t.db);
  const type = insertLeaveType(t.db);
  // 10/26(월) ~ 10/30(금) 5일 = 2400분 (아직 지나지 않음), 10/12 ~ 10/16 (지남)
  const future = insertLeave(t.db, emp, type, "2026-10-26T10:00", "2026-10-30T19:00", 2400);
  const past = insertLeave(t.db, emp, type, "2026-10-12T10:00", "2026-10-16T19:00", 2400);
  return { ...t, emp, type, future, past };
}

describe("GET /api/holidays", () => {
  it("기간·비활성 포함 여부로 조회, 날짜순", async () => {
    const { app, db } = await setup();
    insertHoliday(db, { date: "2026-12-25", name: "기독탄신일", source: "auto" });
    insertHoliday(db, { date: "2026-10-28", name: "체육대회", kind: "center" });
    const hidden = insertHoliday(db, { date: "2026-10-09", name: "한글날", source: "auto" });
    insertHoliday(db, { date: "2027-01-01", name: "신정", source: "auto" });
    execute(db, "UPDATE holidays SET active = 0 WHERE id = ?", [hidden]);

    const res = await app.inject({ method: "GET", url: "/api/holidays?from=2026-01-01&to=2026-12-31" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Holiday[]).map((h) => h.date)).toEqual(["2026-10-28", "2026-12-25"]);

    const all = await app.inject({ method: "GET", url: "/api/holidays?from=2026-01-01&to=2026-12-31&includeInactive=1" });
    const rows = all.json() as Holiday[];
    expect(rows.map((h) => h.date)).toEqual(["2026-10-09", "2026-10-28", "2026-12-25"]);
    expect(rows[0]).toMatchObject({ name: "한글날", kind: "public", source: "auto", active: false });
    expect(rows[1]).toMatchObject({ kind: "center", source: "manual", active: true });

    const bad = await app.inject({ method: "GET", url: "/api/holidays?from=2026-13-01" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("POST /api/holidays", () => {
  it("수동 등록 + 지나지 않은 휴가원 재계산 + 변경 이력", async () => {
    const { app, db, future, past } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/holidays",
      payload: { date: "2026-10-28", name: " 체육대회 ", kind: "center" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as HolidayChangeResult;
    expect(body.holiday).toMatchObject({ date: "2026-10-28", name: "체육대회", kind: "center", source: "manual", active: true });
    expect(body.recalculated).toHaveLength(1);
    expect(body.recalculated[0]).toMatchObject({
      requestId: future,
      employeeName: "홍길동",
      leaveTypeName: "연차",
      beforeMinutes: 2400,
      afterMinutes: 1920,
    });
    expect(itemMinutes(db, future)).toBe(1920);
    expect(itemMinutes(db, past)).toBe(2400);

    const audit = queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'holiday'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "create", entity_id: body.holiday!.id, at: "2026-10-19 09:00:00" });
    expect(String(audit[0]!.summary)).toContain("센터 휴무일 2026.10.28. 체육대회 추가");
    const recalc = queryAll(db, "SELECT * FROM audit_logs WHERE action = 'recalculate'");
    expect(recalc).toHaveLength(1);
    expect(String(recalc[0]!.summary)).toContain("센터 휴무일 2026.10.28. 체육대회 추가");
  });

  it("영향받는 휴가원이 없으면 recalculated 는 빈 배열", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/holidays",
      payload: { date: "2026-11-02", name: "임시공휴일", kind: "public" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recalculated).toEqual([]);
  });

  it("입력 오류 400, 이미 있는 항목 409", async () => {
    const { app, db } = await setup();
    const noName = await app.inject({ method: "POST", url: "/api/holidays", payload: { date: "2026-10-28", name: " ", kind: "center" } });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toBe("이름을 입력하세요.");
    const badDate = await app.inject({ method: "POST", url: "/api/holidays", payload: { date: "2026-02-30", name: "x", kind: "center" } });
    expect(badDate.statusCode).toBe(400);
    const badKind = await app.inject({ method: "POST", url: "/api/holidays", payload: { date: "2026-10-28", name: "x", kind: "etc" } });
    expect(badKind.statusCode).toBe(400);

    insertHoliday(db, { date: "2026-10-28", name: "체육대회", kind: "center" });
    const dup = await app.inject({ method: "POST", url: "/api/holidays", payload: { date: "2026-10-28", name: "체육대회", kind: "center" } });
    expect(dup.statusCode).toBe(409);
    expect(queryAll(db, "SELECT * FROM audit_logs")).toEqual([]);
  });

  it("같은 (날짜, 구분, 이름)의 지워진 자동 등록분이 있으면 되살림", async () => {
    const { app, db, future } = await setup();
    const id = insertHoliday(db, { date: "2026-10-28", name: "임시공휴일", kind: "public", source: "auto" });
    execute(db, "UPDATE holidays SET active = 0 WHERE id = ?", [id]);

    const res = await app.inject({
      method: "POST",
      url: "/api/holidays",
      payload: { date: "2026-10-28", name: "임시공휴일", kind: "public" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().holiday).toMatchObject({ id, source: "auto", active: true });
    expect(queryAll(db, "SELECT * FROM holidays")).toHaveLength(1);
    expect(itemMinutes(db, future)).toBe(1920);
    expect(queryOne(db, "SELECT action FROM audit_logs WHERE entity = 'holiday'")).toMatchObject({ action: "restore" });
  });
});

describe("DELETE /api/holidays/:id", () => {
  it("수동 등록분은 행 삭제 + 재계산 + 이력", async () => {
    const { app, db, future } = await setup();
    const id = insertHoliday(db, { date: "2026-10-28", name: "체육대회", kind: "center" });
    execute(db, "UPDATE leave_request_items SET minutes = 1920, minutes_by_year = '{\"2026\":1920}' WHERE request_id = ?", [future]);

    const res = await app.inject({ method: "DELETE", url: `/api/holidays/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HolidayChangeResult;
    expect(body.holiday).toBeNull();
    expect(body.recalculated[0]).toMatchObject({ beforeMinutes: 1920, afterMinutes: 2400 });
    expect(queryAll(db, "SELECT * FROM holidays")).toEqual([]);
    expect(itemMinutes(db, future)).toBe(2400);

    const audit = queryOne(db, "SELECT * FROM audit_logs WHERE entity = 'holiday'");
    expect(audit).toMatchObject({ action: "delete", entity_id: id, after_json: "null" });
    expect(JSON.parse(String(audit!.before_json))).toMatchObject({ date: "2026-10-28", name: "체육대회" });
  });

  it("자동 등록분은 active = 0 (재등록 방지), 다시 지우면 409, 없으면 404", async () => {
    const { app, db } = await setup();
    const id = insertHoliday(db, { date: "2026-10-28", name: "임시공휴일", source: "auto" });

    const res = await app.inject({ method: "DELETE", url: `/api/holidays/${id}` });
    expect(res.statusCode).toBe(200);
    expect(queryOne(db, "SELECT active FROM holidays WHERE id = ?", [id])).toMatchObject({ active: 0 });

    const list = await app.inject({ method: "GET", url: "/api/holidays" });
    expect(list.json()).toEqual([]);

    expect((await app.inject({ method: "DELETE", url: `/api/holidays/${id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/api/holidays/9999" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/holidays/abc" })).statusCode).toBe(400);
  });
});

describe("POST /api/holidays/:id/restore", () => {
  it("지운 자동 등록분 되살리기 + 재계산 + 이력", async () => {
    const { app, db, future } = await setup();
    const id = insertHoliday(db, { date: "2026-10-28", name: "임시공휴일", source: "auto" });
    execute(db, "UPDATE holidays SET active = 0 WHERE id = ?", [id]);

    const res = await app.inject({ method: "POST", url: `/api/holidays/${id}/restore` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HolidayChangeResult;
    expect(body.holiday).toMatchObject({ id, active: true });
    expect(body.recalculated).toHaveLength(1);
    expect(itemMinutes(db, future)).toBe(1920);
    expect(queryOne(db, "SELECT action, entity_id FROM audit_logs WHERE entity = 'holiday'")).toMatchObject({
      action: "restore",
      entity_id: id,
    });

    expect((await app.inject({ method: "POST", url: `/api/holidays/${id}/restore` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/holidays/9999/restore" })).statusCode).toBe(404);
  });
});

describe("POST /api/holidays/sync", () => {
  it("법정공휴일을 등록하고 재계산, 다시 실행하면 추가 없음", async () => {
    const { app, db, emp, type } = await setup();
    // 12/24(목) ~ 12/25(금) 2일 → 성탄절 등록 후 1일
    const xmas = insertLeave(db, emp, type, "2026-12-24T10:00", "2026-12-25T19:00", 960);

    const res = await app.inject({ method: "POST", url: "/api/holidays/sync" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { added: number; recalculated: unknown[] };
    expect(body.added).toBeGreaterThan(50);
    expect(body.recalculated).toHaveLength(1);
    expect(itemMinutes(db, xmas)).toBe(480);
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'holiday' AND action = 'create'")).toHaveLength(1);

    const again = await app.inject({ method: "POST", url: "/api/holidays/sync" });
    expect(again.json()).toEqual({ added: 0, recalculated: [] });
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'holiday'")).toHaveLength(1);
  });
});
