import { describe, expect, it } from "vitest";
import type { AuditLogPage, OvertimeRequest } from "@leave-flow/shared";
import { writeAudit } from "../services/audit.ts";
import { createTestApp, insertEmployee, insertLeaveType, updatedAtOf } from "../testing.ts";

async function setup() {
  const t = await createTestApp();
  const add = (at: string, entity: "leave_request" | "holiday" | "employee", action: "create" | "cancel" | "delete", employeeId: number | null, summary: string) =>
    writeAudit(t.db, "192.168.100.21", { entity, entityId: 1, employeeId, action, summary, before: { a: 1 }, after: { a: 2 } }, at);
  add("2026-10-01 09:00:00", "leave_request", "create", 1, "휴가원 작성 1");
  add("2026-10-02 18:30:00", "leave_request", "cancel", 1, "휴가원 취소 1");
  add("2026-10-02 18:30:00", "holiday", "create", null, "센터 휴무일 추가");
  add("2026-10-03 00:00:00", "employee", "create", 2, "직원 추가");
  add("2026-10-05 12:00:00", "holiday", "delete", null, "공휴일 삭제");
  return t;
}

const get = async (app: Awaited<ReturnType<typeof setup>>["app"], qs: string) => {
  const res = await app.inject({ method: "GET", url: `/api/audit-logs${qs}` });
  return { status: res.statusCode, body: res.json() as AuditLogPage };
};

describe("GET /api/audit-logs", () => {
  it("최근순 (at DESC, id DESC), before/after 는 JSON 값", async () => {
    const { app } = await setup();
    const { status, body } = await get(app, "");
    expect(status).toBe(200);
    expect(body.total).toBe(5);
    expect(body.rows.map((r) => r.summary)).toEqual([
      "공휴일 삭제",
      "직원 추가",
      "센터 휴무일 추가",
      "휴가원 취소 1",
      "휴가원 작성 1",
    ]);
    expect(body.rows[0]).toMatchObject({
      ip: "192.168.100.21",
      entity: "holiday",
      entityId: 1,
      employeeId: null,
      action: "delete",
      before: { a: 1 },
      after: { a: 2 },
    });
  });

  it("기간 (from·to 날짜 포함), 대상, 작업, 직원 필터", async () => {
    const { app } = await setup();
    const range = await get(app, "?from=2026-10-02&to=2026-10-03");
    expect(range.body.rows.map((r) => r.summary)).toEqual(["직원 추가", "센터 휴무일 추가", "휴가원 취소 1"]);
    expect(range.body.total).toBe(3);

    expect((await get(app, "?entity=holiday")).body.rows.map((r) => r.summary)).toEqual(["공휴일 삭제", "센터 휴무일 추가"]);
    expect((await get(app, "?action=create")).body.total).toBe(3);
    expect((await get(app, "?employeeId=1")).body.rows.map((r) => r.summary)).toEqual(["휴가원 취소 1", "휴가원 작성 1"]);
    expect((await get(app, "?entity=leave_request&action=cancel&employeeId=1&from=2026-10-02")).body.total).toBe(1);
  });

  it("페이지 나눔 (pageSize 최대 200)", async () => {
    const { app } = await setup();
    const p1 = await get(app, "?page=1&pageSize=2");
    const p3 = await get(app, "?page=3&pageSize=2");
    expect(p1.body.rows.map((r) => r.summary)).toEqual(["공휴일 삭제", "직원 추가"]);
    expect(p3.body.rows.map((r) => r.summary)).toEqual(["휴가원 작성 1"]);
    expect(p3.body.total).toBe(5);
    expect((await get(app, "?page=9&pageSize=2")).body).toEqual({ rows: [], total: 5 });
    expect((await get(app, "?pageSize=0")).body.rows).toHaveLength(1);
  });

  it("pageSize 는 200 을 넘지 않음", async () => {
    const { app, db } = await createTestApp();
    for (let i = 0; i < 205; i++) {
      writeAudit(db, "", { entity: "system", action: "backup", summary: `백업 ${i}` }, "2026-10-01 09:00:00");
    }
    const { body } = await get(app, "?pageSize=1000");
    expect(body.rows).toHaveLength(200);
    expect(body.total).toBe(205);
    expect(body.rows[0]!.summary).toBe("백업 204");
  });

  it("잘못된 필터 값은 400", async () => {
    const { app } = await setup();
    expect((await get(app, "?entity=nope")).status).toBe(400);
    expect((await get(app, "?action=nope")).status).toBe(400);
    expect((await get(app, "?from=2026-1-1")).status).toBe(400);
    expect((await get(app, "?employeeId=x")).status).toBe(400);
  });
});

