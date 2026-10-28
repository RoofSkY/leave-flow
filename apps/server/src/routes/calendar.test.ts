import type { Absences, CalendarEvent, LeaveSaveResult } from "@leave-flow/shared";
import { describe, expect, it } from "vitest";
import { execute } from "../db/index.ts";
import { createTestApp, insertEmployee, insertHoliday, insertLeaveType } from "../testing.ts";

async function setup() {
  const t = await createTestApp();
  const hong = insertEmployee(t.db, { name: "홍길동", color: "#ff0000" });
  const kim = insertEmployee(t.db, { name: "김철수", color: "#00ff00", workDays: [1, 2, 3], workStart: "13:00", workEnd: "18:00" });
  const annual = insertLeaveType(t.db, { name: "연차" });
  const create = async (employeeId: number, items: { startAt: string; endAt: string }[]) => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/leave-requests",
      payload: {
        employeeId,
        items: items.map((i) => ({ ...i, leaveTypeId: annual })),
        reason: "개인 사유",
        emergencyContact: "010-1234-5678",
        handoverNote: "",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<LeaveSaveResult>().request;
  };
  return { ...t, hong, kim, annual, create };
}

describe("달력 일정", () => {
  it("기간과 겹치는 항목, 취소된 휴가원은 includeCancelled=1 일 때만", async () => {
    const s = await setup();
    const a = await s.create(s.hong, [
      { startAt: "2026-09-30T10:00", endAt: "2026-10-01T19:00" },
      { startAt: "2026-10-15T10:00", endAt: "2026-10-15T12:00" },
    ]);
    const b = await s.create(s.kim, [{ startAt: "2026-10-05T13:00", endAt: "2026-10-05T18:00" }]);
    await s.create(s.hong, [{ startAt: "2026-11-02T10:00", endAt: "2026-11-02T19:00" }]);
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${b.id}/cancel` });

    const events = async (q: string) =>
      (await s.app.inject({ url: `/api/calendar/events${q}` })).json<CalendarEvent[]>();
    const october = await events("?from=2026-10-01&to=2026-10-31");
    expect(october.map((e) => e.startAt)).toEqual(["2026-09-30T10:00", "2026-10-15T10:00"]);
    expect(october[0]).toEqual({
      itemId: a.items[0]!.id,
      requestId: a.id,
      employeeId: s.hong,
      employeeName: "홍길동",
      department: "아동사업부",
      category: "",
      color: "#ff0000",
      leaveTypeName: "연차",
      startAt: "2026-09-30T10:00",
      endAt: "2026-10-01T19:00",
      minutes: 960,
      status: "active",
      workDays: [1, 2, 3, 4, 5],
      workStart: "10:00",
      workEnd: "19:00",
    });

    const withCancelled = await events("?from=2026-10-01&to=2026-10-31&includeCancelled=1");
    expect(withCancelled.map((e) => [e.employeeName, e.status])).toEqual([
      ["홍길동", "active"],
      ["김철수", "cancelled"],
      ["홍길동", "active"],
    ]);
    expect((await events("?from=2026-10-02&to=2026-10-04")).length).toBe(0);
    expect((await events("?from=2026-10-01&to=2026-10-01")).length).toBe(1);
  });

  it("주 보기 나누기용 근무 일정은 직원 현재 값이 아니라 휴가원에 저장된 값", async () => {
    const s = await setup();
    await s.create(s.hong, [{ startAt: "2026-10-21T14:00", endAt: "2026-10-23T12:00" }]);
    execute(s.db, "UPDATE employees SET work_days = '[1,2,3]', work_start = '09:00', work_end = '18:00' WHERE id = ?", [
      s.hong,
    ]);
    const [ev] = (await s.app.inject({ url: "/api/calendar/events?from=2026-10-19&to=2026-10-25" })).json<CalendarEvent[]>();
    expect(ev).toMatchObject({ workDays: [1, 2, 3, 4, 5], workStart: "10:00", workEnd: "19:00", minutes: 300 + 480 + 120 });
  });

  it("필터용 소속·구분은 휴가원에 저장된 값이 아니라 직원의 지금 값", async () => {
    const s = await setup();
    execute(s.db, "UPDATE employees SET category = '직원' WHERE id = ?", [s.hong]);
    await s.create(s.hong, [{ startAt: "2026-10-21T10:00", endAt: "2026-10-21T19:00" }]);
    execute(s.db, "UPDATE employees SET department = '가족사업부', category = '강사' WHERE id = ?", [s.hong]);
    const [ev] = (await s.app.inject({ url: "/api/calendar/events?from=2026-10-19&to=2026-10-25" })).json<CalendarEvent[]>();
    expect(ev).toMatchObject({ employeeId: s.hong, department: "가족사업부", category: "강사" });
  });

  it("기간이 없거나 잘못되면 400", async () => {
    const s = await setup();
    expect((await s.app.inject({ url: "/api/calendar/events" })).statusCode).toBe(400);
    expect((await s.app.inject({ url: "/api/calendar/events?from=2026-10-31&to=2026-10-01" })).statusCode).toBe(400);
    expect((await s.app.inject({ url: "/api/calendar/events?from=2026-10&to=2026-10-31" })).statusCode).toBe(400);
  });
});

describe("부재자", () => {
  it("오늘 = 그날 사용 시간이 있는 항목, 이번 주 = 월~일 (휴무일·근무하지 않는 날 제외)", async () => {
    const s = await setup();
    insertHoliday(s.db, { date: "2026-10-20", name: "센터 휴무", kind: "center" });
    // 홍길동: 10/16(금) ~ 10/21(수) → 오늘(10/19 월) 8h, 이번 주는 10/19, 10/21 (10/20 휴무)
    const a = await s.create(s.hong, [{ startAt: "2026-10-16T10:00", endAt: "2026-10-21T15:00" }]);
    // 김철수: 10/19 오후 반나절
    const b = await s.create(s.kim, [{ startAt: "2026-10-19T15:30", endAt: "2026-10-19T18:00" }]);
    // 김철수: 10/21 수요일
    const c = await s.create(s.kim, [{ startAt: "2026-10-21T13:00", endAt: "2026-10-21T18:00" }]);
    // 지난주·다음 주·취소된 휴가는 제외
    await s.create(s.hong, [{ startAt: "2026-10-12T10:00", endAt: "2026-10-12T19:00" }]);
    await s.create(s.hong, [{ startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" }]);
    const d = await s.create(s.hong, [{ startAt: "2026-10-23T10:00", endAt: "2026-10-23T19:00" }]);
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${d.id}/cancel` });

    const res = await s.app.inject({ url: "/api/absences" });
    expect(res.statusCode).toBe(200);
    const data = res.json<Absences>();
    expect(data).toMatchObject({ date: "2026-10-19", weekStart: "2026-10-19", weekEnd: "2026-10-25" });
    expect(data.today.map((r) => [r.requestId, r.minutes])).toEqual([
      [a.id, 480],
      [b.id, 150],
    ]);
    expect(data.today[0]).toMatchObject({
      employeeName: "홍길동",
      color: "#ff0000",
      leaveTypeName: "연차",
      startAt: "2026-10-16T10:00",
      endAt: "2026-10-21T15:00",
    });
    expect(data.week.map((r) => [r.requestId, r.minutes])).toEqual([
      [a.id, 480 + 240],
      [b.id, 150],
      [c.id, 300],
    ]);
  });

  it("이번 주에 이미 끝난 휴가는 그 날에 휴무일을 추가해도 저장된 사용 시간 그대로", async () => {
    const s = await setup();
    const a = await s.create(s.hong, [{ startAt: "2026-10-19T10:00", endAt: "2026-10-19T19:00" }]);
    s.setToday("2026-10-21");
    const add = await s.app.inject({
      method: "POST",
      url: "/api/holidays",
      payload: { date: "2026-10-19", name: "센터 휴무", kind: "center" },
    });
    expect(add.json().recalculated).toEqual([]);
    const data = (await s.app.inject({ url: "/api/absences" })).json<Absences>();
    expect(data.week.map((r) => [r.requestId, r.minutes])).toEqual([[a.id, 480]]);
  });

  it("date 지정: 그 날짜가 속한 주(월~일), 잘못된 날짜는 400", async () => {
    const s = await setup();
    await s.create(s.hong, [{ startAt: "2026-10-30T10:00", endAt: "2026-10-30T19:00" }]);
    const data = (await s.app.inject({ url: "/api/absences?date=2026-11-01" })).json<Absences>();
    expect(data).toMatchObject({ date: "2026-11-01", weekStart: "2026-10-26", weekEnd: "2026-11-01" });
    expect(data.today).toEqual([]);
    expect(data.week).toHaveLength(1);
    expect((await s.app.inject({ url: "/api/absences?date=2026-02-30" })).statusCode).toBe(400);
  });
});
