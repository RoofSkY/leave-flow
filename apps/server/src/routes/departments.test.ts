import { describe, expect, it } from "vitest";
import { queryAll, queryOne } from "../db/index.ts";
import { createTestApp, insertDepartment, insertEmployee, insertGrant, insertLeaveType } from "../testing.ts";

const employeeBody = (department: string) => ({
  name: "홍길동",
  department,
  color: "#4f7cff",
  workDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  emergencyContact: "010-1234-5678",
  approvalRoles: ["담당", "센터장"],
  category: "",
});

describe("소속 API", () => {
  it("추가·목록(표시 순서)·중복 이름 409·변경 이력", async () => {
    const { app, db } = await createTestApp();
    const add = (name: string, sortOrder: number) =>
      app.inject({ method: "POST", url: "/api/departments", payload: { name, sortOrder } });
    expect((await add("지원사업부", 2)).statusCode).toBe(201);
    expect((await add("아동사업부", 1)).statusCode).toBe(201);
    const dup = await add("아동사업부", 3);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toContain("이미 있습니다");
    const list = (await app.inject({ method: "GET", url: "/api/departments" })).json();
    expect(list.map((d: { name: string }) => d.name)).toEqual(["아동사업부", "지원사업부"]);
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'department'")).toHaveLength(2);
    const empty = await add("  ", 0);
    expect(empty.statusCode).toBe(400);
  });

  it("이름을 바꾸면 그 소속 직원도 함께 바뀌고, 이미 쓴 휴가원 소속은 그대로", async () => {
    const { app, db } = await createTestApp();
    const id = insertDepartment(db, "아동사업부");
    const emp = insertEmployee(db, { department: "아동사업부" });
    insertEmployee(db, { name: "김영희", department: "지원사업부" });
    db.prepare(
      `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
         created_at, updated_at) VALUES (?, '홍길동', '아동사업부', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', 'x', 'x')`,
    ).run(emp);

    const res = await app.inject({
      method: "PUT",
      url: `/api/departments/${id}`,
      payload: { name: "아동복지부", sortOrder: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "아동복지부", employeeCount: 1 });
    expect(queryOne<{ department: string }>(db, "SELECT department FROM employees WHERE id = ?", [emp])!.department).toBe(
      "아동복지부",
    );
    expect(queryOne<{ department: string }>(db, "SELECT department FROM leave_requests")!.department).toBe("아동사업부");
    const log = queryOne<{ summary: string }>(db, "SELECT summary FROM audit_logs WHERE entity = 'department'");
    expect(log!.summary).toContain("직원 1명");
  });

  it("직원이 있는 소속은 삭제 409, 없으면 204", async () => {
    const { app, db } = await createTestApp();
    const used = insertDepartment(db, "아동사업부");
    const unused = insertDepartment(db, "옛부서");
    insertEmployee(db, { department: "아동사업부", active: false });
    const blocked = await app.inject({ method: "DELETE", url: `/api/departments/${used}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("1명");
    expect((await app.inject({ method: "DELETE", url: `/api/departments/${unused}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/departments/${unused}` })).statusCode).toBe(404);
  });

  it("직원 소속은 비우거나 소속 목록에 있어야 함 (수정 시 원래 소속은 유지 가능)", async () => {
    const { app, db } = await createTestApp();
    insertDepartment(db, "아동사업부");
    const bad = await app.inject({ method: "POST", url: "/api/employees", payload: employeeBody("없는부서") });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("소속 목록에 없습니다");
    expect((await app.inject({ method: "POST", url: "/api/employees", payload: employeeBody("") })).statusCode).toBe(201);
    expect(
      (await app.inject({ method: "POST", url: "/api/employees", payload: employeeBody("아동사업부") })).statusCode,
    ).toBe(201);

    // 목록에 없는 옛 소속을 가진 직원도 다른 항목은 고칠 수 있음
    const legacy = insertEmployee(db, { department: "옛부서" });
    const keep = await app.inject({
      method: "PUT",
      url: `/api/employees/${legacy}`,
      payload: { ...employeeBody("옛부서"), name: "이름변경" },
    });
    expect(keep.statusCode).toBe(200);
  });
});

describe("근무시간 기본값 설정", () => {
  it("기본 09:00~18:00, 저장하면 바뀜", async () => {
    const { app, db } = await createTestApp();
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({
      defaultWorkStart: "09:00",
      defaultWorkEnd: "18:00",
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { defaultWorkStart: "10:00", defaultWorkEnd: "19:00" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      defaultWorkStart: "10:00",
      defaultWorkEnd: "19:00",
    });
    const log = queryAll<{ summary: string }>(db, "SELECT summary FROM audit_logs WHERE entity = 'settings' ORDER BY id");
    expect(log.at(-1)!.summary).toContain("근무시간 기본값 10:00~19:00");
  });

  it("잘못된 근무시간 기본값은 400", async () => {
    const { app } = await createTestApp();
    const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", payload });
    expect((await put({ defaultWorkStart: "19:00", defaultWorkEnd: "10:00" })).statusCode).toBe(400);
    expect((await put({ defaultWorkStart: "12:00", defaultWorkEnd: "13:00" })).statusCode).toBe(400);
    expect((await put({ defaultWorkStart: "09:05", defaultWorkEnd: "18:00" })).statusCode).toBe(400);
    expect((await put({ defaultWorkStart: "09:00" })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });
});

describe("여러 직원 일괄 부여", () => {
  it("직원마다 부여 1건 + 변경 이력, 잔여에 반영", async () => {
    const { app, db } = await createTestApp();
    const a = insertEmployee(db, { name: "홍길동" });
    const b = insertEmployee(db, { name: "김영희" });
    const annual = insertLeaveType(db, { name: "연차" });
    const res = await app.inject({
      method: "POST",
      url: "/api/grants/bulk",
      payload: { employeeIds: [a, b], leaveTypeId: annual, grantDate: "2026-01-01", days: 15, hours: 0, note: "2026년 연차" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveLength(2);
    expect(res.json().map((g: { employeeId: number; minutes: number }) => [g.employeeId, g.minutes])).toEqual([
      [a, 7200],
      [b, 7200],
    ]);
    const logs = queryAll<{ employee_id: number; summary: string }>(
      db,
      "SELECT employee_id, summary FROM audit_logs WHERE entity = 'leave_grant' ORDER BY id",
    );
    expect(logs.map((l) => l.employee_id)).toEqual([a, b]);
    expect(logs[0]!.summary).toContain("2명 일괄");
    const bal = (await app.inject({ method: "GET", url: `/api/balances?employeeId=${b}&year=2026` })).json();
    expect(bal[0].grantedMinutes).toBe(7200);
  });

  it("1일은 직원마다 그 사람의 하루 근무시간 (근무시간이 다른 직원 일괄 부여)", async () => {
    const { app, db } = await createTestApp();
    const full = insertEmployee(db, { name: "홍길동", workStart: "09:00", workEnd: "18:00" }); // 8시간
    const part = insertEmployee(db, { name: "김단시", workStart: "10:00", workEnd: "16:00" }); // 점심 빼고 5시간
    const annual = insertLeaveType(db, { name: "연차" });
    const res = await app.inject({
      method: "POST",
      url: "/api/grants/bulk",
      payload: { employeeIds: [full, part], leaveTypeId: annual, grantDate: "2026-01-01", days: 15, hours: 2, note: "" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().map((g: { minutes: number }) => g.minutes)).toEqual([15 * 480 + 120, 15 * 300 + 120]);
    const logs = queryAll<{ summary: string }>(db, "SELECT summary FROM audit_logs WHERE entity = 'leave_grant' ORDER BY id");
    expect(logs[0]!.summary).toContain("15일 2시간");
    expect(logs[1]!.summary).toContain("15일 2시간");
  });

  it("한 명이라도 문제가 있으면 아무것도 저장하지 않음", async () => {
    const { app, db } = await createTestApp();
    const a = insertEmployee(db);
    const annual = insertLeaveType(db);
    insertGrant(db, { employeeId: a, leaveTypeId: annual, grantDate: "2025-01-01", minutes: 480 });
    const before = queryAll(db, "SELECT * FROM leave_grants").length;
    const missing = await app.inject({
      method: "POST",
      url: "/api/grants/bulk",
      payload: { employeeIds: [a, 999], leaveTypeId: annual, grantDate: "2026-01-01", days: 0, hours: 1, note: "" },
    });
    expect(missing.statusCode).toBe(400);
    const dup = await app.inject({
      method: "POST",
      url: "/api/grants/bulk",
      payload: { employeeIds: [a, a], leaveTypeId: annual, grantDate: "2026-01-01", days: 0, hours: 1, note: "" },
    });
    expect(dup.statusCode).toBe(400);
    const none = await app.inject({
      method: "POST",
      url: "/api/grants/bulk",
      payload: { employeeIds: [], leaveTypeId: annual, grantDate: "2026-01-01", days: 0, hours: 1, note: "" },
    });
    expect(none.json().error).toBe("직원을 한 명 이상 선택하세요.");
    expect(queryAll(db, "SELECT * FROM leave_grants")).toHaveLength(before);
  });
});
