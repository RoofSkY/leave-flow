import { describe, expect, it } from "vitest";
import type { UsageReport } from "@leave-flow/shared";
import { execute, type Db } from "../db/index.ts";
import { createTestApp, insertEmployee, insertGrant, insertLeaveType } from "../testing.ts";

function insertLeave(
  db: Db,
  employeeId: number,
  leaveTypeId: number,
  minutesByYear: Record<string, number>,
  status: "active" | "cancelled" = "active",
) {
  const rid = execute(
    db,
    `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
       status, created_at, updated_at) VALUES (?, 'x', '', '2026-01-01', '[1,2,3,4,5]', '10:00', '19:00', ?, 'x', 'x')`,
    [employeeId, status],
  ).lastInsertRowid;
  const minutes = Object.values(minutesByYear).reduce((s, m) => s + m, 0);
  execute(
    db,
    `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year)
     VALUES (?, ?, '2026-03-02T10:00', '2026-03-02T19:00', ?, ?)`,
    [rid, leaveTypeId, minutes, JSON.stringify(minutesByYear)],
  );
}

describe("GET /api/usage", () => {
  it("직원별 활성 휴가 종류의 부여·사용·잔여", async () => {
    const { app, db } = await createTestApp();
    const kim = insertEmployee(db, { name: "김철수" });
    const hong = insertEmployee(db, { name: "홍길동" });
    const annual = insertLeaveType(db, { name: "연차", sortOrder: 1 });
    const official = insertLeaveType(db, { name: "공가", deducts: false, sortOrder: 2 });
    const comp = insertLeaveType(db, { name: "대체", balanceMode: "cumulative", sortOrder: 0 });
    insertLeaveType(db, { name: "옛 종류", active: false });

    insertGrant(db, { employeeId: hong, leaveTypeId: annual, grantDate: "2026-01-01", minutes: 15 * 480 });
    insertGrant(db, { employeeId: hong, leaveTypeId: annual, grantDate: "2025-01-01", minutes: 15 * 480 });
    insertGrant(db, { employeeId: hong, leaveTypeId: comp, grantDate: "2025-06-01", minutes: 180 });
    insertGrant(db, { employeeId: hong, leaveTypeId: comp, grantDate: "2026-06-01", minutes: 120 });
    insertLeave(db, hong, annual, { "2026": 960 });
    insertLeave(db, hong, annual, { "2026": 480 }, "cancelled");
    insertLeave(db, hong, official, { "2026": 240 });
    insertLeave(db, hong, comp, { "2026": 400 });

    const res = await app.inject({ method: "GET", url: "/api/usage?year=2026" });
    expect(res.statusCode).toBe(200);
    const report = res.json() as UsageReport;
    expect(report.year).toBe(2026);
    expect(report.leaveTypes.map((t) => t.name)).toEqual(["대체", "연차", "공가"]);
    expect(report.rows.map((r) => r.employee.name)).toEqual(["김철수", "홍길동"]);

    const hongRow = report.rows.find((r) => r.employee.id === hong)!;
    expect(hongRow.balances.map((b) => b.leaveTypeId)).toEqual([comp, annual, official]);
    expect(hongRow.balances[0]).toMatchObject({ grantedMinutes: 300, usedMinutes: 400, remainingMinutes: -100 });
    expect(hongRow.balances[1]).toMatchObject({ grantedMinutes: 7200, usedMinutes: 960, remainingMinutes: 6240 });
    expect(hongRow.balances[2]).toMatchObject({ grantedMinutes: 0, usedMinutes: 240, remainingMinutes: null });

    const kimRow = report.rows.find((r) => r.employee.id === kim)!;
    expect(kimRow.balances.every((b) => b.grantedMinutes === 0 && b.usedMinutes === 0)).toBe(true);
  });

  it("비활성 직원은 그 해 부여·기존 잔여·사용 기록이 있을 때만 포함", async () => {
    const { app, db } = await createTestApp();
    const type = insertLeaveType(db);
    insertEmployee(db, { name: "기록없음", active: false });
    const otherYear = insertEmployee(db, { name: "작년기록", active: false });
    const granted = insertEmployee(db, { name: "부여", active: false });
    const opening = insertEmployee(db, { name: "기존잔여", active: false });
    const used = insertEmployee(db, { name: "사용", active: false });
    const cancelledOnly = insertEmployee(db, { name: "취소만", active: false });
    const active = insertEmployee(db, { name: "재직" });

    insertGrant(db, { employeeId: otherYear, leaveTypeId: type, grantDate: "2025-01-01", minutes: 480 });
    insertLeave(db, otherYear, type, { "2025": 480 });
    insertGrant(db, { employeeId: granted, leaveTypeId: type, grantDate: "2026-03-01", minutes: 480 });
    execute(
      db,
      `INSERT INTO opening_balances (employee_id, leave_type_id, year, base_date, total_granted_minutes, remaining_minutes,
         used_minutes, created_at, updated_at) VALUES (?, ?, 2026, '2026-01-01', 7200, 4800, 2400, 'x', 'x')`,
      [opening, type],
    );
    insertLeave(db, used, type, { "2025": 480, "2026": 480 });
    insertLeave(db, cancelledOnly, type, { "2026": 480 }, "cancelled");

    const res = await app.inject({ method: "GET", url: "/api/usage?year=2026" });
    const ids = (res.json() as UsageReport).rows.map((r) => r.employee.id);
    expect(ids.sort()).toEqual([granted, opening, used, active].sort());

    const res2025 = await app.inject({ method: "GET", url: "/api/usage?year=2025" });
    const ids2025 = (res2025.json() as UsageReport).rows.map((r) => r.employee.id);
    expect(ids2025.sort()).toEqual([otherYear, used, active].sort());
  });

  it("연도 기본값은 올해, 잘못된 연도는 400, 종류·직원이 없으면 빈 목록", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/usage" });
    expect(res.json()).toEqual({ year: 2026, leaveTypes: [], rows: [] });
    expect((await app.inject({ method: "GET", url: "/api/usage?year=abc" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/usage?year=1800" })).statusCode).toBe(400);
  });
});
