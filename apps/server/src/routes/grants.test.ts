import { describe, expect, it } from "vitest";
import { execute, queryAll, type Db } from "../db/index.ts";
import { getEmployeeBalances } from "../services/balances.ts";
import { createTestApp, insertEmployee, insertGrant, insertLeaveType } from "../testing.ts";

const audits = (db: Db) =>
  queryAll<{ action: string; summary: string; employee_id: number | null }>(
    db,
    "SELECT * FROM audit_logs WHERE entity = 'leave_grant' ORDER BY id",
  );

/** 시간외근무 신청서로 적립된 부여 (직접 넣기) */
function insertOvertimeGrant(db: Db, employeeId: number, leaveTypeId: number): number {
  const otId = execute(
    db,
    `INSERT INTO overtime_requests (kind, work_start_at, work_end_at, minutes, category, submitted_on, created_at, updated_at)
     VALUES ('general', '2026-10-01T19:00', '2026-10-01T21:30', 150, 'special_work', '2026-10-02', 'x', 'x')`,
  ).lastInsertRowid;
  execute(
    db,
    `INSERT INTO overtime_targets (overtime_request_id, employee_id, employee_name, minutes, leave_type_id)
     VALUES (?, ?, '홍길동', 150, ?)`,
    [otId, employeeId, leaveTypeId],
  );
  return execute(
    db,
    `INSERT INTO leave_grants (employee_id, leave_type_id, grant_date, minutes, note, source, overtime_request_id,
       created_at, updated_at)
     VALUES (?, ?, '2026-10-02', 150, '', 'overtime', ?, 'x', 'x')`,
    [employeeId, leaveTypeId, otId],
  ).lastInsertRowid;
}

async function setup() {
  const t = await createTestApp();
  const emp = insertEmployee(t.db, { name: "홍길동" });
  const annual = insertLeaveType(t.db, { name: "연차" });
  const comp = insertLeaveType(t.db, { name: "대체휴가", balanceMode: "cumulative" });
  return { ...t, emp, annual, comp };
}

