import type { AuditLogPage, BalanceRow, OvertimePrintData, OvertimeRequest } from "@leave-flow/shared";
import { describe, expect, it } from "vitest";
import { execute, queryAll } from "../db/index.ts";
import { getEmployeeBalances } from "../services/balances.ts";
import {
  TEST_TODAY,
  createTestApp,
  insertCategory,
  insertEmployee,
  insertLeaveType,
  updatedAtOf,
  type TestApp,
} from "../testing.ts";

async function setup() {
  const t = await createTestApp();
  const hong = insertEmployee(t.db, { name: "홍길동" });
  const kim = insertEmployee(t.db, { name: "김철수" });
  const agent1 = insertEmployee(t.db, { name: "박요원", isSocialServiceAgent: true });
  const agent2 = insertEmployee(t.db, { name: "최요원", isSocialServiceAgent: true });
  // 이름은 관리자가 정함 (코드는 이름에 의존하지 않음)
  const comp = insertLeaveType(t.db, { name: "보상휴가", balanceMode: "cumulative", sortOrder: 1 });
  const special = insertLeaveType(t.db, { name: "요원휴가", balanceMode: "yearly", sortOrder: 2 });
  return { ...t, hong, kim, agent1, agent2, comp, special };
}

/** 대상 전원이 같은 적립 종류 (대상자마다 다르게 하려면 over.targets) */
function generalBody(employeeIds: number[], leaveTypeId: number, over: Record<string, unknown> = {}) {
  return {
    kind: "general",
    targets: employeeIds.map((employeeId) => ({ employeeId, leaveTypeId })),
    workStartAt: "2026-10-10T10:00",
    workEndAt: "2026-10-10T19:00",
    minutes: 150,
    cumulativeNote: "누적 메모",
    category: "special_work",
    workDetails: "행사 준비",
    ...over,
  };
}

/** 대상 전원이 같은 적립 종류 */
function soldierBody(
  targets: { employeeId: number; days: number; month: number }[],
  leaveTypeId: number,
  over: Record<string, unknown> = {},
) {
  return {
    kind: "soldier",
    targets: targets.map((x) => ({ ...x, leaveTypeId })),
    paidOn: "2026-10-15",
    category: "special_leave",
    workDetails: "기본 문구",
    ...over,
  };
}

/** 대상 전원이 같은 적립 종류 */
function awardBody(targets: { employeeId: number; days: number }[], leaveTypeId: number, over: Record<string, unknown> = {}) {
  return { kind: "award", targets: targets.map((x) => ({ ...x, leaveTypeId })), paidOn: "2026-10-20", workDetails: "시상 문구", ...over };
}

async function post<T>(t: TestApp, url: string, payload: unknown = {}) {
  const res = await t.app.inject({ method: "POST", url, payload: payload as object });
  return { status: res.statusCode, body: res.json() as T & { error?: string } };
}

/** 수정 저장: 지금 저장된 수정 일시를 baseUpdatedAt 으로 (payload 로 바꿀 수 있음) */
async function put<T>(t: TestApp, url: string, payload: unknown) {
  const id = Number(url.split("/").pop());
  const res = await t.app.inject({
    method: "PUT",
    url,
    payload: { baseUpdatedAt: updatedAtOf(t.db, "overtime_requests", id), ...(payload as object) },
  });
  return { status: res.statusCode, body: res.json() as T & { error?: string } };
}

async function get<T>(t: TestApp, url: string) {
  const res = await t.app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as T & { error?: string } };
}

function granted(t: TestApp, employeeId: number, leaveTypeId: number, year = 2026): number {
  const row = getEmployeeBalances(t.db, employeeId, year).find((b) => b.leaveTypeId === leaveTypeId);
  return row?.grantedMinutes ?? 0;
}

function overtimeGrants(t: TestApp, requestId: number) {
  return queryAll<{ employee_id: number; leave_type_id: number; grant_date: string; minutes: number; source: string }>(
    t.db,
    "SELECT employee_id, leave_type_id, grant_date, minutes, source FROM leave_grants WHERE overtime_request_id = ? ORDER BY id",
    [requestId],
  ).map((g) => ({ ...g, employee_id: Number(g.employee_id), leave_type_id: Number(g.leave_type_id), minutes: Number(g.minutes) }));
}

function audits(t: TestApp, id: number) {
  return queryAll<{ action: string; summary: string; employee_id: number | null; at: string }>(
    t.db,
    "SELECT action, summary, employee_id, at FROM audit_logs WHERE entity = 'overtime_request' AND entity_id = ? ORDER BY id",
    [id],
  );
}