describe("직원 필터: 대상이 여러 명인 시간외근무 신청서 (employee_id 가 NULL 인 기록)", () => {
  async function overtimeSetup() {
    const t = await createTestApp();
    const ga = insertEmployee(t.db, { name: "가" });
    const na = insertEmployee(t.db, { name: "나" });
    const da = insertEmployee(t.db, { name: "다" });
    const agent1 = insertEmployee(t.db, { name: "박요원", isSocialServiceAgent: true });
    const agent2 = insertEmployee(t.db, { name: "최요원", isSocialServiceAgent: true });
    const comp = insertLeaveType(t.db, { name: "보상휴가", balanceMode: "cumulative", sortOrder: 1 });
    const special = insertLeaveType(t.db, { name: "요원휴가", sortOrder: 2 });
    const send = async (method: "POST" | "PUT", url: string, payload: object = {}) => {
      const res = await t.app.inject({ method, url, payload });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json() as OvertimeRequest;
    };
    return { ...t, ga, na, da, agent1, agent2, comp, special, send };
  }

  const generalBody = (employeeIds: number[], leaveTypeId: number) => ({
    kind: "general",
    targets: employeeIds.map((employeeId) => ({ employeeId, leaveTypeId })),
    workStartAt: "2026-10-10T10:00",
    workEndAt: "2026-10-10T19:00",
    minutes: 150,
    cumulativeNote: "",
    category: "special_work",
    workDetails: "행사 준비",
  });

  const actions = (page: AuditLogPage) => page.rows.map((r) => r.action);

  it("일반: 두 명 신청서를 출력하면 각 직원으로 작성·적립·출력 기록이 보임", async () => {
    const t = await overtimeSetup();
    const created = await t.send("POST", "/api/overtime", generalBody([t.ga, t.na], t.comp));
    await t.send("POST", `/api/overtime/${created.id}/print`);
    // 같은 직원의 다른 기록 (employee_id 로 찾는 기존 방식)
    writeAudit(t.db, "", { entity: "leave_request", entityId: 9, employeeId: t.ga, action: "create", summary: "가 휴가원 작성" }, "2026-10-01 09:00:00");

    const ga = await get(t.app, `?employeeId=${t.ga}`);
    expect(ga.status).toBe(200);
    expect(actions(ga.body)).toEqual(["print", "accrue", "create", "create"]);
    expect(ga.body.total).toBe(4);
    expect(ga.body.rows.slice(0, 3).every((r) => r.entity === "overtime_request" && r.entityId === created.id)).toBe(true);
    expect(ga.body.rows.slice(0, 3).every((r) => r.employeeId === null)).toBe(true);

    const na = await get(t.app, `?employeeId=${t.na}`);
    expect(actions(na.body)).toEqual(["print", "accrue", "create"]);
    expect(na.body.total).toBe(3);

    // 관계없는 직원에게는 안 보임
    expect((await get(t.app, `?employeeId=${t.da}`)).body).toEqual({ rows: [], total: 0 });

    // 다른 필터·페이지 나눔과 함께 (COUNT 도 같은 조건)
    const accrue = await get(t.app, `?employeeId=${t.na}&action=accrue`);
    expect(accrue.body.total).toBe(1);
    expect(accrue.body.rows[0]!.summary).toContain("적립");
    expect((await get(t.app, `?employeeId=${t.ga}&entity=overtime_request`)).body.total).toBe(3);
    const paged = await get(t.app, `?employeeId=${t.ga}&page=2&pageSize=3`);
    expect(paged.body.total).toBe(4);
    expect(paged.body.rows.map((r) => r.summary)).toEqual(["가 휴가원 작성"]);
  });

  it("일반: 대상에서 빠진 직원도 예전 기록이 보이고, 새로 들어온 직원은 신청서 기록 전체가 보임", async () => {
    const t = await overtimeSetup();
    const created = await t.send("POST", "/api/overtime", generalBody([t.ga, t.na], t.comp));
    await t.send("POST", `/api/overtime/${created.id}/print`);
    await t.send("PUT", `/api/overtime/${created.id}`, {
      ...generalBody([t.ga, t.da], t.comp),
      baseUpdatedAt: updatedAtOf(t.db, "overtime_requests", created.id),
    });
    await t.send("POST", `/api/overtime/${created.id}/cancel`);

    // 나: 작성·적립(after.targets), 수정(before.targets). 빠진 뒤의 취소는 관계없음
    const na = await get(t.app, `?employeeId=${t.na}`);
    expect(actions(na.body)).toEqual(expect.arrayContaining(["update", "accrue", "create"]));
    expect(actions(na.body)).not.toContain("cancel");
    expect(na.body.total).toBe(na.body.rows.length);

    // 다: 지금 대상이므로 이 신청서의 기록 전체
    const da = await get(t.app, `?employeeId=${t.da}`);
    expect(actions(da.body)).toEqual(["cancel", "update", "print", "accrue", "create"]);
    expect(da.body.total).toBe(5);
    expect(actions((await get(t.app, `?employeeId=${t.ga}`)).body)).toEqual(["cancel", "update", "print", "accrue", "create"]);
  });

  it("사회복무요원: 여러 명 신청서의 작성·적립·취소·복구 기록이 각 요원으로 보임", async () => {
    const t = await overtimeSetup();
    const created = await t.send("POST", "/api/overtime", {
      kind: "soldier",
      targets: [
        { employeeId: t.agent1, leaveTypeId: t.special, days: 1, month: 10 },
        { employeeId: t.agent2, leaveTypeId: t.special, days: 2, month: 10 },
      ],
      paidOn: "2026-10-15",
      category: "special_leave",
      workDetails: "기본 문구",
    });
    await t.send("POST", `/api/overtime/${created.id}/cancel`);
    await t.send("POST", `/api/overtime/${created.id}/restore`);

    for (const id of [t.agent1, t.agent2]) {
      const page = await get(t.app, `?employeeId=${id}`);
      expect(actions(page.body)).toEqual(["accrue", "restore", "cancel", "accrue", "create"]);
      expect(page.body.total).toBe(5);
    }
    expect((await get(t.app, `?employeeId=${t.ga}`)).body.total).toBe(0);
  });
});
