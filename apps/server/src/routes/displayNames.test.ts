import type { LeavePreview, LeavePrintData, LeaveSaveResult, LeaveType } from "@leave-flow/shared";
import { describe, expect, it } from "vitest";
import { queryAll } from "../db/index.ts";
import { createTestApp, insertCategory, insertEmployee, insertGrant, type TestApp } from "../testing.ts";

const typeBody = (name: string, categories: string[] | null, over: object = {}) => ({
  name,
  displayName: "연차",
  deducts: true,
  balanceMode: "expire_date",
  expireMonth: 12,
  expireDay: 31,
  sortOrder: 1,
  target: categories ? { categories } : null,
  ...over,
});

/** 정규직 홍길동, 강사 김강사 / 연차(직원)·연차(강사) (표시 이름 둘 다 "연차") */
async function setup() {
  const t = await createTestApp();
  insertCategory(t.db, "정규직");
  insertCategory(t.db, "강사");
  const staff = insertEmployee(t.db, { name: "홍길동", category: "정규직" });
  const lecturer = insertEmployee(t.db, { name: "김강사", category: "강사" });
  const post = async (body: object) => t.app.inject({ method: "POST", url: "/api/leave-types", payload: body });
  const staffType = (await post(typeBody("연차(직원)", ["정규직"]))).json<LeaveType>().id;
  const res = await post(typeBody("연차(강사)", ["강사"], { expireMonth: 2, expireDay: 28 }));
  expect(res.statusCode).toBe(201);
  const lecturerType = res.json<LeaveType>().id;
  return { ...t, staff, lecturer, staffType, lecturerType, post };
}

const leaveBody = (employeeId: number, leaveTypeId: number, day = "2026-10-26") => ({
  employeeId,
  items: [{ leaveTypeId, startAt: `${day}T10:00`, endAt: `${day}T19:00` }],
  reason: "개인 사유",
  emergencyContact: "010-1234-5678",
  handoverNote: "",
});

const createLeave = async (t: TestApp, employeeId: number, leaveTypeId: number, day?: string) => {
  const res = await t.app.inject({ method: "POST", url: "/api/leave-requests", payload: leaveBody(employeeId, leaveTypeId, day) });
  expect(res.statusCode).toBe(201);
  return res.json<LeaveSaveResult>();
};

