import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkApiRequest, hostnameOf } from "./app.ts";
import { execute, queryAll, transaction, type Db } from "./db/index.ts";
import { getEmployeeBalances } from "./services/balances.ts";
import { byDateJson, computeItemUsage } from "./services/leaveUsage.ts";
import { recalcFutureRequests } from "./services/recalc.ts";
import { createTestApp, insertEmployee, insertGrant, insertHoliday, insertLeaveType } from "./testing.ts";

/**
 * 신청 상태 휴가원 직접 추가 (월~금 10:00~19:00, 항목 minutes 는 2026년 사용으로 저장).
 * 날짜별 사용은 실제 저장처럼 그때의 공휴일로 계산
 */
function insertLeaveRequest(
  db: Db,
  employeeId: number,
  leaveTypeId: number,
  items: { startAt: string; endAt: string; minutes: number }[],
  status = "active",
): number {
  const rid = execute(
    db,
    `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
       status, created_at, updated_at) VALUES (?, '홍길동', '', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', ?, 'x', 'x')`,
    [employeeId, status],
  ).lastInsertRowid;
  for (const i of items) {
    const { byDate } = computeItemUsage(db, i.startAt, i.endAt, { workDays: [1, 2, 3, 4, 5], workStart: "10:00", workEnd: "19:00" });
    execute(
      db,
      `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year, minutes_by_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [rid, leaveTypeId, i.startAt, i.endAt, i.minutes, JSON.stringify({ "2026": i.minutes }), byDateJson(byDate)],
    );
  }
  return rid;
}

describe("기반", () => {
  it("처음 설치 시 휴가 종류·직원은 비어 있음", async () => {
    const { db } = await createTestApp();
    expect(queryAll(db, "SELECT * FROM leave_types")).toEqual([]);
    expect(queryAll(db, "SELECT * FROM employees")).toEqual([]);
  });

  it("health", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "0.0.0-test" });
  });

  it("없는 API는 404 JSON", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });

  it("트랜잭션 중첩·되돌림", async () => {
    const { db } = await createTestApp();
    expect(() =>
      transaction(db, () => {
        insertLeaveType(db, { name: "A" });
        transaction(db, () => insertLeaveType(db, { name: "B" }));
        throw new Error("x");
      }),
    ).toThrow();
    expect(queryAll(db, "SELECT * FROM leave_types")).toEqual([]);
  });

  it("잔여량: 부여 − 사용 (취소된 휴가원 제외)", async () => {
    const { app, db } = await createTestApp();
    const emp = insertEmployee(db);
    const annual = insertLeaveType(db, { name: "연차" });
    insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", minutes: 15 * 480 });
    const item = { startAt: "2026-10-01T10:00", endAt: "2026-10-01T19:00", minutes: 480 };
    insertLeaveRequest(db, emp, annual, [item]);
    insertLeaveRequest(db, emp, annual, [item], "cancelled");
    const rows = getEmployeeBalances(db, emp, 2026);
    expect(rows[0]).toMatchObject({ grantedMinutes: 7200, usedMinutes: 480, remainingMinutes: 6720 });

    const res = await app.inject({ method: "GET", url: `/api/balances?employeeId=${emp}&year=2026` });
    expect(res.json()[0].remainingMinutes).toBe(6720);
  });

  it("기존 잔여량 기준일자 이전의 휴가원·부여는 다시 더하지 않음", async () => {
    const { app, db } = await createTestApp();
    const emp = insertEmployee(db);
    const annual = insertLeaveType(db, { name: "연차" });
    // 2026년 총 15일, 기준일자 10-19(월) 현재 잔여 10일 → 기존 사용 5일
    execute(
      db,
      `INSERT INTO opening_balances (employee_id, leave_type_id, year, base_date, total_granted_minutes, remaining_minutes,
         used_minutes, created_at, updated_at) VALUES (?, ?, 2026, '2026-10-19', 7200, 4800, 2400, 'x', 'x')`,
      [emp, annual],
    );
    const balance = () => getEmployeeBalances(db, emp, 2026)[0]!;
    expect(balance()).toMatchObject({ grantedMinutes: 7200, usedMinutes: 2400, remainingMinutes: 4800 });

    // 기준일자 전 휴가원 (종이 장부의 5일에 이미 포함)
    insertLeaveRequest(db, emp, annual, [{ startAt: "2026-10-05T10:00", endAt: "2026-10-05T19:00", minutes: 480 }]);
    expect(balance()).toMatchObject({ usedMinutes: 2400, remainingMinutes: 4800 });

    // 기준일자 후 휴가원
    insertLeaveRequest(db, emp, annual, [{ startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00", minutes: 480 }]);
    expect(balance()).toMatchObject({ usedMinutes: 2880, remainingMinutes: 4320 });

    // 기준일자에 걸친 휴가원 10-16(금) ~ 10-20(화): 10-20 하루만 더함
    insertLeaveRequest(db, emp, annual, [{ startAt: "2026-10-16T10:00", endAt: "2026-10-20T19:00", minutes: 1440 }]);
    expect(balance()).toMatchObject({ usedMinutes: 3360, remainingMinutes: 3840 });

    // 기준일자까지의 부여는 총 부여량에 포함, 이후 부여만 더함
    insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-03-01", minutes: 480 });
    insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-10-27", minutes: 480 });
    expect(balance()).toMatchObject({ grantedMinutes: 7680, usedMinutes: 3360, remainingMinutes: 4320 });

    const res = await app.inject({ method: "GET", url: `/api/balances?employeeId=${emp}&year=2026` });
    expect(res.json()[0]).toMatchObject({ usedMinutes: 3360, remainingMinutes: 4320 });
  });

  it("공휴일 추가 후 재계산: 지나지 않은 신청 상태 휴가원만", async () => {
    const { db } = await createTestApp();
    const emp = insertEmployee(db);
    const annual = insertLeaveType(db);
    const addReq = (start: string, end: string, minutes: number, status = "active") =>
      insertLeaveRequest(db, emp, annual, [{ startAt: start, endAt: end, minutes }], status);
    const past = addReq("2026-10-12T10:00", "2026-10-16T19:00", 2400);
    const future = addReq("2026-10-26T10:00", "2026-10-30T19:00", 2400);
    const cancelled = addReq("2026-10-26T10:00", "2026-10-27T19:00", 960, "cancelled");
    insertHoliday(db, { date: "2026-10-14", name: "휴무" });
    insertHoliday(db, { date: "2026-10-28", name: "휴무", kind: "center" });

    const changes = recalcFutureRequests(db, "2026-10-19", "127.0.0.1", "테스트", "2026-10-19 09:00:00");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ requestId: future, beforeMinutes: 2400, afterMinutes: 1920 });
    const minutes = (rid: number) =>
      Number(queryAll<{ minutes: number }>(db, "SELECT minutes FROM leave_request_items WHERE request_id = ?", [rid])[0]!.minutes);
    expect(minutes(past)).toBe(2400);
    expect(minutes(cancelled)).toBe(960);
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE action = 'recalculate'")).toHaveLength(1);
  });

  it("재계산 대상은 휴가원 종료일 기준: 아직 끝나지 않은 휴가원의 지난 항목도 다시 계산", async () => {
    const { db } = await createTestApp();
    const emp = insertEmployee(db);
    const annual = insertLeaveType(db);
    const rid = insertLeaveRequest(db, emp, annual, [
      { startAt: "2026-10-16T10:00", endAt: "2026-10-16T19:00", minutes: 480 },
      { startAt: "2026-10-28T10:00", endAt: "2026-10-28T15:00", minutes: 240 },
    ]);
    insertHoliday(db, { date: "2026-10-16", name: "긴급 휴무", kind: "center" });

    const changes = recalcFutureRequests(db, "2026-10-19", "127.0.0.1", "테스트", "2026-10-19 09:00:00");
    expect(changes).toEqual([
      expect.objectContaining({ requestId: rid, startAt: "2026-10-16T10:00", beforeMinutes: 480, afterMinutes: 0 }),
    ]);
    const items = queryAll<{ minutes: number }>(
      db,
      "SELECT minutes FROM leave_request_items WHERE request_id = ? ORDER BY start_at",
      [rid],
    );
    expect(items.map((i) => Number(i.minutes))).toEqual([0, 240]);
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE action = 'recalculate' AND entity_id = ?", [rid])).toHaveLength(1);
  });

  it("지난 날짜에 휴무일을 추가해도 지난 휴가의 잔여 사용은 휴가원과 같음 (소멸일·기간 종류 포함)", async () => {
    const t = await createTestApp();
    const { app, db } = t;
    t.setToday("2026-10-05");
    const emp = insertEmployee(db);
    const yearly = insertLeaveType(db, { name: "연차", sortOrder: 1 });
    const expiring = insertLeaveType(db, { name: "연가(소멸일)", sortOrder: 2 });
    const period = insertLeaveType(db, { name: "보상휴가(기간)", sortOrder: 3 });
    execute(db, "UPDATE leave_types SET balance_mode = 'expire_date', expire_month = 12, expire_day = 31 WHERE id = ?", [expiring]);
    execute(db, "UPDATE leave_types SET balance_mode = 'grant_period', valid_months = 12 WHERE id = ?", [period]);
    for (const id of [yearly, expiring, period]) {
      insertGrant(db, { employeeId: emp, leaveTypeId: id, grantDate: "2026-01-01", minutes: 5 * 480 });
    }
    const save = async (leaveTypeId: number, day: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/leave-requests",
        payload: {
          employeeId: emp,
          items: [{ leaveTypeId, startAt: `${day}T10:00`, endAt: `${day}T19:00` }],
          reason: "개인 사유",
          emergencyContact: "010-1234-5678",
          handoverNote: "",
        },
      });
      expect(res.statusCode).toBe(201);
    };
    await save(yearly, "2026-10-06");
    await save(expiring, "2026-10-07");
    await save(period, "2026-10-08");
    await save(expiring, "2026-10-26");

    // 10/6~10/8 휴가가 끝난 뒤 그 날들과 아직 오지 않은 10/26 에 휴무일 추가
    t.setToday("2026-10-20");
    for (const date of ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-26"]) {
      const res = await app.inject({ method: "POST", url: "/api/holidays", payload: { date, name: "센터 휴무", kind: "center" } });
      expect(res.statusCode).toBe(201);
    }
    // 지난 휴가는 다시 계산하지 않음, 아직 끝나지 않은 10/26 은 0분으로 다시 계산 (날짜별도 함께)
    const items = queryAll<{ minutes: number; minutes_by_date: string }>(
      db,
      "SELECT minutes, minutes_by_date FROM leave_request_items ORDER BY start_at",
    );
    expect(items.map((i) => [Number(i.minutes), i.minutes_by_date])).toEqual([
      [480, '{"2026-10-06":480}'],
      [480, '{"2026-10-07":480}'],
      [480, '{"2026-10-08":480}'],
      [0, "{}"],
    ]);
    // 잔여의 사용도 휴가원과 같음
    const used = (typeId: number) => getEmployeeBalances(db, emp, 2026).find((b) => b.leaveTypeId === typeId)!.usedMinutes;
    expect([used(yearly), used(expiring), used(period)]).toEqual([480, 480, 480]);
  });
});

describe("다른 사이트·주소에서 온 API 요청 차단", () => {
  const LAN = "192.168.100.23:8080";
  const workHours = { defaultWorkStart: "09:00", defaultWorkEnd: "18:00" };

  it("다른 사이트의 text/plain 폼 전송은 403, 휴가원은 그대로", async () => {
    const { app, db } = await createTestApp();
    const emp = insertEmployee(db);
    const annual = insertLeaveType(db);
    const rid = insertLeaveRequest(db, emp, annual, [
      { startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00", minutes: 480 },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/leave-requests/${rid}/cancel`,
      headers: { host: LAN, origin: "http://evil.example", "content-type": "text/plain" },
      payload: "x=1",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("다른 사이트에서 보낸 요청은 처리하지 않습니다.");
    const status = queryAll<{ status: string }>(db, "SELECT status FROM leave_requests WHERE id = ?", [rid])[0]!.status;
    expect(status).toBe("active");
  });

  it("Origin 이 null 이거나 다르면 본문 없는 POST 도 403", async () => {
    const { app } = await createTestApp();
    for (const origin of ["null", "http://192.168.100.23:9999", "not a url"]) {
      const res = await app.inject({ method: "POST", url: "/api/backups", headers: { host: LAN, origin } });
      expect(res.statusCode, origin).toBe(403);
    }
  });

  it("Origin 이 없어도 JSON 이 아닌 본문은 415", async () => {
    const { app } = await createTestApp();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { host: LAN, "content-type": contentType },
        payload: JSON.stringify(workHours),
      });
      expect(res.statusCode, contentType).toBe(415);
      expect(res.json().error).toBe("요청 형식이 올바르지 않습니다.");
    }
  });

  it("허용되지 않은 Host(DNS 리바인딩)는 조회도 403", async () => {
    const { app } = await createTestApp();
    for (const host of ["evil.example", "evil.example:8080", "attacker.lan."]) {
      const res = await app.inject({ method: "GET", url: "/api/health", headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.json().error).toContain("출결 PC의 IP 주소");
    }
  });

  it("같은 주소에서 보낸 JSON 요청은 처리", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { host: LAN, origin: `http://${LAN}`, "content-type": "application/json; charset=utf-8" },
      payload: JSON.stringify(workHours),
    });
    expect(res.statusCode).toBe(200);
    // 개발 중 Vite 프록시 (Host·Origin 모두 localhost:5173)
    const dev = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { host: "localhost:5173", origin: "http://localhost:5173" },
      payload: workHours,
    });
    expect(dev.statusCode).toBe(200);
  });

  it("config allowedHosts 에 넣은 이름은 허용", async () => {
    const { app } = await createTestApp({ config: { allowedHosts: ["leave.office.lan"] } });
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "LEAVE.office.lan:8080" } });
    expect(res.statusCode).toBe(200);
  });

  it("호스트 이름 판별", () => {
    expect(hostnameOf("192.168.100.23:8080")).toBe("192.168.100.23");
    expect(hostnameOf("[::1]:8080")).toBe("::1");
    expect(hostnameOf("LocalHost")).toBe("localhost");
    const allowed = new Set<string>([os.hostname().toLowerCase()]);
    const get = (host: string) => checkApiRequest({ method: "GET", headers: { host } }, allowed);
    expect(get("[::1]:8080")).toBeNull();
    expect(get("127.0.0.1")).toBeNull();
    expect(get("localhost:8080")).toBeNull();
    expect(get(`${os.hostname()}:8080`)).toBeNull();
    expect(get("localhost.evil.example")).toMatchObject({ status: 403 });
  });
});

describe("클릭재킹·형식 추측 방지 헤더", () => {
  it("API·거절·없는 주소·화면 파일·화면 주소 모두 iframe 금지 + nosniff", async () => {
    const webDir = mkdtempSync(path.join(os.tmpdir(), "leave-flow-web-"));
    mkdirSync(path.join(webDir, "assets"));
    writeFileSync(path.join(webDir, "index.html"), "<html></html>");
    writeFileSync(path.join(webDir, "assets", "app.js"), "1");
    const { app } = await createTestApp({ config: { webDir } });
    const responses = await Promise.all([
      app.inject({ url: "/api/health" }),
      app.inject({ url: "/api/health", headers: { host: "evil.example" } }),
      app.inject({ url: "/api/nothing" }),
      app.inject({ url: "/assets/app.js" }),
      app.inject({ url: "/calendar" }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 403, 404, 200, 200]);
    for (const res of responses) {
      expect(res.headers).toMatchObject({
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
    }
  });
});
