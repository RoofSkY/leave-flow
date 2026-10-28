import { describe, expect, it } from "vitest";
import { execute, queryAll, type Db } from "../db/index.ts";
import { createTestApp as baseCreateTestApp, insertCategory, insertDepartment, insertEmployee } from "../testing.ts";

/** 직원 소속은 소속 목록에 있어야 하므로 테스트용 소속을 미리 등록 */
async function createTestApp() {
  const t = await baseCreateTestApp();
  insertDepartment(t.db, "아동사업부");
  insertDepartment(t.db, "지원사업부");
  return t;
}

const body = (over: Record<string, unknown> = {}) => ({
  name: "홍길동",
  department: "아동사업부",
  color: "#4F7CFF",
  workDays: [5, 1, 3, 1],
  workStart: "10:00",
  workEnd: "19:00",
  emergencyContact: "010-1234-5678",
  approvalRoles: ["센터장", "담당", "담당"],
  category: "",
  ...over,
});

const audits = (db: Db) =>
  queryAll<{ action: string; summary: string; employee_id: number; at: string }>(
    db,
    "SELECT * FROM audit_logs WHERE entity = 'employee' ORDER BY id",
  );

describe("직원 API", () => {
  it("등록: 201, 요일 정렬·중복 제거, 변경 이력", async () => {
    const { app, db } = await createTestApp();
    const res = await app.inject({ method: "POST", url: "/api/employees", payload: body() });
    expect(res.statusCode).toBe(201);
    const e = res.json();
    expect(e).toMatchObject({
      name: "홍길동",
      color: "#4f7cff",
      workDays: [1, 3, 5],
      workStart: "10:00",
      workEnd: "19:00",
      approvalRoles: ["담당", "센터장"],
      category: "",
      isSocialServiceAgent: false,
      active: true,
      createdAt: "2026-10-19 09:00:00",
    });
    const logs = audits(db);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "create", employee_id: e.id, at: "2026-10-19 09:00:00" });
    expect(logs[0]!.summary).toContain("홍길동");
  });

  it("입력 오류는 400 한국어 메시지", async () => {
    const { app, db } = await createTestApp();
    const cases = [
      body({ name: "  " }),
      body({ workDays: [] }),
      body({ workStart: "19:00", workEnd: "10:00" }),
      body({ workStart: "10:05" }),
      body({ color: "red" }),
      body({ approvalRoles: [] }),
      body({ approvalRoles: ["부장"] }),
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: "POST", url: "/api/employees", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/[가-힣]/);
    }
    expect(audits(db)).toHaveLength(0);
  });

  it("목록: 기본은 활성만, includeInactive=1 이면 활성 먼저 이름순", async () => {
    const { app, db } = await createTestApp();
    insertEmployee(db, { name: "다연" });
    insertEmployee(db, { name: "가람", active: false });
    insertEmployee(db, { name: "나래" });
    const active = (await app.inject({ method: "GET", url: "/api/employees" })).json();
    expect(active.map((e: { name: string }) => e.name)).toEqual(["나래", "다연"]);
    const all = (await app.inject({ method: "GET", url: "/api/employees?includeInactive=1" })).json();
    expect(all.map((e: { name: string }) => e.name)).toEqual(["나래", "다연", "가람"]);
  });

  it("목록: includeDeleted=1 이면 영구 삭제된 직원도 (남은 소속·구분 포함)", async () => {
    const { app, db } = await createTestApp();
    insertEmployee(db, { name: "나래" });
    const gone = insertEmployee(db, { name: "가람", department: "지원사업부", category: "강사", active: false });
    execute(db, "UPDATE employees SET deleted = 1 WHERE id = ?", [gone]);
    const names = async (q: string) =>
      (await app.inject({ method: "GET", url: `/api/employees${q}` })).json().map((e: { name: string }) => e.name);
    expect(await names("?includeInactive=1")).toEqual(["나래"]);
    expect(await names("?includeDeleted=1")).toEqual(["나래"]);
    const withDeleted = (await app.inject({ method: "GET", url: "/api/employees?includeInactive=1&includeDeleted=1" })).json();
    expect(withDeleted.map((e: { name: string }) => e.name)).toEqual(["나래", "가람"]);
    expect(withDeleted[1]).toMatchObject({ department: "지원사업부", category: "강사" });
  });

  it("수정: 바뀐 항목을 이력에 남김, 없는 직원은 404", async () => {
    const { app, db } = await createTestApp();
    const id = insertEmployee(db);
    insertCategory(db, "사회복무요원", true);
    const res = await app.inject({
      method: "PUT",
      url: `/api/employees/${id}`,
      payload: body({ workStart: "09:00", workEnd: "18:00", category: "사회복무요원", approvalRoles: ["대표", "팀장", "담당"] }),
    });
    expect(res.statusCode).toBe(200);
    // 구분의 사회복무요원 특별휴가 대상 여부를 함께 보여 줌
    expect(res.json()).toMatchObject({
      workStart: "09:00",
      workEnd: "18:00",
      category: "사회복무요원",
      isSocialServiceAgent: true,
      approvalRoles: ["담당", "팀장", "대표"],
    });
    const log = audits(db)[0]!;
    expect(log.action).toBe("update");
    expect(log.summary).toContain("근무시간");
    expect(log.summary).toContain("구분");
    expect(log.summary).toContain("결재칸");

    const missing = await app.inject({ method: "PUT", url: "/api/employees/999", payload: body() });
    expect(missing.statusCode).toBe(404);
  });

  it("수정해도 기존 휴가원의 신청 시점 값은 그대로", async () => {
    const { app, db } = await createTestApp();
    const id = insertEmployee(db, { name: "홍길동" });
    execute(
      db,
      `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
         created_at, updated_at) VALUES (?, '홍길동', '아동사업부', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', 'x', 'x')`,
      [id],
    );
    await app.inject({ method: "PUT", url: `/api/employees/${id}`, payload: body({ name: "홍길순", workStart: "09:00" }) });
    const row = queryAll<{ employee_name: string; work_start: string }>(db, "SELECT * FROM leave_requests")[0]!;
    expect(row).toMatchObject({ employee_name: "홍길동", work_start: "10:00" });
  });

  it("비활성화·활성화, 이미 그 상태면 409", async () => {
    const { app, db } = await createTestApp();
    const id = insertEmployee(db);
    const off = await app.inject({ method: "POST", url: `/api/employees/${id}/deactivate` });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);
    expect((await app.inject({ method: "POST", url: `/api/employees/${id}/deactivate` })).statusCode).toBe(409);

    const on = await app.inject({ method: "POST", url: `/api/employees/${id}/activate` });
    expect(on.json().active).toBe(true);
    expect((await app.inject({ method: "POST", url: `/api/employees/${id}/activate` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/employees/999/activate" })).statusCode).toBe(404);

    expect(audits(db).map((l) => l.action)).toEqual(["deactivate", "activate"]);
  });
});