describe("일반 시간외근무", () => {
  it("저장: 미제출·미적립, 대상은 입력 순서대로 이름 기록", async () => {
    const t = await setup();
    const res = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.kim, t.hong], t.comp));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "general",
      submittedOn: null,
      accrued: false,
      status: "active",
      minutes: 150,
      cumulativeNote: "누적 메모",
      paidOn: null,
    });
    // 고른 적립 종류는 적립 전이라도 저장할 때 대상자마다 기록
    expect(res.body.targets).toEqual([
      { employeeId: t.kim, employeeName: "김철수", employeeDeleted: false, minutes: 150, days: null, month: null, leaveTypeId: t.comp },
      { employeeId: t.hong, employeeName: "홍길동", employeeDeleted: false, minutes: 150, days: null, month: null, leaveTypeId: t.comp },
    ]);
    expect(queryAll(t.db, "SELECT leave_type_id FROM overtime_targets")).toEqual([
      { leave_type_id: t.comp },
      { leave_type_id: t.comp },
    ]);
    expect(overtimeGrants(t, res.body.id)).toEqual([]);
    expect(granted(t, t.hong, t.comp)).toBe(0);
    const log = audits(t, res.body.id);
    expect(log.map((a) => a.action)).toEqual(["create"]);
    expect(log[0]!.summary).toContain("김철수, 홍길동");
    expect(log[0]!.employee_id).toBeNull();
    expect(log[0]!.at).toBe(`${TEST_TODAY} 09:00:00`);
  });

  it("적립 종류를 고르지 않았거나 없는·비활성·적용되지 않는 종류면 400 (아무것도 저장 안 함)", async () => {
    const t = await setup();
    const inactive = insertLeaveType(t.db, { name: "옛 종류", active: false });
    const hongOnly = insertLeaveType(t.db, { name: "홍길동 전용" });
    execute(t.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [hongOnly, t.hong]);
    const cases: [Record<string, unknown>, string][] = [
      [generalBody([], t.comp, { targets: [{ employeeId: t.hong }] }), "적립할 휴가 종류를 선택하세요."],
      [generalBody([], t.comp, { targets: [{ employeeId: t.hong, leaveTypeId: null }] }), "적립할 휴가 종류를 선택하세요."],
      [generalBody([t.hong], 9999), "선택한 휴가 종류를 찾을 수 없습니다."],
      [generalBody([t.hong], inactive), "비활성화된 휴가 종류(옛 종류)는 고를 수 없습니다."],
      [generalBody([t.hong, t.kim], hongOnly), "김철수님에게 적용되지 않는 휴가 종류입니다. (홍길동 전용)"],
      [soldierBody([{ employeeId: t.agent1, days: 1, month: 10 }], 0), "적립할 휴가 종류를 선택하세요."],
      [awardBody([{ employeeId: t.agent1, days: 1 }], inactive), "비활성화된 휴가 종류(옛 종류)는 고를 수 없습니다."],
    ];
    for (const [body, message] of cases) {
      const res = await post(t, "/api/overtime", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe(message);
    }
    expect(queryAll(t.db, "SELECT * FROM overtime_requests")).toEqual([]);
    expect(queryAll(t.db, "SELECT * FROM audit_logs")).toEqual([]);
  });

  it("첫 출력 때 제출일 = 오늘로 고정하고 적립, 다시 출력해도 중복 적립 없음", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong, t.kim], t.comp));

    // 미리보기는 기록·적립 안 함
    const preview = await get<OvertimePrintData>(t, `/api/overtime/${created.id}/print-data`);
    expect(preview.body).toMatchObject({ submitDate: TEST_TODAY, year: 2026 });
    expect(preview.body.request.submittedOn).toBeNull();
    expect(overtimeGrants(t, created.id)).toEqual([]);

    const first = await post<OvertimePrintData>(t, `/api/overtime/${created.id}/print`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ submitDate: TEST_TODAY, year: 2026 });
    expect(first.body.request).toMatchObject({
      submittedOn: TEST_TODAY,
      accrued: true,
      lastPrintedAt: `${TEST_TODAY} 09:00:00`,
    });
    expect(first.body.request.targets.map((x) => x.leaveTypeId)).toEqual([t.comp, t.comp]);
    expect(overtimeGrants(t, created.id)).toEqual([
      { employee_id: t.hong, leave_type_id: t.comp, grant_date: TEST_TODAY, minutes: 150, source: "overtime" },
      { employee_id: t.kim, leave_type_id: t.comp, grant_date: TEST_TODAY, minutes: 150, source: "overtime" },
    ]);
    expect(granted(t, t.hong, t.comp)).toBe(150);
    const balances = await get<BalanceRow[]>(t, `/api/balances?employeeId=${t.kim}&year=2026`);
    expect(balances.body.find((b) => b.leaveTypeId === t.comp)?.remainingMinutes).toBe(150);
    expect(audits(t, created.id).map((a) => a.action)).toEqual(["create", "accrue", "print"]);
    expect(audits(t, created.id)[1]!.summary).toContain("보상휴가 적립");

    // 다른 날 다시 출력: 제출일·적립 그대로
    t.setToday("2026-11-02");
    const again = await post<OvertimePrintData>(t, `/api/overtime/${created.id}/print`);
    expect(again.body).toMatchObject({ submitDate: TEST_TODAY, year: 2026 });
    expect(again.body.request.lastPrintedAt).toBe("2026-11-02 09:00:00");
    expect(overtimeGrants(t, created.id)).toHaveLength(2);
    expect(granted(t, t.hong, t.comp)).toBe(150);
    expect(queryAll(t.db, "SELECT * FROM print_logs WHERE doc_type = 'overtime'")).toHaveLength(2);
    expect(audits(t, created.id).map((a) => a.action)).toEqual(["create", "accrue", "print", "print"]);
  });

  it("누적 종류는 다음 해에도 쌓이고, 제출 연도가 출력 연도", async () => {
    const t = await setup();
    t.setToday("2026-12-31");
    const { body } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    t.setToday("2027-01-02");
    const printed = await post<OvertimePrintData>(t, `/api/overtime/${body.id}/print`);
    expect(printed.body).toMatchObject({ submitDate: "2027-01-02", year: 2027 });
    expect(granted(t, t.hong, t.comp, 2026)).toBe(0);
    expect(granted(t, t.hong, t.comp, 2027)).toBe(150);
    expect(granted(t, t.hong, t.comp, 2028)).toBe(150);
  });

  it("제출 후 수정하면 적립도 함께 수정 (제출일 유지, 종류를 바꾸면 바꾼 종류로)", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong, t.kim], t.comp));
    await post(t, `/api/overtime/${created.id}/print`);

    const other = insertLeaveType(t.db, { name: "다른 종류", balanceMode: "cumulative" });
    t.setToday("2026-10-25");

    const res = await put<OvertimeRequest>(t, `/api/overtime/${created.id}`, generalBody([t.hong], other, { minutes: 200 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ submittedOn: TEST_TODAY, accrued: true, minutes: 200 });
    expect(res.body.targets.map((x) => x.leaveTypeId)).toEqual([other]);
    expect(overtimeGrants(t, created.id)).toEqual([
      { employee_id: t.hong, leave_type_id: other, grant_date: TEST_TODAY, minutes: 200, source: "overtime" },
    ]);
    expect(granted(t, t.hong, other)).toBe(200);
    expect(granted(t, t.hong, t.comp)).toBe(0);
    expect(granted(t, t.kim, t.comp)).toBe(0);
    const log = audits(t, created.id).at(-1)!;
    expect(log.action).toBe("update");
    expect(log.summary).toContain("적립도 함께 수정");
    expect(log.employee_id).toBe(t.hong);
  });

  it("수정해도 원래 대상의 성명은 작성 시점 값 유지, 새로 추가한 대상만 지금 이름", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    await post(t, `/api/overtime/${created.id}/print`);

    // 제출 뒤 직원 이름이 바뀜
    execute(t.db, "UPDATE employees SET name = '홍길순' WHERE id = ?", [t.hong]);
    execute(t.db, "UPDATE employees SET name = '김영희' WHERE id = ?", [t.kim]);

    const res = await put<OvertimeRequest>(t, `/api/overtime/${created.id}`, generalBody([t.hong, t.kim], t.comp, { minutes: 200 }));
    expect(res.status).toBe(200);
    expect(res.body.targets.map((x) => x.employeeName)).toEqual(["홍길동", "김영희"]);
    const stored = queryAll<{ employee_name: string }>(
      t.db,
      "SELECT employee_name FROM overtime_targets WHERE overtime_request_id = ? ORDER BY sort_order",
      [created.id],
    ).map((r) => r.employee_name);
    expect(stored).toEqual(["홍길동", "김영희"]);

    const reprinted = await post<OvertimePrintData>(t, `/api/overtime/${created.id}/print`);
    expect(reprinted.body.request.targets.map((x) => x.employeeName)).toEqual(["홍길동", "김영희"]);
    const update = audits(t, created.id).find((a) => a.action === "update")!;
    expect(update.summary).toContain("홍길동, 김영희");

    // 대상에서 뺐다가 다시 넣으면 새로 추가한 것으로 보고 지금 이름
    await put(t, `/api/overtime/${created.id}`, generalBody([t.kim], t.comp));
    const readded = await put<OvertimeRequest>(t, `/api/overtime/${created.id}`, generalBody([t.kim, t.hong], t.comp));
    expect(readded.body.targets.map((x) => x.employeeName)).toEqual(["김영희", "홍길순"]);
  });

  it("미제출 상태에서 수정해도 적립 없음", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    const res = await put<OvertimeRequest>(t, `/api/overtime/${created.id}`, generalBody([t.kim], t.comp, { minutes: 60 }));
    expect(res.body).toMatchObject({ accrued: false, submittedOn: null, minutes: 60 });
    expect(res.body.targets.map((x) => x.employeeName)).toEqual(["김철수"]);
    expect(overtimeGrants(t, created.id)).toEqual([]);
  });

  it("취소하면 적립 회수, 복구하면 다시 적립", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    await post(t, `/api/overtime/${created.id}/print`);
    expect(granted(t, t.hong, t.comp)).toBe(150);

    const cancelled = await post<OvertimeRequest>(t, `/api/overtime/${created.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      cancelledAt: `${TEST_TODAY} 09:00:00`,
      accrued: false,
      submittedOn: TEST_TODAY,
    });
    expect(overtimeGrants(t, created.id)).toEqual([]);
    expect(granted(t, t.hong, t.comp)).toBe(0);
    expect(audits(t, created.id).at(-1)).toMatchObject({ action: "cancel", employee_id: t.hong });
    expect(audits(t, created.id).at(-1)!.summary).toContain("적립 회수");

    // 취소된 신청서: 수정·출력·재취소 불가
    expect((await put(t, `/api/overtime/${created.id}`, generalBody([t.hong], t.comp))).status).toBe(409);
    expect((await post(t, `/api/overtime/${created.id}/print`)).status).toBe(409);
    expect((await get(t, `/api/overtime/${created.id}/print-data`)).status).toBe(409);
    expect((await post(t, `/api/overtime/${created.id}/cancel`)).status).toBe(409);

    const restored = await post<OvertimeRequest>(t, `/api/overtime/${created.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ status: "active", cancelledAt: null, accrued: true });
    expect(restored.body.targets.map((x) => x.leaveTypeId)).toEqual([t.comp]);
    expect(overtimeGrants(t, created.id)).toEqual([
      { employee_id: t.hong, leave_type_id: t.comp, grant_date: TEST_TODAY, minutes: 150, source: "overtime" },
    ]);
    expect(granted(t, t.hong, t.comp)).toBe(150);
    expect(audits(t, created.id).slice(-2).map((a) => a.action)).toEqual(["restore", "accrue"]);
    expect((await post(t, `/api/overtime/${created.id}/restore`)).status).toBe(409);
  });

  it("미제출 신청서는 취소·복구해도 적립 없음", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    await post(t, `/api/overtime/${created.id}/cancel`);
    expect(audits(t, created.id).at(-1)!.summary).not.toContain("적립 회수");
    const restored = await post<OvertimeRequest>(t, `/api/overtime/${created.id}/restore`);
    expect(restored.body).toMatchObject({ status: "active", accrued: false, submittedOn: null });
    expect(overtimeGrants(t, created.id)).toEqual([]);
    expect(audits(t, created.id).map((a) => a.action)).toEqual(["create", "cancel", "restore"]);
  });

  it("입력 오류는 400", async () => {
    const t = await setup();
    const inactive = insertEmployee(t.db, { name: "퇴사자", active: false });
    const cases: [Record<string, unknown>, string | null][] = [
      [generalBody([], t.comp), "대상 직원을 한 명 이상 선택하세요."],
      [generalBody([t.hong, t.hong], t.comp), "같은 직원이 중복 선택되었습니다."],
      [generalBody([t.hong], t.comp, { minutes: 0 }), null],
      [generalBody([t.hong], t.comp, { minutes: 15 }), "금일발생은(는) 10분 단위로 입력하세요."],
      [generalBody([t.hong], t.comp, { workEndAt: "2026-10-10T09:00" }), "근무 종료일시는 시작일시보다 뒤여야 합니다."],
      [generalBody([t.hong], t.comp, { workStartAt: "2026-10-10T10:05" }), "근무시간은 10분 단위로 입력하세요."],
      [generalBody([t.hong], t.comp, { category: "special_leave" }), null],
      [generalBody([inactive], t.comp), "퇴사자님은 비활성 직원이라 선택할 수 없습니다."],
      [generalBody([9999], t.comp), "선택한 직원을 찾을 수 없습니다."],
      [{ ...generalBody([t.hong], t.comp), kind: "other" }, "신청서 종류가 올바르지 않습니다."],
    ];
    for (const [body, message] of cases) {
      const res = await post(t, "/api/overtime", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      if (message) expect(res.body.error).toBe(message);
    }
    expect(queryAll(t.db, "SELECT * FROM overtime_requests")).toEqual([]);
  });

  it("수정: 원래 대상이던 비활성 직원·원래 고른 비활성 종류는 유지 가능, 새로 추가는 불가 / 신청서 종류 변경 400 / 없는 신청서 404", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    execute(t.db, "UPDATE employees SET active = 0 WHERE id = ?", [t.hong]);
    expect((await put(t, `/api/overtime/${created.id}`, generalBody([t.hong], t.comp, { minutes: 60 }))).status).toBe(200);

    const leaver = insertEmployee(t.db, { name: "퇴사자", active: false });
    expect((await put(t, `/api/overtime/${created.id}`, generalBody([t.hong, leaver], t.comp))).status).toBe(400);

    execute(t.db, "UPDATE leave_types SET active = 0 WHERE id = ?", [t.comp]);
    expect((await put(t, `/api/overtime/${created.id}`, generalBody([t.hong], t.comp, { minutes: 70 }))).status).toBe(200);
    const newTarget = await put(t, `/api/overtime/${created.id}`, generalBody([t.hong, t.kim], t.comp));
    expect(newTarget.status).toBe(400);
    expect(newTarget.body.error).toBe("비활성화된 휴가 종류(보상휴가)는 고를 수 없습니다.");

    const kindChange = await put(t, `/api/overtime/${created.id}`, soldierBody([{ employeeId: t.agent1, days: 1, month: 10 }], t.special));
    expect(kindChange.status).toBe(400);
    expect(kindChange.body.error).toBe("신청서 종류는 바꿀 수 없습니다.");

    expect((await get(t, "/api/overtime/9999")).status).toBe(404);
    expect((await put(t, "/api/overtime/9999", generalBody([t.kim], t.comp))).status).toBe(404);
    expect((await post(t, "/api/overtime/9999/print")).status).toBe(404);
    expect((await post(t, "/api/overtime/9999/cancel")).status).toBe(404);
  });

  it("수정 창을 연 뒤 다른 사람이 먼저 저장했으면 409 (적립도 그대로), 수정 시작 시점이 없으면 400", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp));
    await post(t, `/api/overtime/${created.id}/print`);
    t.setToday("2026-10-20");
    const url = `/api/overtime/${created.id}`;
    const first = await put(t, url, { ...generalBody([t.hong], t.comp, { minutes: 60 }), baseUpdatedAt: created.updatedAt });
    expect(first.status).toBe(200);
    const second = await put(t, url, { ...generalBody([t.hong], t.comp, { minutes: 90 }), baseUpdatedAt: created.updatedAt });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("다른 사람이 이 신청서를 먼저 수정했습니다.");
    expect((await get<OvertimeRequest>(t, url)).body.minutes).toBe(60);
    expect(granted(t, t.hong, t.comp)).toBe(60);

    const noBase = await t.app.inject({ method: "PUT", url, payload: generalBody([t.hong], t.comp) });
    expect(noBase.statusCode).toBe(400);
  });
});

