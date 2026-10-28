import { describe, expect, it } from "vitest";
import { queryAll, type Db } from "../db/index.ts";
import { getEmployeeBalances } from "../services/balances.ts";
import { createTestApp, insertEmployee, insertLeaveType } from "../testing.ts";

const audits = (db: Db) =>
  queryAll<{ action: string; summary: string; employee_id: number | null }>(
    db,
    "SELECT * FROM audit_logs WHERE entity = 'opening_balance' ORDER BY id",
  );

async function setup() {
  const t = await createTestApp();
  const emp = insertEmployee(t.db, { name: "홍길동" });
  const annual = insertLeaveType(t.db, { name: "연차" });
  const comp = insertLeaveType(t.db, { name: "대체휴가", balanceMode: "cumulative" });
  const put = (payload: Record<string, unknown>) =>
    t.app.inject({
      method: "PUT",
      url: "/api/opening-balances",
      payload: {
        employeeId: emp,
        leaveTypeId: annual,
        year: 2026,
        baseDate: "2026-10-19",
        totalGrantedMinutes: 7200,
        remainingMinutes: 10 * 480 + 4 * 60 + 30,
        ...payload,
      },
    });
  return { ...t, emp, annual, comp, put };
}

describe("기존 잔여량 API", () => {
  it("입력: 기존 사용량 = 총 부여(분) − 잔여, 잔여 계산에 반영, 이력", async () => {
    const { db, emp, annual, put } = await setup();
    const res = await put({});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      employeeId: emp,
      leaveTypeId: annual,
      year: 2026,
      baseDate: "2026-10-19",
      totalGrantedMinutes: 7200,
      remainingMinutes: 5070,
      usedMinutes: 15 * 480 - 5070,
    });
    const bal = getEmployeeBalances(db, emp, 2026).find((b) => b.leaveTypeId === annual)!;
    expect(bal).toMatchObject({ grantedMinutes: 7200, usedMinutes: 2130, remainingMinutes: 5070 });
    expect(audits(db)).toMatchObject([{ action: "create", employee_id: emp }]);
    expect(audits(db)[0]!.summary).toContain("홍길동 연차 2026년");
  });

  it("같은 직원·종류·연도는 덮어씀 (update 이력)", async () => {
    const { app, db, put } = await setup();
    const first = (await put({})).json();
    const second = await put({ totalGrantedMinutes: 7680, remainingMinutes: 480, baseDate: "2026-10-20" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: first.id, totalGrantedMinutes: 7680, usedMinutes: 15 * 480, baseDate: "2026-10-20" });
    expect(queryAll(db, "SELECT * FROM opening_balances")).toHaveLength(1);
    expect(audits(db).map((a) => a.action)).toEqual(["create", "update"]);
    // 다른 연도는 별도 기록
    await put({ year: 2025, baseDate: "2025-12-31" });
    const list = (await app.inject({ method: "GET", url: "/api/opening-balances?year=2025" })).json();
    expect(list).toHaveLength(1);
  });

  it("잔여가 총 부여보다 크면 400, 기준일자가 그 해가 아니면 400, 10분 단위 아니면 400", async () => {
    const { db, put } = await setup();
    const over = await put({ totalGrantedMinutes: 480, remainingMinutes: 490 });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toContain("총 부여량");
    expect((await put({ totalGrantedMinutes: 480, remainingMinutes: 480 })).statusCode).toBe(200);
    expect((await put({ baseDate: "2025-12-31" })).statusCode).toBe(400);
    expect((await put({ remainingMinutes: 15 })).statusCode).toBe(400);
    expect((await put({ employeeId: 999 })).statusCode).toBe(400);
    expect((await put({ leaveTypeId: 999 })).statusCode).toBe(400);
    expect(audits(db)).toHaveLength(1);
  });

  it("목록 필터(연도·직원)", async () => {
    const { app, db, put, emp, comp } = await setup();
    const other = insertEmployee(db, { name: "김철수" });
    await put({});
    await put({ leaveTypeId: comp, totalGrantedMinutes: 300, remainingMinutes: 60 });
    await put({ employeeId: other });
    await put({ year: 2025, baseDate: "2025-06-01" });
    const get = async (q: string) => (await app.inject({ method: "GET", url: `/api/opening-balances${q}` })).json();
    expect(await get("")).toHaveLength(4);
    expect(await get("?year=2026")).toHaveLength(3);
    expect(await get(`?year=2026&employeeId=${emp}`)).toHaveLength(2);
    // 이름순 → 김철수 먼저
    expect((await get("?year=2026"))[0].employeeId).toBe(other);
  });

  it("삭제: 204 + 이력, 없으면 404", async () => {
    const { app, db, put, emp, annual } = await setup();
    const id = (await put({})).json().id;
    const res = await app.inject({ method: "DELETE", url: `/api/opening-balances/${id}` });
    expect(res.statusCode).toBe(204);
    expect(queryAll(db, "SELECT * FROM opening_balances")).toEqual([]);
    expect(audits(db).map((a) => a.action)).toEqual(["create", "delete"]);
    expect(getEmployeeBalances(db, emp, 2026).find((b) => b.leaveTypeId === annual)!.grantedMinutes).toBe(0);
    expect((await app.inject({ method: "DELETE", url: `/api/opening-balances/${id}` })).statusCode).toBe(404);
  });
});
