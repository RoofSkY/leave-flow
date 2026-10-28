import type { DeleteCheck, LeavePrintData, LeaveRequest, LeaveSaveResult, OvertimeRequest } from "@leave-flow/shared";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { execute, queryAll, queryOne } from "../db/index.ts";
import {
  createTestApp,
  insertEmployee,
  insertGrant,
  insertLeaveType,
  type TestApp,
} from "../testing.ts";

async function setup() {
  const t = await createTestApp();
  const hong = insertEmployee(t.db, { name: "홍길동", emergencyContact: "010-1111-2222" });
  const kim = insertEmployee(t.db, { name: "김철수" });
  const annual = insertLeaveType(t.db, { name: "연차", sortOrder: 1 });
  const sick = insertLeaveType(t.db, { name: "병가", sortOrder: 2 });
  return { ...t, hong, kim, annual, sick };
}

const inject = (t: TestApp, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  t.app.inject({ method, url, payload });

async function createLeave(t: TestApp, employeeId: number, leaveTypeId: number, day = "2026-10-26") {
  const res = await inject(t, "POST", "/api/leave-requests", {
    employeeId,
    items: [{ leaveTypeId, startAt: `${day}T10:00`, endAt: `${day}T19:00` }],
    reason: "개인 사유",
    emergencyContact: "010-1234-5678",
    handoverNote: "",
  });
  expect(res.statusCode).toBe(201);
  return res.json<LeaveSaveResult>().request;
}

const deactivate = (t: TestApp, kind: "employees" | "leave-types", id: number) =>
  inject(t, "POST", `/api/${kind}/${id}/deactivate`);
const backups = (t: TestApp) => {
  try {
    return readdirSync(t.ctx.config.backupDir).filter((n) => n.includes("pre-delete"));
  } catch {
    return [];
  }
};
const deleteAudits = (t: TestApp) =>
  queryAll<{ entity: string; summary: string }>(t.db, "SELECT entity, summary FROM audit_logs WHERE action = 'delete'");

describe("직원 영구 삭제", () => {
  it("활성 직원은 409, 기록이 없으면 이름 확인·백업 없이 행을 지움", async () => {
    const t = await setup();
    const check = await inject(t, "GET", `/api/employees/${t.kim}/delete-check`);
    expect(check.json<DeleteCheck>()).toEqual({
      leaveRequests: 0,
      overtimeRequests: 0,
      grants: 0,
      openingBalances: 0,
      balanceKept: false,
      blockedReason: "활성 직원은 삭제할 수 없습니다. 먼저 비활성화하세요.",
    });
    expect((await inject(t, "POST", `/api/employees/${t.kim}/delete`)).statusCode).toBe(409);

    await deactivate(t, "employees", t.kim);
    expect((await inject(t, "POST", `/api/employees/${t.kim}/delete`)).statusCode).toBe(204);
    expect(queryOne(t.db, "SELECT id FROM employees WHERE id = ?", [t.kim])).toBeUndefined();
    expect(backups(t)).toEqual([]);
    expect(deleteAudits(t)).toEqual([{ entity: "employee", summary: "김철수 직원 영구 삭제" }]);
    expect((await inject(t, "GET", `/api/employees/${t.kim}/delete-check`)).statusCode).toBe(404);
  });

  it("부여만 있고 휴가원이 없으면 부여도 함께 지우고 행을 지움", async () => {
    const t = await setup();
    insertGrant(t.db, { employeeId: t.kim, leaveTypeId: t.annual, grantDate: "2026-01-01", minutes: 480 });
    await deactivate(t, "employees", t.kim);
    const check = (await inject(t, "GET", `/api/employees/${t.kim}/delete-check`)).json<DeleteCheck>();
    expect(check).toMatchObject({ grants: 1, balanceKept: false });
    expect((await inject(t, "POST", `/api/employees/${t.kim}/delete`, { confirmName: "김철수" })).statusCode).toBe(204);
    expect(queryAll(t.db, "SELECT * FROM leave_grants")).toEqual([]);
    expect(queryOne(t.db, "SELECT id FROM employees WHERE id = ?", [t.kim])).toBeUndefined();
    expect(deleteAudits(t)).toEqual([{ entity: "employee", summary: "김철수 직원 영구 삭제 (부여 1건 삭제)" }]);
  });

  it("휴가원이 있으면 이름 확인 + 백업, 휴가원과 휴가현황(부여·기존 잔여 숨겨 보관)은 그대로", async () => {
    const t = await setup();
    insertGrant(t.db, { employeeId: t.hong, leaveTypeId: t.annual, grantDate: "2026-01-01", minutes: 480 * 15 });
    execute(t.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [t.sick, t.hong]);
    execute(t.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [t.sick, t.kim]);
    const request = await createLeave(t, t.hong, t.annual);
    await deactivate(t, "employees", t.hong);

    const check = (await inject(t, "GET", `/api/employees/${t.hong}/delete-check`)).json<DeleteCheck>();
    expect(check).toEqual({
      leaveRequests: 1,
      overtimeRequests: 0,
      grants: 1,
      openingBalances: 0,
      balanceKept: true,
      blockedReason: null,
    });
    const printBefore = (await inject(t, "GET", `/api/leave-requests/${request.id}/print-data`)).json<LeavePrintData>();
    for (const confirmName of [undefined, "홍길"]) {
      const res = await inject(t, "POST", `/api/employees/${t.hong}/delete`, { confirmName });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("확인을 위해 이름(홍길동)을 그대로 입력하세요.");
    }
    const res = await inject(t, "POST", `/api/employees/${t.hong}/delete`, { confirmName: " 홍길동 " });
    expect(res.statusCode).toBe(204);

    expect(backups(t)).toHaveLength(1);
    // 번호만 남고 개인정보는 비움, 목록·조회에 안 나옴
    expect(queryOne(t.db, "SELECT name, department, emergency_contact, deleted FROM employees WHERE id = ?", [t.hong])).toEqual({
      name: "",
      department: "아동사업부", // 소속·구분은 적용 대상 판단용으로 남김
      emergency_contact: "",
      deleted: 1,
    });
    const all = (await inject(t, "GET", "/api/employees?includeInactive=1")).json<{ id: number }[]>();
    expect(all.map((e) => e.id)).toEqual([t.kim]);
    // 부여는 남기되 관리 화면에서는 숨김
    expect(queryAll(t.db, "SELECT * FROM leave_grants WHERE employee_id = ?", [t.hong])).toHaveLength(1);
    expect((await inject(t, "GET", "/api/grants")).json()).toEqual([]);
    const grantId = queryOne<{ id: number }>(t.db, "SELECT id FROM leave_grants")!.id;
    expect((await t.app.inject({ method: "DELETE", url: `/api/grants/${grantId}` })).statusCode).toBe(404);
    // 적용 대상 행도 보관하지만 대상 목록에는 안 나옴. 대상을 다시 골라도 보관한 행은 유지
    const sickType = async () =>
      (await inject(t, "GET", "/api/leave-types?includeInactive=1")).json<{ id: number; target: { employeeIds: number[] } }[]>();
    expect((await sickType()).find((x) => x.id === t.sick)!.target.employeeIds).toEqual([t.kim]);
    await inject(t, "PUT", `/api/leave-types/${t.sick}`, {
      name: "병가",
      deducts: true,
      balanceMode: "yearly",
      sortOrder: 2,
      target: { employeeIds: [t.kim] },
    });
    expect(queryAll(t.db, "SELECT employee_id FROM leave_type_employees ORDER BY employee_id")).toEqual([
      { employee_id: t.hong },
      { employee_id: t.kim },
    ]);
    expect(deleteAudits(t)).toEqual([
      { entity: "employee", summary: "홍길동 직원 영구 삭제 (휴가원 1건은 남김, 부여 1건은 휴가현황용으로 숨겨 보관)" },
    ]);

    // 휴가원은 작성 시점 이름으로 남고, 보기·출력만
    const kept = (await inject(t, "GET", `/api/leave-requests/${request.id}`)).json<LeaveRequest>();
    expect(kept).toMatchObject({ employeeName: "홍길동", employeeDeleted: true });
    const list = (await inject(t, "GET", "/api/leave-requests")).json<LeaveRequest[]>();
    expect(list.map((r) => r.id)).toEqual([request.id]);
    for (const url of [`/api/leave-requests/${request.id}/cancel`, `/api/leave-requests/${request.id}/restore`]) {
      const blocked = await inject(t, "POST", url);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toContain("영구 삭제된 직원의 휴가원");
    }
    // 출력 양식의 휴가현황·체크박스는 삭제 전과 같음
    const print = await inject(t, "GET", `/api/leave-requests/${request.id}/print-data`);
    expect(print.statusCode).toBe(200);
    const printAfter = print.json<LeavePrintData>();
    expect(printAfter.balanceTable).toEqual(printBefore.balanceTable);
    expect(printAfter.balanceTable[0]).toMatchObject({ name: "연차", grantedMinutes: 480 * 15, currentMinutes: 480 });
    expect(printAfter.checkboxes).toEqual(printBefore.checkboxes);
    // 새 휴가원·부여에는 쓸 수 없음
    expect((await inject(t, "GET", `/api/balances?employeeId=${t.hong}`)).statusCode).toBe(404);
  });

  it("시간외근무 신청서만 있으면 신청서는 남기고 그 직원 적립만 지움, 신청서는 보기·출력만", async () => {
    const t = await setup();
    const comp = insertLeaveType(t.db, { name: "대체휴가", balanceMode: "cumulative" });
    const created = await inject(t, "POST", "/api/overtime", {
      kind: "general",
      targets: [
        { employeeId: t.hong, leaveTypeId: comp },
        { employeeId: t.kim, leaveTypeId: comp },
      ],
      workStartAt: "2026-10-10T10:00",
      workEndAt: "2026-10-10T19:00",
      minutes: 120,
      cumulativeNote: "",
      category: "special_work",
      workDetails: "행사",
    });
    const id = created.json<OvertimeRequest>().id;
    await inject(t, "POST", `/api/overtime/${id}/print`); // 제출 → 두 명 적립
    expect(queryAll(t.db, "SELECT employee_id FROM leave_grants ORDER BY employee_id")).toHaveLength(2);
    await deactivate(t, "employees", t.hong);
    const check = (await inject(t, "GET", `/api/employees/${t.hong}/delete-check`)).json<DeleteCheck>();
    expect(check).toMatchObject({ overtimeRequests: 1, grants: 1 });
    expect((await inject(t, "POST", `/api/employees/${t.hong}/delete`, { confirmName: "홍길동" })).statusCode).toBe(204);

    expect(queryAll(t.db, "SELECT employee_id FROM leave_grants")).toEqual([{ employee_id: t.kim }]);
    const doc = (await inject(t, "GET", `/api/overtime/${id}`)).json<OvertimeRequest>();
    expect(doc.targets.map((x) => [x.employeeName, x.employeeDeleted])).toEqual([
      ["홍길동", true],
      ["김철수", false],
    ]);
    const cancel = await inject(t, "POST", `/api/overtime/${id}/cancel`);
    expect(cancel.statusCode).toBe(409);
    expect((await inject(t, "GET", `/api/overtime/${id}/print-data`)).statusCode).toBe(200);
    // 다시 출력해도 삭제된 직원은 적립 안 함
    expect((await inject(t, "POST", `/api/overtime/${id}/print`)).statusCode).toBe(200);
    expect(queryAll(t.db, "SELECT employee_id FROM leave_grants")).toEqual([{ employee_id: t.kim }]);
  });
});

describe("휴가 종류 영구 삭제", () => {
  it("기록이 없으면 행을 지움, 활성은 409", async () => {
    const t = await setup();
    execute(t.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [t.sick, t.kim]);
    expect((await inject(t, "POST", `/api/leave-types/${t.sick}/delete`)).statusCode).toBe(409);
    await deactivate(t, "leave-types", t.sick);
    expect((await inject(t, "POST", `/api/leave-types/${t.sick}/delete`)).statusCode).toBe(204);
    expect(queryOne(t.db, "SELECT id FROM leave_types WHERE id = ?", [t.sick])).toBeUndefined();
    expect(queryAll(t.db, "SELECT * FROM leave_type_employees")).toEqual([]);
    expect(deleteAudits(t)).toEqual([{ entity: "leave_type", summary: "병가 휴가 종류 영구 삭제" }]);
  });

  it("휴가원 항목은 이름으로 남고 잔여 계산에서 빠짐, 부여·기존 잔여는 삭제", async () => {
    const t = await setup();
    insertGrant(t.db, { employeeId: t.hong, leaveTypeId: t.sick, grantDate: "2026-01-01", minutes: 480 });
    const request = await createLeave(t, t.hong, t.sick);
    await deactivate(t, "leave-types", t.sick);
    expect((await inject(t, "POST", `/api/leave-types/${t.sick}/delete`, { confirmName: "병" })).statusCode).toBe(400);
    expect((await inject(t, "POST", `/api/leave-types/${t.sick}/delete`, { confirmName: "병가" })).statusCode).toBe(204);
    expect(backups(t)).toHaveLength(1);

    expect(queryAll(t.db, "SELECT * FROM leave_grants WHERE leave_type_id = ?", [t.sick])).toEqual([]);
    const types = (await inject(t, "GET", "/api/leave-types?includeInactive=1")).json<{ name: string }[]>();
    expect(types.map((x) => x.name)).toEqual(["연차"]);
    const kept = (await inject(t, "GET", `/api/leave-requests/${request.id}`)).json<LeaveRequest>();
    expect(kept.items[0]).toMatchObject({ leaveTypeName: "병가", leaveTypeDeleted: true });
    const balances = (await inject(t, "GET", `/api/balances?employeeId=${t.hong}&year=2026`)).json<{ name: string }[]>();
    expect(balances.map((b) => b.name)).toEqual(["연차"]);
    // 수정은 막고 취소·출력은 가능
    const put = await inject(t, "PUT", `/api/leave-requests/${request.id}`, {
      baseUpdatedAt: kept.updatedAt,
      employeeId: t.hong,
      items: [{ leaveTypeId: t.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" }],
      reason: "개인 사유",
      emergencyContact: "010-1234-5678",
      handoverNote: "",
    });
    expect(put.statusCode).toBe(409);
    const print = (await inject(t, "GET", `/api/leave-requests/${request.id}/print-data`)).json<LeavePrintData>();
    expect(print.checkboxes.map((c) => [c.name, c.checked])).toEqual([
      ["연차", false],
      ["병가", true],
    ]);
    expect((await inject(t, "POST", `/api/leave-requests/${request.id}/cancel`)).statusCode).toBe(200);
    // 같은 이름으로 새 종류를 만들 수 있음
    const again = await inject(t, "POST", "/api/leave-types", {
      name: "병가",
      deducts: true,
      balanceMode: "yearly",
      sortOrder: 2,
    });
    expect(again.statusCode).toBe(201);
  });

  it("그 종류를 고른 시간외근무 신청서가 있으면 삭제 불가", async () => {
    const t = await setup();
    const comp = insertLeaveType(t.db, { name: "대체휴가", balanceMode: "cumulative", active: false });
    const ot = execute(
      t.db,
      `INSERT INTO overtime_requests (kind, category, paid_on, created_at, updated_at)
       VALUES ('soldier', 'special_leave', '2026-10-01', 'x', 'x')`,
    ).lastInsertRowid;
    execute(
      t.db,
      `INSERT INTO overtime_targets (overtime_request_id, employee_id, employee_name, minutes, leave_type_id)
       VALUES (?, ?, '홍길동', 480, ?)`,
      [ot, t.hong, comp],
    );
    const check = (await inject(t, "GET", `/api/leave-types/${comp}/delete-check`)).json<DeleteCheck>();
    expect(check.blockedReason).toBe("이 종류를 고른 시간외근무 신청서(1건)가 있어 삭제할 수 없습니다.");
    expect((await inject(t, "POST", `/api/leave-types/${comp}/delete`, { confirmName: "대체휴가" })).statusCode).toBe(409);
  });
});

describe("휴가원 영구 삭제", () => {
  it("취소된 휴가원만, 지우기 직전 백업, 항목·출력 기록도 지움, 이력 한 줄", async () => {
    const t = await setup();
    const request = await createLeave(t, t.hong, t.annual);
    await inject(t, "POST", `/api/leave-requests/${request.id}/print`);
    const active = await inject(t, "POST", `/api/leave-requests/${request.id}/delete`);
    expect(active.statusCode).toBe(409);
    expect(active.json().error).toBe("신청 상태인 휴가원은 영구 삭제할 수 없습니다. 먼저 취소하세요.");
    expect(backups(t)).toEqual([]);

    await inject(t, "POST", `/api/leave-requests/${request.id}/cancel`);
    expect((await inject(t, "POST", `/api/leave-requests/${request.id}/delete`)).statusCode).toBe(204);
    expect(backups(t)).toHaveLength(1);
    expect((await inject(t, "GET", `/api/leave-requests/${request.id}`)).statusCode).toBe(404);
    expect(queryAll(t.db, "SELECT * FROM leave_request_items")).toEqual([]);
    expect(queryAll(t.db, "SELECT * FROM print_logs")).toEqual([]);
    expect(deleteAudits(t)).toEqual([
      { entity: "leave_request", summary: "홍길동 휴가원 영구 삭제 (연차 2026.10.26. 10:00 ~ 19:00)" },
    ]);
    expect((await inject(t, "POST", `/api/leave-requests/${request.id}/delete`)).statusCode).toBe(404);
  });

  it("삭제된 직원의 휴가원은 신청 상태여도 삭제, 마지막 휴가원이면 숨겨 둔 기록과 직원 행도 정리", async () => {
    const t = await setup();
    insertGrant(t.db, { employeeId: t.hong, leaveTypeId: t.annual, grantDate: "2026-01-01", minutes: 480 });
    execute(t.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [t.sick, t.hong]);
    const first = await createLeave(t, t.hong, t.annual, "2026-10-26");
    const second = await createLeave(t, t.hong, t.annual, "2026-10-27");
    await deactivate(t, "employees", t.hong);
    await inject(t, "POST", `/api/employees/${t.hong}/delete`, { confirmName: "홍길동" });

    expect((await inject(t, "POST", `/api/leave-requests/${first.id}/delete`)).statusCode).toBe(204);
    // 남은 휴가원이 있으므로 보관한 기록은 그대로
    expect(queryAll(t.db, "SELECT * FROM leave_grants")).toHaveLength(1);
    expect((await inject(t, "POST", `/api/leave-requests/${second.id}/delete`)).statusCode).toBe(204);
    expect(queryAll(t.db, "SELECT * FROM leave_grants")).toEqual([]);
    expect(queryAll(t.db, "SELECT * FROM leave_type_employees")).toEqual([]);
    expect(queryOne(t.db, "SELECT id FROM employees WHERE id = ?", [t.hong])).toBeUndefined();
  });

  it("삭제된 휴가 종류는 그 종류 항목이 든 마지막 휴가원을 지우면 행도 정리", async () => {
    const t = await setup();
    const request = await createLeave(t, t.hong, t.sick);
    await deactivate(t, "leave-types", t.sick);
    await inject(t, "POST", `/api/leave-types/${t.sick}/delete`, { confirmName: "병가" });
    expect(queryOne(t.db, "SELECT deleted FROM leave_types WHERE id = ?", [t.sick])).toEqual({ deleted: 1 });
    await inject(t, "POST", `/api/leave-requests/${request.id}/cancel`);
    expect((await inject(t, "POST", `/api/leave-requests/${request.id}/delete`)).statusCode).toBe(204);
    expect(queryOne(t.db, "SELECT id FROM leave_types WHERE id = ?", [t.sick])).toBeUndefined();
    // 직원은 삭제된 직원이 아니므로 그대로
    expect(queryOne(t.db, "SELECT id FROM employees WHERE id = ?", [t.hong])).toEqual({ id: t.hong });
  });
});