describe("사회복무요원 특별휴가", () => {
  it("저장하면 바로 적립 (부여일 = 지급일자, 일수 × 하루 근무시간, 발생 월 기록)", async () => {
    const t = await setup();
    const res = await post<OvertimeRequest>(
      t,
      "/api/overtime",
      soldierBody([
        { employeeId: t.agent2, days: 2, month: 9 },
        { employeeId: t.agent1, days: 1, month: 10 },
      ], t.special),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "soldier",
      paidOn: "2026-10-15",
      category: "special_leave",
      accrued: true,
      workStartAt: null,
      minutes: null,
      submittedOn: null,
    });
    expect(res.body.targets).toEqual([
      { employeeId: t.agent2, employeeName: "최요원", employeeDeleted: false, minutes: 960, days: 2, month: 9, leaveTypeId: t.special },
      { employeeId: t.agent1, employeeName: "박요원", employeeDeleted: false, minutes: 480, days: 1, month: 10, leaveTypeId: t.special },
    ]);
    expect(overtimeGrants(t, res.body.id)).toEqual([
      { employee_id: t.agent2, leave_type_id: t.special, grant_date: "2026-10-15", minutes: 960, source: "overtime" },
      { employee_id: t.agent1, leave_type_id: t.special, grant_date: "2026-10-15", minutes: 480, source: "overtime" },
    ]);
    expect(granted(t, t.agent2, t.special)).toBe(960);
    const balances = await get<BalanceRow[]>(t, `/api/balances?employeeId=${t.agent1}&year=2026`);
    expect(balances.body.find((b) => b.leaveTypeId === t.special)?.remainingMinutes).toBe(480);
    // 연도별 종류: 다음 해에는 0
    expect(granted(t, t.agent1, t.special, 2027)).toBe(0);
    expect(audits(t, res.body.id).map((a) => a.action)).toEqual(["create", "accrue"]);
    expect(audits(t, res.body.id)[1]!.summary).toContain("요원휴가 적립: 최요원 2일, 박요원 1일");
  });

  it("적립 분 = 일수 × 그 요원의 하루 근무시간", async () => {
    const t = await setup();
    const short = insertEmployee(t.db, {
      name: "단시요원",
      isSocialServiceAgent: true,
      workStart: "09:00",
      workEnd: "15:00", // 점심 빼고 5시간
    });
    const res = await post<OvertimeRequest>(t, "/api/overtime", soldierBody([{ employeeId: short, days: 2, month: 10 }], t.special));
    expect(res.status).toBe(201);
    expect(res.body.targets).toEqual([
      { employeeId: short, employeeName: "단시요원", employeeDeleted: false, minutes: 600, days: 2, month: 10, leaveTypeId: t.special },
    ]);
    expect(granted(t, short, t.special)).toBe(600);
  });

  it("적립 종류가 적용되지 않는 요원이 있으면 400 (아무것도 저장 안 함)", async () => {
    const t = await setup();
    execute(t.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [t.special, t.agent1]);
    const res = await post(
      t,
      "/api/overtime",
      soldierBody([
        { employeeId: t.agent1, days: 1, month: 10 },
        { employeeId: t.agent2, days: 1, month: 10 },
      ], t.special),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("최요원님에게 적용되지 않는 휴가 종류입니다. (요원휴가)");
    expect(queryAll(t.db, "SELECT * FROM overtime_requests")).toEqual([]);
    expect((await post(t, "/api/overtime", soldierBody([{ employeeId: t.agent1, days: 1, month: 10 }], t.special))).status).toBe(201);
  });

  it("대상은 사회복무요원 특별휴가 대상 구분인 활성 직원만", async () => {
    const t = await setup();
    const notAgent = await post(t, "/api/overtime", soldierBody([{ employeeId: t.hong, days: 1, month: 10 }], t.special));
    expect(notAgent.status).toBe(400);
    expect(notAgent.body.error).toBe("홍길동님의 구분은 사회복무요원 특별휴가 대상이 아닙니다.");
    const gone = insertEmployee(t.db, { name: "전역요원", isSocialServiceAgent: true, active: false });
    expect((await post(t, "/api/overtime", soldierBody([{ employeeId: gone, days: 1, month: 10 }], t.special))).status).toBe(400);
    const dup = await post(
      t,
      "/api/overtime",
      soldierBody([
        { employeeId: t.agent1, days: 1, month: 10 },
        { employeeId: t.agent1, days: 1, month: 9 },
      ], t.special),
    );
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe("같은 요원이 중복 선택되었습니다.");
    expect((await post(t, "/api/overtime", soldierBody([{ employeeId: t.agent1, days: 0, month: 10 }], t.special))).status).toBe(400);
    expect((await post(t, "/api/overtime", soldierBody([{ employeeId: t.agent1, days: 1, month: 13 }], t.special))).status).toBe(400);
  });

  it("수정하면 부여도 새 값으로, 취소하면 회수, 복구하면 다시 적립", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(
      t,
      "/api/overtime",
      soldierBody([{ employeeId: t.agent1, days: 1, month: 10 }], t.special),
    );
    const updated = await put<OvertimeRequest>(
      t,
      `/api/overtime/${created.id}`,
      soldierBody(
        [
          { employeeId: t.agent1, days: 2, month: 11 },
          { employeeId: t.agent2, days: 1, month: 11 },
        ],
        t.special,
        { paidOn: "2026-11-03", category: "official_event" },
      ),
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ paidOn: "2026-11-03", category: "official_event", accrued: true });
    expect(overtimeGrants(t, created.id)).toEqual([
      { employee_id: t.agent1, leave_type_id: t.special, grant_date: "2026-11-03", minutes: 960, source: "overtime" },
      { employee_id: t.agent2, leave_type_id: t.special, grant_date: "2026-11-03", minutes: 480, source: "overtime" },
    ]);
    expect(granted(t, t.agent1, t.special)).toBe(960);

    await post(t, `/api/overtime/${created.id}/cancel`);
    expect(granted(t, t.agent1, t.special)).toBe(0);
    expect(granted(t, t.agent2, t.special)).toBe(0);

    const restored = await post<OvertimeRequest>(t, `/api/overtime/${created.id}/restore`);
    expect(restored.body.accrued).toBe(true);
    expect(granted(t, t.agent1, t.special)).toBe(960);
    expect(granted(t, t.agent2, t.special)).toBe(480);
  });

  it("수정해도 원래 요원의 성명·순서는 그대로", async () => {
    const t = await setup();
    const targets = [
      { employeeId: t.agent2, days: 2, month: 9 },
      { employeeId: t.agent1, days: 1, month: 10 },
    ];
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", soldierBody(targets, t.special));
    execute(t.db, "UPDATE employees SET name = '박요원2' WHERE id = ?", [t.agent1]);
    const res = await put<OvertimeRequest>(
      t,
      `/api/overtime/${created.id}`,
      soldierBody(targets, t.special, { workDetails: "고친 문구" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.targets.map((x) => x.employeeName)).toEqual(["최요원", "박요원"]);
  });

  it("출력: 제출일자 = 오늘, 연도 = 지급 연도, 추가 적립 없음", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(
      t,
      "/api/overtime",
      soldierBody([{ employeeId: t.agent1, days: 1, month: 12 }], t.special, { paidOn: "2025-12-30" }),
    );
    const printed = await post<OvertimePrintData>(t, `/api/overtime/${created.id}/print`);
    expect(printed.status).toBe(200);
    expect(printed.body).toMatchObject({ submitDate: TEST_TODAY, year: 2025 });
    expect(printed.body.request.lastPrintedAt).toBe(`${TEST_TODAY} 09:00:00`);
    expect(overtimeGrants(t, created.id)).toHaveLength(1);
    expect(audits(t, created.id).map((a) => a.action)).toEqual(["create", "accrue", "print"]);
    expect(audits(t, created.id)[2]!.employee_id).toBe(t.agent1);
  });
});