describe("휴가 종류 표시 이름", () => {
  it("관리 이름은 겹치면 안 되고, 표시 이름은 대상이 겹치지 않으면 같아도 됨", async () => {
    const t = await setup();
    const types = (await t.app.inject({ url: "/api/leave-types" })).json<LeaveType[]>();
    expect(types.map((x) => [x.name, x.displayName])).toEqual([
      ["연차(직원)", "연차"],
      ["연차(강사)", "연차"],
    ]);
    // 관리 이름 중복은 그대로 409
    expect((await t.post(typeBody("연차(강사)", ["강사"]))).statusCode).toBe(409);
    // 표시 이름 생략 = 빈 값
    const sick = await t.post({ name: "병가", deducts: true, balanceMode: "yearly", sortOrder: 2 });
    expect(sick.json<LeaveType>().displayName).toBe("");
  });

  it("한 직원에게 같은 표시 이름이 둘 이상 적용되면 409 (저장 안 됨)", async () => {
    const t = await setup();
    // 전체 직원 대상 "연차" → 모두 겹침
    const all = await t.post(typeBody("연차(전체)", null));
    expect(all.statusCode).toBe(409);
    expect(all.json().error).toContain("홍길동: '연차' 2개 - 연차(직원), 연차(전체)");
    expect(queryAll(t.db, "SELECT * FROM leave_types WHERE name = '연차(전체)'")).toEqual([]);

    // 수정으로 대상을 넓혀도 409
    const widen = await t.app.inject({
      method: "PUT",
      url: `/api/leave-types/${t.lecturerType}`,
      payload: typeBody("연차(강사)", ["강사", "정규직"], { expireMonth: 2, expireDay: 28 }),
    });
    expect(widen.statusCode).toBe(409);

    // 직원의 구분을 바꿔도 겹치지 않음 (한 직원에게 하나만 적용)
    const move = await t.app.inject({
      method: "PUT",
      url: `/api/employees/${t.staff}`,
      payload: {
        name: "홍길동",
        department: "",
        color: "#4f7cff",
        workDays: [1, 2, 3, 4, 5],
        workStart: "10:00",
        workEnd: "19:00",
        emergencyContact: "",
        approvalRoles: ["담당", "센터장"],
        category: "강사",
      },
    });
    expect(move.statusCode).toBe(200);

    // 비활성화해 둔 종류를 다시 켜서 겹치면 409
    await t.app.inject({ method: "POST", url: `/api/leave-types/${t.staffType}/deactivate` });
    await t.app.inject({
      method: "PUT",
      url: `/api/leave-types/${t.staffType}`,
      payload: typeBody("연차(직원)", ["강사"]),
    });
    expect((await t.app.inject({ method: "POST", url: `/api/leave-types/${t.staffType}/activate` })).statusCode).toBe(409);
  });

  it("휴가원·양식·달력·경고에는 표시 이름", async () => {
    const t = await setup();
    insertGrant(t.db, { employeeId: t.lecturer, leaveTypeId: t.lecturerType, grantDate: "2026-03-01", minutes: 480 });
    const { request } = await createLeave(t, t.lecturer, t.lecturerType);
    expect(request.items[0]).toMatchObject({ leaveTypeName: "연차(강사)", leaveTypeDisplayName: "연차" });

    const print = (await t.app.inject({ url: `/api/leave-requests/${request.id}/print-data` })).json<LeavePrintData>();
    expect(print.checkboxes.map((c) => [c.name, c.checked])).toEqual([["연차", true]]);
    expect(print.balanceTable.map((b) => b.name)).toEqual(["연차"]);

    const events = (await t.app.inject({ url: "/api/calendar/events?from=2026-10-01&to=2026-10-31" })).json<
      { leaveTypeName: string }[]
    >();
    expect(events.map((e) => e.leaveTypeName)).toEqual(["연차"]);

    // 잔여 부족 경고
    const preview = await t.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: { employeeId: t.lecturer, items: leaveBody(t.lecturer, t.lecturerType, "2026-10-27").items },
    });
    expect(preview.json<LeavePreview>().warnings.map((w) => w.message)).toContain(
      "연차 잔여가 부족합니다. (2026.03.01.~2027.02.28. 신청 후 잔여 -1일)",
    );
  });

  it("구분이 바뀌어 한 양식에 같은 표시 이름이 둘이면 관리 이름으로 구별", async () => {
    const t = await setup();
    insertGrant(t.db, { employeeId: t.staff, leaveTypeId: t.staffType, grantDate: "2026-01-01", minutes: 480 * 15 });
    await createLeave(t, t.staff, t.staffType, "2026-10-26");
    // 강사가 됨 → 새 휴가원은 연차(강사)
    await t.app.inject({
      method: "PUT",
      url: `/api/employees/${t.staff}`,
      payload: {
        name: "홍길동",
        department: "",
        color: "#4f7cff",
        workDays: [1, 2, 3, 4, 5],
        workStart: "10:00",
        workEnd: "19:00",
        emergencyContact: "",
        approvalRoles: ["담당", "센터장"],
        category: "강사",
      },
    });
    const { request } = await createLeave(t, t.staff, t.lecturerType, "2026-10-28");
    const print = (await t.app.inject({ url: `/api/leave-requests/${request.id}/print-data` })).json<LeavePrintData>();
    expect(print.checkboxes.map((c) => [c.name, c.checked])).toEqual([
      ["연차(직원)", false],
      ["연차(강사)", true],
    ]);
  });
});