describe("부여 내역 API", () => {
  it("추가: 일 × 그 직원의 하루 근무시간 + 시간 × 60 분으로 저장, 201, 이력, 잔여에 반영", async () => {
    const { app, db, emp, annual, comp } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/grants",
      payload: { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", days: 15, hours: 0, note: "2026년 연차" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      employeeId: emp,
      leaveTypeId: annual,
      grantDate: "2026-01-01",
      minutes: 15 * 480,
      note: "2026년 연차",
      source: "manual",
      overtimeRequestId: null,
    });
    const hour = await app.inject({
      method: "POST",
      url: "/api/grants",
      payload: { employeeId: emp, leaveTypeId: comp, grantDate: "2026-03-01", days: 0, hours: 3, note: "" },
    });
    expect(hour.json().minutes).toBe(180);

    const log = audits(db);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ action: "create", employee_id: emp });
    expect(log[0]!.summary).toContain("홍길동 연차");
    expect(getEmployeeBalances(db, emp, 2026).find((b) => b.leaveTypeId === annual)?.grantedMinutes).toBe(7200);
  });

  it("목록 필터(직원·종류·연도)와 부여일 내림차순", async () => {
    const { app, db, emp, annual, comp } = await setup();
    const other = insertEmployee(db, { name: "김철수" });
    insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2025-01-01", minutes: 480 });
    insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", minutes: 480 });
    insertGrant(db, { employeeId: emp, leaveTypeId: comp, grantDate: "2026-05-01", minutes: 60 });
    insertGrant(db, { employeeId: other, leaveTypeId: annual, grantDate: "2026-02-01", minutes: 480 });
    const dates = async (q: string) =>
      (await app.inject({ method: "GET", url: `/api/grants${q}` })).json().map((g: { grantDate: string }) => g.grantDate);
    expect(await dates("")).toEqual(["2026-05-01", "2026-02-01", "2026-01-01", "2025-01-01"]);
    expect(await dates(`?employeeId=${emp}&year=2026`)).toEqual(["2026-05-01", "2026-01-01"]);
    expect(await dates(`?leaveTypeId=${annual}&year=2026`)).toEqual(["2026-02-01", "2026-01-01"]);
    expect(await dates("?year=2025")).toEqual(["2025-01-01"]);
  });

  it("직원·종류가 없으면 400, 비활성 종류에 새로 부여하면 409, 입력 오류 400", async () => {
    const { app, db, emp, annual } = await setup();
    const inactive = insertLeaveType(db, { name: "옛휴가", active: false });
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/grants",
        payload: { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", days: 0, hours: 1, note: "", ...payload },
      });
    expect((await post({ employeeId: 999 })).statusCode).toBe(400);
    expect((await post({ leaveTypeId: 999 })).statusCode).toBe(400);
    expect((await post({ leaveTypeId: inactive })).statusCode).toBe(409);
    expect((await post({ hours: 1.25 })).statusCode).toBe(400);
    expect((await post({ days: 0, hours: 0 })).statusCode).toBe(400);
    expect((await post({ grantDate: "2026-02-30" })).statusCode).toBe(400);
    expect(audits(db)).toHaveLength(0);
  });

  it("수정: 새 값으로 다시 계산, 비활성이 된 원래 종류는 유지 가능, 다른 비활성 종류로는 409", async () => {
    const { app, db, emp, annual, comp } = await setup();
    const id = insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", minutes: 15 * 480 });
    const put = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PUT",
        url: `/api/grants/${id}`,
        payload: { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-02", days: 16, hours: 0, note: "정정", ...payload },
      });
    const res = await put({});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ grantDate: "2026-01-02", minutes: 16 * 480, note: "정정", updatedAt: "2026-10-19 09:00:00" });
    expect(audits(db)[0]).toMatchObject({ action: "update", employee_id: emp });

    expect((await put({ leaveTypeId: comp, days: 0, hours: 5 })).json().minutes).toBe(300);

    execute(db, "UPDATE leave_types SET active = 0 WHERE id = ?", [comp]);
    expect((await put({ leaveTypeId: comp, days: 0, hours: 6 })).statusCode).toBe(200);
    expect((await put({ leaveTypeId: annual })).statusCode).toBe(200);
    expect((await put({ leaveTypeId: comp })).statusCode).toBe(409);

    const missing = await app.inject({
      method: "PUT",
      url: "/api/grants/999",
      payload: { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-02", days: 0, hours: 1, note: "" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("수정: 다른 직원으로 옮기면 400, 부여·잔여·이력은 그대로", async () => {
    const { app, db, emp, annual } = await setup();
    const other = insertEmployee(db, { name: "김철수" });
    const created = await app.inject({
      method: "POST",
      url: "/api/grants",
      payload: { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", days: 15, hours: 0, note: "" },
    });
    const id = created.json().id as number;

    const res = await app.inject({
      method: "PUT",
      url: `/api/grants/${id}`,
      payload: { employeeId: other, leaveTypeId: annual, grantDate: "2026-01-01", days: 15, hours: 0, note: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("부여 내역의 직원은 바꿀 수 없습니다. 삭제 후 새로 추가하세요.");
    expect(queryAll(db, "SELECT employee_id FROM leave_grants")).toEqual([{ employee_id: emp }]);
    expect(getEmployeeBalances(db, emp, 2026).find((b) => b.leaveTypeId === annual)?.grantedMinutes).toBe(15 * 480);
    expect(getEmployeeBalances(db, other, 2026).find((b) => b.leaveTypeId === annual)?.grantedMinutes ?? 0).toBe(0);
    expect(audits(db)).toMatchObject([{ action: "create", employee_id: emp }]);

    // 같은 직원이면 수정되고 이력도 그 직원으로 남음
    const ok = await app.inject({
      method: "PUT",
      url: `/api/grants/${id}`,
      payload: { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", days: 16, hours: 0, note: "" },
    });
    expect(ok.statusCode).toBe(200);
    expect(audits(db)[1]).toMatchObject({ action: "update", employee_id: emp });
  });

  it("삭제: 204 + 이력, 잔여에서 빠짐, 없으면 404", async () => {
    const { app, db, emp, annual } = await setup();
    const id = insertGrant(db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", minutes: 480 });
    const res = await app.inject({ method: "DELETE", url: `/api/grants/${id}` });
    expect(res.statusCode).toBe(204);
    expect(queryAll(db, "SELECT * FROM leave_grants")).toEqual([]);
    expect(audits(db)).toMatchObject([{ action: "delete", employee_id: emp }]);
    expect(getEmployeeBalances(db, emp, 2026)[0]!.grantedMinutes).toBe(0);
    expect((await app.inject({ method: "DELETE", url: `/api/grants/${id}` })).statusCode).toBe(404);
  });

  it("시간외근무로 적립된 부여는 수정·삭제 409", async () => {
    const { app, db, emp, comp } = await setup();
    const id = insertOvertimeGrant(db, emp, comp);
    const list = (await app.inject({ method: "GET", url: `/api/grants?employeeId=${emp}` })).json();
    expect(list[0]).toMatchObject({ source: "overtime", minutes: 150 });
    expect(list[0].overtimeRequestId).toBeGreaterThan(0);

    const message = "시간외근무 신청서로 적립된 부여는 시간외근무 화면에서 수정하세요.";
    const put = await app.inject({
      method: "PUT",
      url: `/api/grants/${id}`,
      payload: { employeeId: emp, leaveTypeId: comp, grantDate: "2026-10-02", days: 0, hours: 3, note: "" },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error).toBe(message);
    const del = await app.inject({ method: "DELETE", url: `/api/grants/${id}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe(message);
    expect(queryAll(db, "SELECT * FROM leave_grants")).toHaveLength(1);
    expect(audits(db)).toHaveLength(0);
  });
});