describe("사회복무요원 특별휴가(시상)", () => {
  async function awardSetup() {
    const t = await setup();
    const prize = insertLeaveType(t.db, { name: "포상휴가", balanceMode: "used_up", sortOrder: 3 });
    return { ...t, prize };
  }

  it("저장하면 바로 고른 종류로 적립 (부여일 = 지급일자, 일수 × 하루 근무시간, 발생 월 없음, 상세내용 = 시상)", async () => {
    const t = await awardSetup();
    const res = await post<OvertimeRequest>(
      t,
      "/api/overtime",
      awardBody([
        { employeeId: t.agent2, days: 2 },
        { employeeId: t.agent1, days: 1 },
      ], t.prize),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "award", paidOn: "2026-10-20", category: "award", accrued: true });
    expect(res.body.targets).toEqual([
      { employeeId: t.agent2, employeeName: "최요원", employeeDeleted: false, minutes: 960, days: 2, month: null, leaveTypeId: t.prize },
      { employeeId: t.agent1, employeeName: "박요원", employeeDeleted: false, minutes: 480, days: 1, month: null, leaveTypeId: t.prize },
    ]);
    expect(overtimeGrants(t, res.body.id)).toEqual([
      { employee_id: t.agent2, leave_type_id: t.prize, grant_date: "2026-10-20", minutes: 960, source: "overtime" },
      { employee_id: t.agent1, leave_type_id: t.prize, grant_date: "2026-10-20", minutes: 480, source: "overtime" },
    ]);
    expect(queryAll(t.db, "SELECT DISTINCT note FROM leave_grants")).toEqual([{ note: "사회복무요원 특별휴가(시상)" }]);
    // 요원 특별휴가 종류에는 쌓이지 않음
    expect(granted(t, t.agent1, t.special)).toBe(0);
    expect(audits(t, res.body.id).map((a) => a.summary)).toEqual([
      "사회복무요원 특별휴가(시상) 신청서 (최요원 2일, 박요원 1일, 지급일자 2026.10.20.) 작성",
      "포상휴가 적립: 최요원 2일, 박요원 1일 (부여일 2026.10.20.)",
    ]);
  });

  it("대상은 사회복무요원 특별휴가 대상 구분인 직원만, 상세내용은 시상만", async () => {
    const t = await awardSetup();
    const notAgent = await post(t, "/api/overtime", awardBody([{ employeeId: t.hong, days: 1 }], t.prize));
    expect(notAgent.status).toBe(400);
    expect(notAgent.body.error).toBe("홍길동님의 구분은 사회복무요원 특별휴가 대상이 아닙니다.");
    const wrongCategory = await post(t, "/api/overtime", awardBody([{ employeeId: t.agent1, days: 1 }], t.prize, { category: "special_leave" }));
    expect(wrongCategory.status).toBe(400);
    expect((await post(t, "/api/overtime", awardBody([{ employeeId: t.agent1, days: 0 }], t.prize))).status).toBe(400);
  });

  it("취소하면 회수, 복구하면 다시 적립 / 출력: 제출일자 = 오늘, 연도 = 지급 연도 / 종류는 바꿀 수 없음", async () => {
    const t = await awardSetup();
    const { body: created } = await post<OvertimeRequest>(
      t,
      "/api/overtime",
      awardBody([{ employeeId: t.agent1, days: 1 }], t.prize, { paidOn: "2025-12-30" }),
    );
    expect(granted(t, t.agent1, t.prize, 2025)).toBe(480);
    await post(t, `/api/overtime/${created.id}/cancel`);
    expect(granted(t, t.agent1, t.prize, 2025)).toBe(0);
    await post(t, `/api/overtime/${created.id}/restore`);
    expect(granted(t, t.agent1, t.prize, 2025)).toBe(480);

    const printed = await post<OvertimePrintData>(t, `/api/overtime/${created.id}/print`);
    expect(printed.body).toMatchObject({ submitDate: TEST_TODAY, year: 2025 });
    expect(overtimeGrants(t, created.id)).toHaveLength(1);

    const asSoldier = await put(t, `/api/overtime/${created.id}`, soldierBody([{ employeeId: t.agent1, days: 1, month: 12 }], t.special));
    expect(asSoldier.status).toBe(400);
  });
});

