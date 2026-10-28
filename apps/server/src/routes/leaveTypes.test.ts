import { describe, expect, it } from "vitest";
import { execute, queryAll, type Db } from "../db/index.ts";
import {
  createTestApp,
  insertCategory,
  insertDepartment,
  insertEmployee,
  insertGrant,
  insertLeaveType,
} from "../testing.ts";

const body = (over: Record<string, unknown> = {}) => ({
  name: "연차",
  deducts: true,
  balanceMode: "yearly",
  sortOrder: 1,
  ...over,
});

const audits = (db: Db) =>
  queryAll<{ action: string; summary: string }>(db, "SELECT * FROM audit_logs WHERE entity = 'leave_type' ORDER BY id");

describe("휴가 종류 API", () => {
  it("처음에는 비어 있음 → 추가 201 + 변경 이력", async () => {
    const { app, db } = await createTestApp();
    expect((await app.inject({ method: "GET", url: "/api/leave-types" })).json()).toEqual([]);
    const res = await app.inject({
      method: "POST",
      url: "/api/leave-types",
      payload: body({ name: " 대체휴가 ", balanceMode: "cumulative" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: "대체휴가",
      deducts: true,
      balanceMode: "cumulative",
      active: true,
      inUse: false,
    });
    expect(audits(db)).toMatchObject([{ action: "create" }]);
  });

  it("목록: 표시 순서·id 순, 비활성은 includeInactive=1 에서만", async () => {
    const { app, db } = await createTestApp();
    insertLeaveType(db, { name: "병가", sortOrder: 2 });
    insertLeaveType(db, { name: "연차", sortOrder: 1 });
    insertLeaveType(db, { name: "공가", sortOrder: 2, active: false });
    const names = async (url: string) =>
      (await app.inject({ method: "GET", url })).json().map((t: { name: string }) => t.name);
    expect(await names("/api/leave-types")).toEqual(["연차", "병가"]);
    expect(await names("/api/leave-types?includeInactive=1")).toEqual(["연차", "병가", "공가"]);
  });

  it("활성 종류끼리 이름 중복 → 409 (비활성과는 허용)", async () => {
    const { app, db } = await createTestApp();
    insertLeaveType(db, { name: "연차" });
    const old = insertLeaveType(db, { name: "병가", active: false });
    expect((await app.inject({ method: "POST", url: "/api/leave-types", payload: body() })).statusCode).toBe(409);
    const sick = await app.inject({ method: "POST", url: "/api/leave-types", payload: body({ name: "병가" }) });
    expect(sick.statusCode).toBe(201);
    // 같은 이름의 활성 종류가 있으면 비활성 종류를 되살릴 수 없음
    expect((await app.inject({ method: "POST", url: `/api/leave-types/${old}/activate` })).statusCode).toBe(409);
    // 수정으로 다른 활성 종류 이름과 같게 → 409
    const res = await app.inject({ method: "PUT", url: `/api/leave-types/${sick.json().id}`, payload: body() });
    expect(res.statusCode).toBe(409);
  });

  it("소진: 차감하는 종류만", async () => {
    const { app } = await createTestApp();
    const created = await app.inject({ method: "POST", url: "/api/leave-types", payload: body({ balanceMode: "used_up" }) });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ balanceMode: "used_up", deducts: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/leave-types",
      payload: body({ name: "경조휴가", balanceMode: "used_up", deducts: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("소진은 잔여에서 차감하는 종류만 고를 수 있습니다.");
  });

  it("잔여가 없으면 숨김: 소진은 생략하면 켜짐, 다른 방식은 늘 꺼짐, 기록이 있어도 바꿀 수 있음", async () => {
    const { app, db } = await createTestApp();
    const post = async (over: Record<string, unknown>) =>
      (await app.inject({ method: "POST", url: "/api/leave-types", payload: body(over) })).json();
    const usedUp = await post({ name: "경조휴가", balanceMode: "used_up" });
    expect(usedUp.hideWhenEmpty).toBe(true);
    expect((await post({ name: "포상휴가", balanceMode: "used_up", hideWhenEmpty: false })).hideWhenEmpty).toBe(false);
    expect((await post({ name: "연차", hideWhenEmpty: true })).hideWhenEmpty).toBe(false);

    insertGrant(db, { employeeId: insertEmployee(db), leaveTypeId: usedUp.id, grantDate: "2026-01-01", minutes: 480 });
    const res = await app.inject({
      method: "PUT",
      url: `/api/leave-types/${usedUp.id}`,
      payload: body({ name: "경조휴가", balanceMode: "used_up", hideWhenEmpty: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inUse: true, hideWhenEmpty: false });
  });

  it("수정: 기록 없으면 잔여 방식 변경 가능", async () => {
    const { app } = await createTestApp();
    const created = (await app.inject({ method: "POST", url: "/api/leave-types", payload: body() })).json();
    const res = await app.inject({
      method: "PUT",
      url: `/api/leave-types/${created.id}`,
      payload: body({ name: "연가", balanceMode: "cumulative", deducts: false, sortOrder: 5 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "연가", balanceMode: "cumulative", deducts: false, sortOrder: 5 });
    expect((await app.inject({ method: "PUT", url: "/api/leave-types/999", payload: body() })).statusCode).toBe(404);
  });

  it("inUse(부여·사용·기존잔여 기록)면 잔여 방식 변경 409, 이름·차감·순서는 가능", async () => {
    const { app, db } = await createTestApp();
    const emp = insertEmployee(db);
    const byGrant = insertLeaveType(db, { name: "연차" });
    insertGrant(db, { employeeId: emp, leaveTypeId: byGrant, grantDate: "2026-01-01", minutes: 480 });
    const byOpening = insertLeaveType(db, { name: "특별휴가" });
    execute(
      db,
      `INSERT INTO opening_balances (employee_id, leave_type_id, year, base_date, total_granted_minutes, remaining_minutes,
         used_minutes, created_at, updated_at) VALUES (?, ?, 2026, '2026-10-01', 2400, 960, 1440, 'x', 'x')`,
      [emp, byOpening],
    );
    const byUsage = insertLeaveType(db, { name: "병가" });
    const rid = execute(
      db,
      `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
         created_at, updated_at) VALUES (?, '홍길동', '', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', 'x', 'x')`,
      [emp],
    ).lastInsertRowid;
    execute(
      db,
      `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year)
       VALUES (?, ?, '2026-10-01T10:00', '2026-10-01T19:00', 480, '{"2026":480}')`,
      [rid, byUsage],
    );

    for (const [id, name] of [
      [byGrant, "연차"],
      [byOpening, "특별휴가"],
      [byUsage, "병가"],
    ] as const) {
      const get = (await app.inject({ method: "GET", url: "/api/leave-types" })).json();
      expect(get.find((t: { id: number }) => t.id === id).inUse).toBe(true);
      const res = await app.inject({
        method: "PUT",
        url: `/api/leave-types/${id}`,
        payload: body({ name, balanceMode: "cumulative" }),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("부여·사용 기록이 있는 휴가 종류는 잔여 방식(소멸일·기간 포함)을 바꿀 수 없습니다.");
      const ok = await app.inject({
        method: "PUT",
        url: `/api/leave-types/${id}`,
        payload: body({ name: `${name}2`, deducts: false, sortOrder: 9 }),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ name: `${name}2`, deducts: false, sortOrder: 9 });
    }
  });

  it("정한 날짜에 소멸·부여 후 기간: 필요한 값 검사, 다른 방식의 값은 비움, 기록이 생기면 값도 못 바꿈", async () => {
    const { app, db } = await createTestApp();
    const post = (over: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/leave-types", payload: body(over) });

    const fiscal = await post({ name: "특별휴가", balanceMode: "expire_date", expireMonth: 2, expireDay: 28, validMonths: 5 });
    expect(fiscal.statusCode).toBe(201);
    expect(fiscal.json()).toMatchObject({ balanceMode: "expire_date", expireMonth: 2, expireDay: 28, validMonths: null });
    const comp = await post({ name: "대체휴가", balanceMode: "grant_period", validMonths: 6 });
    expect(comp.json()).toMatchObject({ balanceMode: "grant_period", expireMonth: null, validMonths: 6 });
    const yearly = await post({ name: "연차", expireMonth: 3, expireDay: 1 });
    expect(yearly.json()).toMatchObject({ balanceMode: "yearly", expireMonth: null, expireDay: null });

    for (const bad of [
      { balanceMode: "expire_date" },
      { balanceMode: "expire_date", expireMonth: 13, expireDay: 1 },
      { balanceMode: "expire_date", expireMonth: 4, expireDay: 31 },
      { balanceMode: "grant_period" },
      { balanceMode: "grant_period", validMonths: 0 },
      { balanceMode: "grant_period", validMonths: 121 },
    ]) {
      expect((await post({ name: "x", ...bad })).statusCode).toBe(400);
    }

    insertGrant(db, { employeeId: insertEmployee(db), leaveTypeId: comp.json().id, grantDate: "2026-01-01", minutes: 60 });
    const change = await app.inject({
      method: "PUT",
      url: `/api/leave-types/${comp.json().id}`,
      payload: body({ name: "대체휴가", balanceMode: "grant_period", validMonths: 12 }),
    });
    expect(change.statusCode).toBe(409);
  });

  it("비활성화·활성화, 이미 그 상태면 409, 이력 기록", async () => {
    const { app, db } = await createTestApp();
    const id = insertLeaveType(db);
    const off = await app.inject({ method: "POST", url: `/api/leave-types/${id}/deactivate` });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);
    expect((await app.inject({ method: "POST", url: `/api/leave-types/${id}/deactivate` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/leave-types/${id}/activate` })).json().active).toBe(true);
    expect((await app.inject({ method: "POST", url: `/api/leave-types/${id}/activate` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/leave-types/999/deactivate" })).statusCode).toBe(404);
    expect(audits(db).map((l) => l.action)).toEqual(["deactivate", "activate"]);
  });

  it("적용 대상: 소속·구분·직원 저장, 전체로 되돌리기, 입력 검사", async () => {
    const { app, db } = await createTestApp();
    insertDepartment(db, "아동사업부", 1);
    insertDepartment(db, "가족사업부", 2);
    const a = insertEmployee(db, { name: "가" });
    const b = insertEmployee(db, { name: "나" });
    insertCategory(db, "사회복무요원", true);
    insertCategory(db, "계약직");
    const target = (over: object = {}) => ({ departments: [], categories: [], employeeIds: [], ...over });
    const res = await app.inject({
      method: "POST",
      url: "/api/leave-types",
      payload: body({ target: target({ departments: ["아동사업부"], categories: ["계약직", "사회복무요원"], employeeIds: [b, a] }) }),
    });
    expect(res.statusCode).toBe(201);
    // 직원은 오름차순
    expect(res.json().target).toEqual({
      departments: ["아동사업부"],
      categories: ["계약직", "사회복무요원"],
      employeeIds: [a, b],
    });
    const id = res.json().id;
    // 생략하면 전체 직원
    const other = await app.inject({ method: "POST", url: "/api/leave-types", payload: body({ name: "병가" }) });
    expect(other.json().target).toBeNull();
    // 소속만 골라도 됨
    const dept = await app.inject({
      method: "PUT",
      url: `/api/leave-types/${id}`,
      payload: body({ target: { departments: ["가족사업부"] } }),
    });
    expect(dept.json().target).toEqual({ departments: ["가족사업부"], categories: [], employeeIds: [] });
    const all = await app.inject({ method: "PUT", url: `/api/leave-types/${id}`, payload: body({ target: null }) });
    expect(all.json().target).toBeNull();
    expect(queryAll(db, "SELECT * FROM leave_type_employees")).toEqual([]);
    for (const bad of [
      target(),
      target({ employeeIds: [a, a] }),
      target({ employeeIds: [999] }),
      target({ departments: ["없는소속"] }),
      target({ categories: ["없는구분"] }),
    ]) {
      const r = await app.inject({ method: "PUT", url: `/api/leave-types/${id}`, payload: body({ target: bad }) });
      expect(r.statusCode).toBe(400);
    }
    // 실패한 수정은 반영 안 됨
    expect((await app.inject({ method: "GET", url: "/api/leave-types" })).json()[0].target).toBeNull();
  });

  it("입력 오류 400", async () => {
    const { app } = await createTestApp();
    for (const payload of [body({ name: "" }), body({ balanceMode: "x" }), body({ sortOrder: -1 })]) {
      expect((await app.inject({ method: "POST", url: "/api/leave-types", payload })).statusCode).toBe(400);
    }
  });
});