describe("대상자마다 다른 적립 종류 (직원용·요원용 대체휴가)", () => {
  /** 홍길동·김철수 = 직원, 박요원·최요원 = 사회복무요원 / 대체휴가(직원)·대체휴가(요원) */
  async function multiSetup() {
    const t = await setup();
    insertCategory(t.db, "직원");
    execute(t.db, "UPDATE employees SET category = '직원' WHERE id IN (?, ?)", [t.hong, t.kim]);
    const staffComp = insertLeaveType(t.db, { name: "대체휴가(직원)", balanceMode: "cumulative" });
    const agentComp = insertLeaveType(t.db, { name: "대체휴가(요원)", balanceMode: "cumulative" });
    execute(t.db, `UPDATE leave_types SET target_categories = '["직원"]' WHERE id = ?`, [staffComp]);
    execute(t.db, `UPDATE leave_types SET target_categories = '["사회복무요원"]' WHERE id = ?`, [agentComp]);
    return { ...t, staffComp, agentComp };
  }

  /** [직원, 적립 종류] 쌍으로 일반 신청서 */
  const pairsBody = (pairs: [number, number][], over: Record<string, unknown> = {}) =>
    generalBody([], 0, { targets: pairs.map(([employeeId, leaveTypeId]) => ({ employeeId, leaveTypeId })), ...over });

  it("대상자마다 고른 종류로 적립하고 대상자마다 기록", async () => {
    const t = await multiSetup();
    const { body: created } = await post<OvertimeRequest>(
      t,
      "/api/overtime",
      pairsBody([
        [t.hong, t.staffComp],
        [t.agent1, t.agentComp],
      ]),
    );
    expect(created.targets.map((x) => x.leaveTypeId)).toEqual([t.staffComp, t.agentComp]);

    await post(t, `/api/overtime/${created.id}/print`);
    expect(overtimeGrants(t, created.id)).toEqual([
      { employee_id: t.hong, leave_type_id: t.staffComp, grant_date: TEST_TODAY, minutes: 150, source: "overtime" },
      { employee_id: t.agent1, leave_type_id: t.agentComp, grant_date: TEST_TODAY, minutes: 150, source: "overtime" },
    ]);
    expect(
      queryAll(t.db, "SELECT employee_id, leave_type_id FROM overtime_targets ORDER BY sort_order").map((r) => [
        Number(r.employee_id),
        Number(r.leave_type_id),
      ]),
    ).toEqual([
      [t.hong, t.staffComp],
      [t.agent1, t.agentComp],
    ]);
    expect(audits(t, created.id)[1]!.summary).toContain("대체휴가(직원)·대체휴가(요원) 적립: 홍길동, 박요원");
  });

  it("직원에게 적용되지 않는 종류를 고르면 저장 400", async () => {
    const t = await multiSetup();
    const res = await post(
      t,
      "/api/overtime",
      pairsBody([
        [t.hong, t.staffComp],
        [t.agent1, t.staffComp],
      ]),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("박요원님에게 적용되지 않는 휴가 종류입니다. (대체휴가(직원))");
    expect(queryAll(t.db, "SELECT * FROM overtime_requests")).toEqual([]);
  });

  it("저장 뒤 구분이 바뀌어 고른 종류가 적용되지 않으면 첫 출력 400 (제출·적립 안 됨), 이미 적립된 대상자는 수정 가능", async () => {
    const t = await multiSetup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", pairsBody([[t.hong, t.staffComp]]));
    const { body: submitted } = await post<OvertimeRequest>(t, "/api/overtime", pairsBody([[t.kim, t.staffComp]]));
    await post(t, `/api/overtime/${submitted.id}/print`);
    execute(t.db, "UPDATE employees SET category = '' WHERE id IN (?, ?)", [t.hong, t.kim]);

    const printed = await post(t, `/api/overtime/${created.id}/print`);
    expect(printed.status).toBe(400);
    expect(printed.body.error).toBe(
      "고른 휴가 종류가 적용되지 않는 직원이 있습니다: 홍길동(대체휴가(직원) 적용 안 됨). 신청서를 수정해 종류를 다시 고르거나 관리 > 휴가 종류의 적용 대상을 확인하세요.",
    );
    expect(overtimeGrants(t, created.id)).toEqual([]);
    expect(queryAll(t.db, "SELECT submitted_on FROM overtime_requests WHERE id = ?", [created.id])).toEqual([
      { submitted_on: null },
    ]);

    const updated = await put(t, `/api/overtime/${submitted.id}`, pairsBody([[t.kim, t.staffComp]], { minutes: 200 }));
    expect(updated.status).toBe(200);
    expect(overtimeGrants(t, submitted.id)).toEqual([
      { employee_id: t.kim, leave_type_id: t.staffComp, grant_date: TEST_TODAY, minutes: 200, source: "overtime" },
    ]);
  });
});

describe("변경 이력 직원 필터", () => {
  it("대상이 여러 명인 신청서도 대상 직원마다 찾을 수 있음 (수정으로 빠진 직원 포함)", async () => {
    const t = await setup();
    const { body: created } = await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong, t.kim], t.comp));
    await post(t, `/api/overtime/${created.id}/print`);
    // 김철수를 대상에서 뺌 (적립도 회수됨) → 그 뒤 취소
    await put(t, `/api/overtime/${created.id}`, generalBody([t.hong], t.comp));
    await post(t, `/api/overtime/${created.id}/cancel`);
    expect(audits(t, created.id).map((a) => a.action)).toEqual(["create", "accrue", "print", "update", "cancel"]);
    // 대상이 여러 명이던 기록은 employee_id 가 비어 있음
    expect(audits(t, created.id).slice(0, 3).every((a) => a.employee_id === null)).toBe(true);

    const actionsFor = async (employeeId: number) => {
      const res = await get<AuditLogPage>(t, `/api/audit-logs?employeeId=${employeeId}&entity=overtime_request`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(res.body.rows.length);
      return res.body.rows
        .filter((r) => r.entityId === created.id)
        .map((r) => r.action)
        .reverse(); // 최근순 → 작성순
    };
    expect(await actionsFor(t.hong)).toEqual(["create", "accrue", "print", "update", "cancel"]);
    // 취소 때는 이미 대상이 아니라 회수할 것이 없음 → 취소 기록은 해당 없음
    expect(await actionsFor(t.kim)).toEqual(["create", "accrue", "print", "update"]);
    expect(await actionsFor(t.agent1)).toEqual([]);
  });
});

describe("목록", () => {
  it("종류·연도·상태 필터, 최근 작성순", async () => {
    const t = await setup();
    const g2026 = (await post<OvertimeRequest>(t, "/api/overtime", generalBody([t.hong], t.comp))).body.id;
    const g2025 = (
      await post<OvertimeRequest>(
        t,
        "/api/overtime",
        generalBody([t.kim], t.comp, { workStartAt: "2025-12-31T18:00", workEndAt: "2026-01-01T02:00" }),
      )
    ).body.id;
    const s2026 = (
      await post<OvertimeRequest>(t, "/api/overtime", soldierBody([{ employeeId: t.agent1, days: 1, month: 10 }], t.special))
    ).body.id;
    const s2025 = (
      await post<OvertimeRequest>(
        t,
        "/api/overtime",
        soldierBody([{ employeeId: t.agent2, days: 1, month: 12 }], t.special, { paidOn: "2025-12-20" }),
      )
    ).body.id;
    await post(t, `/api/overtime/${g2026}/cancel`);
    const prize = insertLeaveType(t.db, { name: "포상휴가", balanceMode: "used_up", sortOrder: 3 });
    const a2025 = (
      await post<OvertimeRequest>(t, "/api/overtime", awardBody([{ employeeId: t.agent1, days: 1 }], prize, { paidOn: "2025-11-01" }))
    ).body.id;

    const ids = async (query: string) =>
      (await get<OvertimeRequest[]>(t, `/api/overtime${query}`)).body.map((r) => r.id);

    expect(await ids("")).toEqual([a2025, s2025, s2026, g2025]);
    expect(await ids("?status=all")).toEqual([a2025, s2025, s2026, g2025, g2026]);
    expect(await ids("?status=cancelled")).toEqual([g2026]);
    expect(await ids("?kind=general&status=all")).toEqual([g2025, g2026]);
    expect(await ids("?kind=general&status=all&year=2026")).toEqual([g2026]);
    expect(await ids("?kind=general&year=2025")).toEqual([g2025]);
    expect(await ids("?kind=soldier&year=2025")).toEqual([s2025]);
    expect(await ids("?kind=award&year=2025")).toEqual([a2025]);
    expect(await ids("?kind=award&year=2026")).toEqual([]);
    expect(await ids("?year=2025")).toEqual([a2025, s2025, g2025]);
    expect(await ids("?year=2026&status=all")).toEqual([s2026, g2026]);

    expect((await get(t, "/api/overtime?kind=x")).status).toBe(400);
    expect((await get(t, "/api/overtime?status=x")).status).toBe(400);
    expect((await get(t, "/api/overtime?year=abc")).status).toBe(400);
  });
});
