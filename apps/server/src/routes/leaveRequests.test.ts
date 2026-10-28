import { needsReprint, type LeavePreview, type LeavePrintData, type LeaveRequest, type LeaveSaveResult } from "@leave-flow/shared";
import { describe, expect, it } from "vitest";
import { execute, queryAll, queryOne } from "../db/index.ts";
import { ZERO_MINUTES_MESSAGE } from "../services/leaveRequests.ts";
import {
  createTestApp,
  insertCategory,
  insertDepartment,
  insertEmployee,
  insertGrant,
  insertHoliday,
  insertLeaveType,
  updatedAtOf,
} from "../testing.ts";

async function setup() {
  const t = await createTestApp();
  const emp = insertEmployee(t.db, { name: "홍길동", department: "아동사업부" });
  const annual = insertLeaveType(t.db, { name: "연차", sortOrder: 1 });
  const sick = insertLeaveType(t.db, { name: "병가", sortOrder: 2 });
  insertGrant(t.db, { employeeId: emp, leaveTypeId: annual, grantDate: "2026-01-01", minutes: 15 * 480 });

  const body = (items: { leaveTypeId: number; startAt: string; endAt: string }[], extra: object = {}) => ({
    employeeId: emp,
    items,
    reason: "개인 사유",
    emergencyContact: "010-1234-5678",
    handoverNote: "",
    ...extra,
  });
  const create = async (items: { leaveTypeId: number; startAt: string; endAt: string }[], extra: object = {}) =>
    t.app.inject({ method: "POST", url: "/api/leave-requests", payload: body(items, extra) });
  /** 수정 저장: 지금 저장된 수정 일시를 baseUpdatedAt 으로 (payload 로 바꿀 수 있음) */
  const put = (id: number, payload: object) =>
    t.app.inject({
      method: "PUT",
      url: `/api/leave-requests/${id}`,
      payload: { baseUpdatedAt: updatedAtOf(t.db, "leave_requests", id), ...payload },
    });
  const createOk = async (items: { leaveTypeId: number; startAt: string; endAt: string }[]) => {
    const res = await create(items);
    expect(res.statusCode).toBe(201);
    return res.json<LeaveSaveResult>();
  };
  const audits = (action: string) =>
    queryAll<{ summary: string; employee_id: number; entity_id: number }>(
      t.db,
      "SELECT * FROM audit_logs WHERE entity = 'leave_request' AND action = ?",
      [action],
    );
  return { ...t, emp, annual, sick, body, create, put, createOk, audits };
}

describe("휴가원 작성", () => {
  it("저장: 신청 시점 값 보관, 사용 시간 계산, 항목 순서, 변경 이력", async () => {
    const s = await setup();
    const { request, warnings } = await s.createOk([
      { leaveTypeId: s.sick, startAt: "2026-10-01T14:00", endAt: "2026-10-02T19:00" },
      { leaveTypeId: s.annual, startAt: "2026-09-29T10:00", endAt: "2026-09-29T15:00" },
    ]);
    // 병가는 부여가 없음 → 잔여 초과 경고 (저장은 됨)
    expect(warnings).toEqual([
      { code: "over_balance", message: "병가 잔여가 부족합니다. (2026년 신청 후 잔여 -1일 5시간)" },
    ]);
    expect(request).toMatchObject({
      employeeId: s.emp,
      employeeName: "홍길동",
      department: "아동사업부",
      appliedOn: "2026-10-19",
      workDays: [1, 2, 3, 4, 5],
      workStart: "10:00",
      workEnd: "19:00",
      reason: "개인 사유",
      emergencyContact: "010-1234-5678",
      status: "active",
      cancelledAt: null,
      totalMinutes: 780 + 240,
    });
    // 입력 순서 유지
    expect(request.items.map((i) => [i.leaveTypeName, i.minutes])).toEqual([
      ["병가", 5 * 60 + 8 * 60],
      ["연차", 4 * 60],
    ]);
    expect(request.items[0]!.minutesByYear).toEqual({ "2026": 780 });
    const log = s.audits("create");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ employee_id: s.emp, entity_id: request.id });
    expect(log[0]!.summary).toContain("홍길동 휴가원 작성");

    const balances = (await s.app.inject({ url: `/api/balances?employeeId=${s.emp}&year=2026` })).json();
    expect(balances[0]).toMatchObject({ leaveTypeId: s.annual, usedMinutes: 240, remainingMinutes: 15 * 480 - 240 });
  });

  it("공휴일·휴무일은 사용 시간에서 제외, 0분이면 400", async () => {
    const s = await setup();
    insertHoliday(s.db, { date: "2026-10-05", name: "센터 휴무", kind: "center" });
    const res = await s.create([{ leaveTypeId: s.annual, startAt: "2026-10-05T10:00", endAt: "2026-10-05T19:00" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(ZERO_MINUTES_MESSAGE);

    const lunch = await s.create([{ leaveTypeId: s.annual, startAt: "2026-10-06T12:00", endAt: "2026-10-06T13:00" }]);
    expect(lunch.statusCode).toBe(400);
    expect(lunch.json().error).toBe(ZERO_MINUTES_MESSAGE);

    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-02T10:00", endAt: "2026-10-06T19:00" },
    ]);
    // 10/2(금) + 10/6(화) — 10/3·4 주말, 10/5 휴무
    expect(request.items[0]!.minutes).toBe(960);
    expect(s.audits("create")).toHaveLength(1);
  });

  it("근무 일정 검사: 근무 요일·근무시간·10분 단위 (여러 항목이면 몇 번째인지)", async () => {
    const s = await setup();
    const cases: [string, string, string][] = [
      ["2026-10-03T10:00", "2026-10-03T19:00", "시작일이 근무 요일이 아닙니다."],
      ["2026-10-01T09:00", "2026-10-01T19:00", "시작 시각이 근무시간 밖입니다."],
      ["2026-10-01T10:05", "2026-10-01T19:00", "휴가는 10분 단위로 입력해야 합니다."],
      ["2026-10-01T15:00", "2026-10-01T10:00", "종료일시는 시작일시보다 뒤여야 합니다."],
    ];
    for (const [startAt, endAt, message] of cases) {
      const res = await s.create([{ leaveTypeId: s.annual, startAt, endAt }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(message);
    }
    const multi = await s.create([
      { leaveTypeId: s.annual, startAt: "2026-10-01T10:00", endAt: "2026-10-01T19:00" },
      { leaveTypeId: s.annual, startAt: "2026-10-04T10:00", endAt: "2026-10-04T19:00" },
    ]);
    expect(multi.statusCode).toBe(400);
    expect(multi.json().error).toBe("2번째 항목: 시작일이 근무 요일이 아닙니다.");
    expect(queryAll(s.db, "SELECT * FROM leave_requests")).toEqual([]);
    expect(s.audits("create")).toEqual([]);
  });

  it("직원 근무시간에 따른 반차 경계(10분 단위가 아님)도 허용", async () => {
    const s = await setup();
    const short = insertEmployee(s.db, { name: "김단축", workStart: "13:00", workEnd: "18:10" });
    const res = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests",
      payload: {
        ...s.body([{ leaveTypeId: s.annual, startAt: "2026-10-01T13:00", endAt: "2026-10-01T15:35" }]),
        employeeId: short,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().request.items[0].minutes).toBe(155);
  });

  it("직원·종류 검사: 없는 직원 404, 비활성 직원·종류 400, 항목 없음 400", async () => {
    const s = await setup();
    const inactiveEmp = insertEmployee(s.db, { name: "퇴사자", active: false });
    const oldType = insertLeaveType(s.db, { name: "옛 휴가", active: false });
    const item = { leaveTypeId: s.annual, startAt: "2026-10-01T10:00", endAt: "2026-10-01T19:00" };

    expect((await s.create([item], { employeeId: 999 })).statusCode).toBe(404);
    const inactive = await s.create([item], { employeeId: inactiveEmp });
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().error).toContain("비활성 직원");
    const badType = await s.create([{ ...item, leaveTypeId: oldType }]);
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toContain("옛 휴가");
    expect((await s.create([{ ...item, leaveTypeId: 999 }])).statusCode).toBe(400);
    const empty = await s.create([]);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("휴가 항목을 하나 이상 추가하세요.");
  });

  it("휴가사유·비상연락처는 필수: 비었거나 공백뿐이면 400 (수정도)", async () => {
    const s = await setup();
    const item = { leaveTypeId: s.annual, startAt: "2026-10-01T10:00", endAt: "2026-10-01T19:00" };
    for (const [extra, message] of [
      [{ reason: "" }, "휴가사유를 입력하세요."],
      [{ reason: "   " }, "휴가사유를 입력하세요."],
      [{ emergencyContact: "" }, "비상연락처를 입력하세요."],
      [{ emergencyContact: " " }, "비상연락처를 입력하세요."],
    ] as const) {
      const res = await s.create([item], extra);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(message);
    }
    expect(queryAll(s.db, "SELECT * FROM leave_requests")).toEqual([]);

    const { request } = await s.createOk([item]);
    const put = await s.put(request.id, s.body([item], { reason: "", emergencyContact: "" }));
    expect(put.statusCode).toBe(400);
    expect(queryAll(s.db, "SELECT reason, emergency_contact FROM leave_requests")).toEqual([
      { reason: "개인 사유", emergency_contact: "010-1234-5678" },
    ]);
  });

  it("경고: 잔여 초과, 기존 휴가와 겹침, 항목끼리 겹침 (저장은 됨)", async () => {
    const s = await setup();
    const special = insertLeaveType(s.db, { name: "특별휴가", sortOrder: 3 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: special, grantDate: "2026-01-01", minutes: 480 });
    await s.createOk([{ leaveTypeId: s.sick, startAt: "2026-10-01T10:00", endAt: "2026-10-01T19:00" }]);

    const { request, warnings } = await s.createOk([
      { leaveTypeId: special, startAt: "2026-10-01T15:00", endAt: "2026-10-02T19:00" },
      { leaveTypeId: s.annual, startAt: "2026-10-02T10:00", endAt: "2026-10-02T12:00" },
    ]);
    expect(request.id).toBeGreaterThan(0);
    const codes = warnings.map((w) => w.code);
    expect(codes).toEqual(["over_balance", "overlap_existing", "overlap_items"]);
    expect(warnings[0]!.message).toContain("특별휴가");
    expect(warnings[0]!.message).toContain("-4시간");
    expect(warnings[1]!.message).toContain("병가");
    expect(warnings[2]!.message).toContain("1번째와 2번째");
  });

  it("잔여 초과 경고: 누적 종류는 이미 신청한 뒤 연도 잔여도 확인, 연도별 종류는 그 해만", async () => {
    const s = await setup();
    const substitute = insertLeaveType(s.db, { name: "대체휴가", balanceMode: "cumulative", sortOrder: 3 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: substitute, grantDate: "2026-01-01", minutes: 480 });
    // 다음 해 대체휴가 8h: 누적 잔여 8h 안이라 경고 없음
    const next = await s.createOk([{ leaveTypeId: substitute, startAt: "2027-01-05T10:00", endAt: "2027-01-05T19:00" }]);
    expect(next.warnings).toEqual([]);

    // 올해 대체휴가 8h: 2026년 잔여는 0이지만 2027년 누적 잔여가 -8h
    const item = { leaveTypeId: substitute, startAt: "2026-10-20T10:00", endAt: "2026-10-20T19:00" };
    const preview = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: { employeeId: s.emp, items: [item] },
    });
    const expected = [{ code: "over_balance", message: "대체휴가 잔여가 부족합니다. (2027년 신청 후 잔여 -1일)" }];
    expect(preview.json<LeavePreview>().warnings).toEqual(expected);
    const { request, warnings } = await s.createOk([item]);
    expect(warnings).toEqual(expected);
    const balances = (await s.app.inject({ url: `/api/balances?employeeId=${s.emp}&year=2027` })).json<
      { leaveTypeId: number; remainingMinutes: number }[]
    >();
    expect(balances.find((b) => b.leaveTypeId === substitute)?.remainingMinutes).toBe(-480);

    // 수정 시 자기 자신은 빼고 계산, 그 뒤 연도 부여가 있으면 그 해도 확인 (잔여 충분하면 경고 없음)
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: substitute, grantDate: "2027-01-02", minutes: 480 });
    const put = await s.put(request.id, s.body([item]));
    expect(put.json<LeaveSaveResult>().warnings).toEqual([]);

    // 연도별 종류(연차): 다음 해 잔여가 이미 음수여도 올해 신청에는 경고 없음
    const annualNext = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2027-01-06T10:00", endAt: "2027-01-06T19:00" },
    ]);
    expect(annualNext.warnings.map((w) => w.code)).toEqual(["over_balance"]);
    const annualNow = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-21T10:00", endAt: "2026-10-21T19:00" },
    ]);
    expect(annualNow.warnings).toEqual([]);
  });

  it("잔여 초과 경고: 소진 종류도 누적처럼 뒤 연도 잔여까지 확인", async () => {
    const s = await setup();
    const special = insertLeaveType(s.db, { name: "경조휴가", balanceMode: "used_up", sortOrder: 3 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: special, grantDate: "2026-01-01", minutes: 480 });
    const next = await s.createOk([{ leaveTypeId: special, startAt: "2027-01-05T10:00", endAt: "2027-01-05T19:00" }]);
    expect(next.warnings).toEqual([]);
    const now = await s.createOk([{ leaveTypeId: special, startAt: "2026-10-20T10:00", endAt: "2026-10-20T19:00" }]);
    expect(now.warnings).toEqual([
      { code: "over_balance", message: "경조휴가 잔여가 부족합니다. (2027년 신청 후 잔여 -1일)" },
    ]);
  });

  it("목록: 상태·직원·기간 필터, 첫 항목 시작 내림차순", async () => {
    const s = await setup();
    const other = insertEmployee(s.db, { name: "김철수" });
    const a = (await s.createOk([{ leaveTypeId: s.annual, startAt: "2026-10-01T10:00", endAt: "2026-10-01T19:00" }]))
      .request;
    const b = (await s.createOk([{ leaveTypeId: s.annual, startAt: "2026-11-02T10:00", endAt: "2026-11-02T19:00" }]))
      .request;
    const c = (
      await s.app.inject({
        method: "POST",
        url: "/api/leave-requests",
        payload: {
          ...s.body([{ leaveTypeId: s.annual, startAt: "2026-10-20T10:00", endAt: "2026-10-22T19:00" }]),
          employeeId: other,
        },
      })
    ).json<LeaveSaveResult>().request;
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${b.id}/cancel` });

    const ids = async (q: string) =>
      (await s.app.inject({ url: `/api/leave-requests${q}` })).json<LeaveRequest[]>().map((r) => r.id);
    expect(await ids("")).toEqual([c.id, a.id]);
    expect(await ids("?status=all")).toEqual([b.id, c.id, a.id]);
    expect(await ids("?status=cancelled")).toEqual([b.id]);
    expect(await ids(`?employeeId=${s.emp}&status=all`)).toEqual([b.id, a.id]);
    expect(await ids("?from=2026-10-21&to=2026-10-31")).toEqual([c.id]);
    expect(await ids("?from=2026-10-01&to=2026-10-01")).toEqual([a.id]);
    expect((await s.app.inject({ url: "/api/leave-requests?status=x" })).statusCode).toBe(400);
    expect((await s.app.inject({ url: "/api/leave-requests?from=2026-13-01" })).statusCode).toBe(400);
  });

  it("상세: 없으면 404", async () => {
    const s = await setup();
    const res = await s.app.inject({ url: "/api/leave-requests/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("휴가원을 찾을 수 없습니다.");
  });
});

describe("휴가원 수정", () => {
  it("근무 일정만 수정 시점 값으로 다시 저장 (성명·소속·신청일자 유지)", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
    ]);
    execute(
      s.db,
      "UPDATE employees SET name = '홍길순', department = '지원사업부', work_start = '09:00', work_end = '18:00', work_days = '[1,2,3]'",
    );
    s.setToday("2026-10-21");
    const res = await s.put(
      request.id,
      s.body(
        [
          { leaveTypeId: s.sick, startAt: "2026-10-27T09:00", endAt: "2026-10-27T13:00" },
          { leaveTypeId: s.annual, startAt: "2026-10-26T09:00", endAt: "2026-10-26T18:00" },
        ],
        { reason: "병원" },
      ),
    );
    expect(res.statusCode).toBe(200);
    const updated = res.json<LeaveSaveResult>().request;
    expect(updated).toMatchObject({
      employeeName: "홍길동",
      department: "아동사업부",
      appliedOn: "2026-10-19",
      workDays: [1, 2, 3],
      workStart: "09:00",
      workEnd: "18:00",
      reason: "병원",
    });
    expect(updated.items.map((i) => [i.leaveTypeName, i.minutes])).toEqual([
      ["병가", 180],
      ["연차", 480],
    ]);
    expect(queryAll(s.db, "SELECT * FROM leave_request_items")).toHaveLength(2);
    const log = s.audits("update");
    expect(log).toHaveLength(1);
    expect(log[0]!.employee_id).toBe(s.emp);
  });

  it("이미 있던 비활성 종류는 허용, 새로 넣는 비활성 종류는 400", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.sick, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
    ]);
    const old = insertLeaveType(s.db, { name: "옛 휴가", active: false });
    execute(s.db, "UPDATE leave_types SET active = 0 WHERE id = ?", [s.sick]);
    const put = (items: object[]) => s.put(request.id, s.body(items as never));
    expect(
      (await put([{ leaveTypeId: s.sick, startAt: "2026-10-27T10:00", endAt: "2026-10-27T19:00" }])).statusCode,
    ).toBe(200);
    expect(
      (await put([{ leaveTypeId: old, startAt: "2026-10-27T10:00", endAt: "2026-10-27T19:00" }])).statusCode,
    ).toBe(400);
  });

  it("취소된 휴가원 수정 409, 직원 변경 400, 없으면 404", async () => {
    const s = await setup();
    const other = insertEmployee(s.db, { name: "김철수" });
    const item = { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" };
    const { request } = await s.createOk([item]);
    const put = (id: number, extra: object = {}) => s.put(id, s.body([item], extra));
    expect((await put(request.id, { employeeId: other })).statusCode).toBe(400);
    expect((await put(999)).statusCode).toBe(404);
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/cancel` });
    const res = await put(request.id);
    expect(res.statusCode).toBe(409);
    expect(s.audits("update")).toEqual([]);
  });

  it("수정 시 경고는 자기 자신과 겹침으로 보지 않음", async () => {
    const s = await setup();
    const item = { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" };
    const { request } = await s.createOk([item]);
    const res = await s.put(request.id, s.body([item]));
    expect(res.json<LeaveSaveResult>().warnings).toEqual([]);
  });

  it("수정 창을 연 뒤 다른 사람이 먼저 저장했으면 409 (덮어쓰지 않음), 수정 시작 시점이 없으면 400", async () => {
    const s = await setup();
    const item = { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" };
    const { request } = await s.createOk([item]);
    s.setToday("2026-10-20");
    // 두 사람이 같은 휴가원(request.updatedAt)을 열어 두고 차례로 저장
    const first = await s.put(request.id, { ...s.body([item], { reason: "먼저 저장" }), baseUpdatedAt: request.updatedAt });
    expect(first.statusCode).toBe(200);
    const second = await s.put(request.id, { ...s.body([item], { reason: "나중 저장" }), baseUpdatedAt: request.updatedAt });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("다른 사람이 이 휴가원을 먼저 수정했습니다.");
    expect(queryOne(s.db, "SELECT reason FROM leave_requests")).toEqual({ reason: "먼저 저장" });
    expect(s.audits("update")).toHaveLength(1);

    const noBase = await s.app.inject({ method: "PUT", url: `/api/leave-requests/${request.id}`, payload: s.body([item]) });
    expect(noBase.statusCode).toBe(400);
  });

  it("출력 뒤 수정·복구하면 다시 출력 필요 (다시 출력하면 풀림, 공휴일 재계산은 해당 없음)", async () => {
    const s = await setup();
    const item = { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-27T19:00" };
    const { request } = await s.createOk([item]);
    const get = async () => (await s.app.inject({ url: `/api/leave-requests/${request.id}` })).json<LeaveRequest>();
    const print = () => s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/print` });
    await print();
    expect(needsReprint(await get())).toBe(false);

    s.setToday("2026-10-20");
    expect((await s.put(request.id, s.body([item], { reason: "바꾼 사유" }))).statusCode).toBe(200);
    expect(needsReprint(await get())).toBe(true);
    await print();
    expect(needsReprint(await get())).toBe(false);

    // 공휴일 추가로 사용 시간만 다시 계산됨 → 수정 일시는 그대로
    s.setToday("2026-10-21");
    const holiday = await s.app.inject({
      method: "POST",
      url: "/api/holidays",
      payload: { date: "2026-10-27", name: "임시공휴일", kind: "public" },
    });
    expect(holiday.statusCode).toBe(201);
    const recalculated = await get();
    expect(recalculated.totalMinutes).toBe(480);
    expect(needsReprint(recalculated)).toBe(false);

    s.setToday("2026-10-22");
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/cancel` });
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/restore` });
    expect(needsReprint(await get())).toBe(true);
  });
});

describe("휴가원 취소·복구", () => {
  it("취소: 상태만 바꾸고 잔여 복구, 두 번 취소 409", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
    ]);
    const res = await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json<LeaveSaveResult>()).toMatchObject({
      request: { status: "cancelled", cancelledAt: "2026-10-19 09:00:00" },
      warnings: [],
    });
    expect(queryAll(s.db, "SELECT * FROM leave_request_items")).toHaveLength(1);
    const balances = (await s.app.inject({ url: `/api/balances?employeeId=${s.emp}&year=2026` })).json();
    expect(balances[0].usedMinutes).toBe(0);
    expect(s.audits("cancel")[0]!.summary).toBe("홍길동 휴가원 취소 (연차 2026.10.26. 10:00 ~ 19:00)");

    const again = await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect((await s.app.inject({ method: "POST", url: "/api/leave-requests/999/cancel" })).statusCode).toBe(404);
  });

  it("복구: 저장된 근무 일정 + 현재 공휴일로 재계산, 경고 포함", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-27T19:00" },
      { leaveTypeId: s.sick, startAt: "2026-10-28T10:00", endAt: "2026-10-28T19:00" },
    ]);
    await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/cancel` });
    // 취소 뒤 직원 근무시간 변경 + 휴무일 추가 + 같은 기간 다른 휴가 신청
    execute(s.db, "UPDATE employees SET work_start = '09:00', work_end = '18:00'");
    insertHoliday(s.db, { date: "2026-10-27", name: "임시공휴일" });
    insertHoliday(s.db, { date: "2026-10-28", name: "센터 휴무", kind: "center" });
    await s.createOk([{ leaveTypeId: s.annual, startAt: "2026-10-26T09:00", endAt: "2026-10-26T12:00" }]);

    const res = await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/restore` });
    expect(res.statusCode).toBe(200);
    const { request: restored, warnings } = res.json<LeaveSaveResult>();
    expect(restored).toMatchObject({ status: "active", cancelledAt: null, workStart: "10:00", workEnd: "19:00" });
    expect(restored.items.map((i) => i.minutes)).toEqual([480, 0]);
    expect(warnings.map((w) => w.code)).toEqual(["overlap_existing", "zero_minutes"]);
    expect(s.audits("restore")).toHaveLength(1);

    const again = await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/restore` });
    expect(again.statusCode).toBe(409);
  });
});

describe("휴가원 미리보기", () => {
  it("정한 날짜 소멸·부여 후 기간: 휴가 시작일 기준으로 잔여를 보고, 사라진 양은 쓸 수 없어 경고", async () => {
    const s = await setup();
    const fiscal = insertLeaveType(s.db, { name: "특별", sortOrder: 3 });
    const comp = insertLeaveType(s.db, { name: "보상", sortOrder: 4 });
    execute(s.db, "UPDATE leave_types SET balance_mode = 'expire_date', expire_month = 9, expire_day = 30 WHERE id = ?", [fiscal]);
    execute(s.db, "UPDATE leave_types SET balance_mode = 'grant_period', valid_months = 3 WHERE id = ?", [comp]);
    // 특별: 2025.10.1~2026.9.30 기간에 받은 2일 → 10월에는 사라짐. 보상: 7/1 부여 → 9/30까지
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: fiscal, grantDate: "2026-09-01", minutes: 960 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: comp, grantDate: "2026-07-01", minutes: 480 });

    const res = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: {
        employeeId: s.emp,
        items: [
          { leaveTypeId: fiscal, startAt: "2026-10-20T10:00", endAt: "2026-10-20T19:00" },
          { leaveTypeId: comp, startAt: "2026-10-21T10:00", endAt: "2026-10-21T19:00" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json<LeavePreview>();
    const before = (id: number) => preview.balancesBefore.find((b) => b.leaveTypeId === id);
    expect(before(fiscal)).toMatchObject({ periodStart: "2026-10-01", periodEnd: "2027-09-30", grantedMinutes: 0 });
    expect(before(comp)).toMatchObject({ asOf: "2026-10-20", grantedMinutes: 0 });
    const messages = preview.warnings.filter((w) => w.code === "over_balance").map((w) => w.message);
    expect(messages).toEqual([
      "특별 잔여가 부족합니다. (2026.10.01.~2027.09.30. 신청 후 잔여 -1일)",
      "보상 잔여가 부족합니다. (2026.10.21. 기준 신청 후 잔여 -1일)",
    ]);

    // 9월이면 둘 다 쓸 수 있음
    const sept = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: {
        employeeId: s.emp,
        items: [
          { leaveTypeId: fiscal, startAt: "2026-09-28T10:00", endAt: "2026-09-28T19:00" },
          { leaveTypeId: comp, startAt: "2026-09-29T10:00", endAt: "2026-09-29T19:00" },
        ],
      },
    });
    expect(sept.json<LeavePreview>().warnings.filter((w) => w.code === "over_balance")).toEqual([]);

    // 잔여 API (오늘 2026-10-19): 보상은 오늘 쓸 수 있는 양 0
    const bal = await s.app.inject({ method: "GET", url: `/api/balances?employeeId=${s.emp}&year=2026` });
    expect(bal.json().find((b: { leaveTypeId: number }) => b.leaveTypeId === comp)).toMatchObject({
      asOf: "2026-10-19",
      grantedMinutes: 0,
      remainingMinutes: 0,
    });
  });

  it("항목 오류는 항목별로, 종류별 합계, 반영 전·후 잔여, 경고", async () => {
    const s = await setup();
    insertLeaveType(s.db, { name: "안 쓰는 종류", active: false });
    const res = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: {
        employeeId: s.emp,
        items: [
          { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
          { leaveTypeId: s.annual, startAt: "2026-10-31T10:00", endAt: "2026-10-31T19:00" },
          { leaveTypeId: s.annual, startAt: "2026-10-27T10:00", endAt: "2026-10-27T15:00" },
          { leaveTypeId: s.sick, startAt: "2026-10-27T12:00", endAt: "2026-10-27T13:00" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json<LeavePreview>();
    expect(p.items.map((i) => [i.minutes, i.error])).toEqual([
      [480, null],
      [0, "시작일이 근무 요일이 아닙니다."],
      [240, null],
      [0, ZERO_MINUTES_MESSAGE],
    ]);
    expect(p.totalsByType).toEqual([{ leaveTypeId: s.annual, minutes: 720 }]);
    expect(p.balancesBefore.map((b) => b.name)).toEqual(["연차", "병가"]);
    expect(p.balancesBefore[0]).toMatchObject({ year: 2026, usedMinutes: 0, remainingMinutes: 7200 });
    expect(p.balancesAfter[0]).toMatchObject({ usedMinutes: 720, remainingMinutes: 6480 });
    expect(p.warnings).toEqual([]);
    // 미리보기는 저장하지 않음
    expect(queryAll(s.db, "SELECT * FROM leave_requests")).toEqual([]);
  });

  it("기존 잔여 입력 기준일자까지의 휴가는 미리보기·경고에서도 잔여에 더하지 않음 (저장 후 잔여와 같게)", async () => {
    const s = await setup();
    execute(
      s.db,
      `INSERT INTO opening_balances (employee_id, leave_type_id, year, base_date, total_granted_minutes, remaining_minutes,
         used_minutes, created_at, updated_at) VALUES (?, ?, 2026, '2026-03-01', 7200, 0, 7200, 'x', 'x')`,
      [s.emp, s.annual],
    );
    const item = { leaveTypeId: s.annual, startAt: "2026-02-02T10:00", endAt: "2026-02-02T19:00" };
    const preview = (
      await s.app.inject({
        method: "POST",
        url: "/api/leave-requests/preview",
        payload: { employeeId: s.emp, items: [item] },
      })
    ).json<LeavePreview>();
    expect(preview.balancesAfter[0]).toMatchObject({ usedMinutes: 7200, remainingMinutes: 0 });
    expect(preview.warnings).toEqual([]);
    expect((await s.createOk([item])).warnings).toEqual([]);
    const balances = (await s.app.inject({ url: `/api/balances?employeeId=${s.emp}&year=2026` })).json();
    expect(balances[0]).toMatchObject({ usedMinutes: 7200, remainingMinutes: 0 });
  });

  it("수정 중이면 그 휴가원을 빼고 계산, 항목이 없으면 올해 기준", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
    ]);
    const preview = async (payload: object) =>
      (await s.app.inject({ method: "POST", url: "/api/leave-requests/preview", payload })).json<LeavePreview>();

    const editing = await preview({
      employeeId: s.emp,
      excludeRequestId: request.id,
      items: [{ leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T15:00" }],
    });
    expect(editing.balancesBefore[0]!.usedMinutes).toBe(0);
    expect(editing.balancesAfter[0]!.usedMinutes).toBe(240);
    expect(editing.warnings).toEqual([]);

    const fresh = await preview({
      employeeId: s.emp,
      items: [{ leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T15:00" }],
    });
    expect(fresh.balancesBefore[0]!.usedMinutes).toBe(480);
    expect(fresh.warnings.map((w) => w.code)).toEqual(["overlap_existing"]);

    const empty = await preview({ employeeId: s.emp, items: [] });
    expect(empty.items).toEqual([]);
    expect(empty.balancesBefore[0]!.year).toBe(2026);

    const nextYear = await preview({
      employeeId: s.emp,
      items: [{ leaveTypeId: s.annual, startAt: "2027-01-04T10:00", endAt: "2027-01-04T19:00" }],
    });
    expect(nextYear.balancesAfter[0]).toMatchObject({ year: 2027, grantedMinutes: 0, remainingMinutes: -480 });
    expect(nextYear.warnings.map((w) => w.code)).toEqual(["over_balance"]);

    const missing = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: { employeeId: 999, items: [] },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("휴가원 출력", () => {
  it("출력 데이터: 휴가현황·체크박스(활성 전체 + 사용한 종류, 차감 안 하는 종류는 총·잔여 null)", async () => {
    const s = await setup();
    const official = insertLeaveType(s.db, { name: "공가", deducts: false, sortOrder: 0 });
    const substitute = insertLeaveType(s.db, { name: "대체휴가", balanceMode: "cumulative", sortOrder: 4 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: substitute, grantDate: "2025-12-01", minutes: 600 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: substitute, grantDate: "2026-03-01", minutes: 900 });
    execute(
      s.db,
      `INSERT INTO opening_balances (employee_id, leave_type_id, year, base_date, total_granted_minutes, remaining_minutes,
         used_minutes, created_at, updated_at) VALUES (?, ?, 2026, '2026-03-01', 7200, 6000, 1200, 'x', 'x')`,
      [s.emp, s.annual],
    );
    await s.createOk([{ leaveTypeId: s.annual, startAt: "2026-09-01T10:00", endAt: "2026-09-01T19:00" }]);
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T15:00" },
      { leaveTypeId: s.sick, startAt: "2026-10-27T10:00", endAt: "2026-10-27T19:00" },
      { leaveTypeId: official, startAt: "2026-10-28T10:00", endAt: "2026-10-28T19:00" },
    ]);
    // 이번에 사용한 병가는 비활성이어도 표시, 사용하지 않은 비활성 종류는 숨김
    execute(s.db, "UPDATE leave_types SET active = 0 WHERE id = ?", [s.sick]);
    insertLeaveType(s.db, { name: "없어진 종류", active: false, sortOrder: 9 });

    s.setToday("2026-10-21");
    const res = await s.app.inject({ url: `/api/leave-requests/${request.id}/print-data` });
    expect(res.statusCode).toBe(200);
    const data = res.json<LeavePrintData>();
    expect(data.submitDate).toBe("2026-10-21");
    expect(data.year).toBe(2026);
    expect(data.approvalRoles).toEqual(["담당", "센터장"]);
    expect(data.request.id).toBe(request.id);
    expect(data.balanceTable).toEqual([
      {
        leaveTypeId: official,
        name: "공가",
        grantedMinutes: null,
        currentMinutes: 480,
        usedMinutes: 480,
        remainingMinutes: null,
      },
      {
        leaveTypeId: s.annual,
        name: "연차",
        // 기준일자(3/1) 이전 부여(1/1 15일)는 기존 잔여 입력의 총 부여량에 이미 포함
        grantedMinutes: 15 * 480,
        currentMinutes: 240,
        usedMinutes: 1200 + 480 + 240,
        remainingMinutes: 15 * 480 - 1920,
      },
      {
        leaveTypeId: s.sick,
        name: "병가",
        grantedMinutes: 0,
        currentMinutes: 480,
        usedMinutes: 480,
        remainingMinutes: -480,
      },
      {
        leaveTypeId: substitute,
        name: "대체휴가",
        grantedMinutes: 1500,
        currentMinutes: 0,
        usedMinutes: 0,
        remainingMinutes: 1500,
      },
    ]);
    expect(data.checkboxes).toEqual([
      { leaveTypeId: official, name: "공가", checked: true },
      { leaveTypeId: s.annual, name: "연차", checked: true },
      { leaveTypeId: s.sick, name: "병가", checked: true },
      { leaveTypeId: substitute, name: "대체휴가", checked: false },
    ]);
    // 미리보기는 기록하지 않음
    expect(queryAll(s.db, "SELECT * FROM print_logs")).toEqual([]);
    expect(s.audits("print")).toEqual([]);
  });

  it("출력 데이터의 결재칸은 출력할 때의 직원 설정", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
    ]);
    execute(s.db, "UPDATE employees SET approval_roles = ? WHERE id = ?", ['["담당","팀장","센터장","대표"]', s.emp]);
    const data = (await s.app.inject({ url: `/api/leave-requests/${request.id}/print-data` })).json<LeavePrintData>();
    expect(data.approvalRoles).toEqual(["담당", "팀장", "센터장", "대표"]);
  });

  it("소진 종류: 잔여가 없으면 숨김(종류마다 끌 수 있음), 이 휴가원에서 쓴 종류는 보임", async () => {
    const s = await setup();
    const hidden = insertLeaveType(s.db, { name: "경조휴가", balanceMode: "used_up", sortOrder: 3 });
    const kept = insertLeaveType(s.db, { name: "포상휴가", balanceMode: "used_up", hideWhenEmpty: false, sortOrder: 4 });
    const usedNow = insertLeaveType(s.db, { name: "출산휴가", balanceMode: "used_up", sortOrder: 5 });
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: usedNow, grantDate: "2026-01-01", minutes: 480 });
    // 출산휴가는 이번에 다 써서 잔여 0
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
      { leaveTypeId: usedNow, startAt: "2026-10-27T10:00", endAt: "2026-10-27T19:00" },
    ]);
    const printData = async () =>
      (await s.app.inject({ url: `/api/leave-requests/${request.id}/print-data` })).json<LeavePrintData>();

    let data = await printData();
    // 병가는 잔여 0이어도 소진이 아니라 보임
    expect(data.checkboxes.map((c) => c.leaveTypeId)).toEqual([s.annual, s.sick, kept, usedNow]);
    expect(data.balanceTable.map((r) => r.leaveTypeId)).toEqual([s.annual, s.sick, kept, usedNow]);
    expect(data.balanceTable.at(-1)).toMatchObject({ currentMinutes: 480, remainingMinutes: 0 });

    // 다시 부여하면 다시 보임
    insertGrant(s.db, { employeeId: s.emp, leaveTypeId: hidden, grantDate: "2026-10-01", minutes: 480 });
    data = await printData();
    expect(data.checkboxes.map((c) => c.leaveTypeId)).toEqual([s.annual, s.sick, hidden, kept, usedNow]);
  });

  it("출력: 출력 기록 + 최근 출력일시 + 변경 이력, 취소된 휴가원은 409", async () => {
    const s = await setup();
    const { request } = await s.createOk([
      { leaveTypeId: s.annual, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" },
    ]);
    const res = await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/print` });
    expect(res.statusCode).toBe(200);
    expect(res.json<LeavePrintData>().request.lastPrintedAt).toBe("2026-10-19 09:00:00");
    expect(queryOne(s.db, "SELECT doc_type, doc_id FROM print_logs")).toEqual({ doc_type: "leave", doc_id: request.id });
    expect(s.audits("print")).toHaveLength(1);

    await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/cancel` });
    expect((await s.app.inject({ method: "POST", url: `/api/leave-requests/${request.id}/print` })).statusCode).toBe(409);
    expect((await s.app.inject({ url: `/api/leave-requests/${request.id}/print-data` })).statusCode).toBe(409);
    expect((await s.app.inject({ url: "/api/leave-requests/999/print-data" })).statusCode).toBe(404);
    expect(queryAll(s.db, "SELECT * FROM print_logs")).toHaveLength(1);
  });
});

describe("적용 대상 직원을 정한 휴가 종류", () => {
  async function restricted() {
    const s = await setup();
    const other = insertEmployee(s.db, { name: "김요원" });
    const special = insertLeaveType(s.db, { name: "특별휴가", sortOrder: 3 });
    execute(s.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [special, other]);
    const item = { leaveTypeId: special, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" };
    const balanceNames = async (employeeId: number) =>
      (await s.app.inject({ url: `/api/balances?employeeId=${employeeId}&year=2026` }))
        .json<{ name: string }[]>()
        .map((b) => b.name);
    return { ...s, other, special, item, balanceNames };
  }

  it("대상이 아닌 직원: 작성·미리보기 막힘, 잔여·양식에 안 나옴", async () => {
    const s = await restricted();
    const res = await s.create([s.item]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("이 직원에게 적용되지 않는 휴가 종류입니다. (특별휴가)");
    const preview = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests/preview",
      payload: { employeeId: s.emp, items: [s.item] },
    });
    expect(preview.json<LeavePreview>().items[0]!.error).toContain("적용되지 않는");
    expect(await s.balanceNames(s.emp)).toEqual(["연차", "병가"]);
    expect(await s.balanceNames(s.other)).toEqual(["연차", "병가", "특별휴가"]);

    const { request } = await s.createOk([{ ...s.item, leaveTypeId: s.annual }]);
    const print = (await s.app.inject({ url: `/api/leave-requests/${request.id}/print-data` })).json<LeavePrintData>();
    expect(print.checkboxes.map((c) => c.name)).toEqual(["연차", "병가"]);
  });

  it("대상 직원은 작성 가능, 대상에서 빠져도 기존 기록은 보이고 그 휴가원 수정 가능", async () => {
    const s = await restricted();
    const res = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests",
      payload: { ...s.body([s.item]), employeeId: s.other },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<LeaveSaveResult>().request.id;
    execute(s.db, "DELETE FROM leave_type_employees");
    execute(s.db, "INSERT INTO leave_type_employees (leave_type_id, employee_id) VALUES (?, ?)", [s.special, s.emp]);
    expect(await s.balanceNames(s.other)).toContain("특별휴가");
    const put = await s.put(id, {
      ...s.body([{ ...s.item, startAt: "2026-10-27T10:00", endAt: "2026-10-27T19:00" }]),
      employeeId: s.other,
    });
    expect(put.statusCode).toBe(200);
  });

  it("부여·기존 잔여 입력도 대상 직원에게만 (일괄 부여는 한 명이라도 아니면 전부 취소)", async () => {
    const s = await restricted();
    const grant = { leaveTypeId: s.special, grantDate: "2026-10-01", days: 1, hours: 0, note: "" };
    const one = await s.app.inject({ method: "POST", url: "/api/grants", payload: { ...grant, employeeId: s.emp } });
    expect(one.statusCode).toBe(400);
    expect(one.json().error).toBe("특별휴가은(는) 홍길동에게 적용되지 않는 휴가 종류입니다.");
    const bulk = await s.app.inject({
      method: "POST",
      url: "/api/grants/bulk",
      payload: { ...grant, employeeIds: [s.other, s.emp] },
    });
    expect(bulk.statusCode).toBe(400);
    expect(queryAll(s.db, "SELECT * FROM leave_grants WHERE leave_type_id = ?", [s.special])).toEqual([]);
    const ok = await s.app.inject({ method: "POST", url: "/api/grants", payload: { ...grant, employeeId: s.other } });
    expect(ok.statusCode).toBe(201);

    const opening = await s.app.inject({
      method: "PUT",
      url: "/api/opening-balances",
      payload: {
        employeeId: s.emp,
        leaveTypeId: s.special,
        year: 2026,
        baseDate: "2026-10-01",
        totalGrantedMinutes: 480,
        remainingMinutes: 480,
      },
    });
    expect(opening.statusCode).toBe(400);
  });
});

describe("적용 대상: 소속·구분 조건", () => {
  it("소속·구분을 함께 고르면 둘 다 맞아야 대상, 새 직원·소속이 바뀐 직원에게도 바로 적용", async () => {
    const s = await setup(); // 홍길동: 아동사업부, 구분 없음
    insertDepartment(s.db, "아동사업부", 1);
    insertDepartment(s.db, "가족사업부", 2);
    const kidAgent = insertEmployee(s.db, { name: "김요원", department: "아동사업부", isSocialServiceAgent: true });
    const familyAgent = insertEmployee(s.db, { name: "박요원", department: "가족사업부", isSocialServiceAgent: true });
    const special = insertLeaveType(s.db, { name: "특별휴가", sortOrder: 3 });
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/leave-types/${special}`,
      payload: {
        name: "특별휴가",
        deducts: true,
        balanceMode: "yearly",
        sortOrder: 3,
        target: { departments: ["아동사업부"], categories: ["사회복무요원"] },
      },
    });
    expect(put.statusCode).toBe(200);
    const has = async (employeeId: number) =>
      (await s.app.inject({ url: `/api/balances?employeeId=${employeeId}&year=2026` }))
        .json<{ name: string }[]>()
        .some((b) => b.name === "특별휴가");
    expect(await has(kidAgent)).toBe(true); // 아동사업부의 요원
    expect(await has(s.emp)).toBe(false); // 아동사업부지만 요원이 아님
    expect(await has(familyAgent)).toBe(false); // 요원이지만 가족사업부
    const item = { leaveTypeId: special, startAt: "2026-10-26T10:00", endAt: "2026-10-26T19:00" };
    const blocked = await s.app.inject({
      method: "POST",
      url: "/api/leave-requests",
      payload: { ...s.body([item]), employeeId: familyAgent },
    });
    expect(blocked.statusCode).toBe(400);

    // 새로 온 아동사업부 요원, 아동사업부로 옮긴 요원
    const newcomer = insertEmployee(s.db, { name: "신입요원", department: "아동사업부", isSocialServiceAgent: true });
    expect(await has(newcomer)).toBe(true);
    execute(s.db, "UPDATE employees SET department = '아동사업부' WHERE id = ?", [familyAgent]);
    expect(await has(familyAgent)).toBe(true);
  });

  it("연차(아동사업부+직원) / 연차-사회복무요원(아동사업부+사회복무요원): 표시 이름이 같아도 겹치지 않음", async () => {
    const s = await setup(); // 기존 "연차"(전체 직원)
    insertDepartment(s.db, "아동사업부", 1);
    insertCategory(s.db, "직원");
    execute(s.db, "UPDATE employees SET category = '직원' WHERE id = ?", [s.emp]);
    insertEmployee(s.db, { name: "김요원", department: "아동사업부", isSocialServiceAgent: true });
    const body = (name: string, category: string) => ({
      name,
      displayName: "연차",
      deducts: true,
      balanceMode: "yearly",
      sortOrder: 5,
      target: { departments: ["아동사업부"], categories: [category] },
    });
    // 기존 연차를 아동사업부의 직원으로 좁힘
    const staff = await s.app.inject({ method: "PUT", url: `/api/leave-types/${s.annual}`, payload: body("연차", "직원") });
    expect(staff.statusCode).toBe(200);
    const agent = await s.app.inject({
      method: "POST",
      url: "/api/leave-types",
      payload: body("연차-사회복무요원", "사회복무요원"),
    });
    expect(agent.statusCode).toBe(201);
  });

  it("소속 이름을 바꾸면 적용 대상도 함께, 적용 대상으로 쓰는 소속은 삭제 불가", async () => {
    const s = await setup();
    const dept = insertDepartment(s.db, "아동사업부", 1);
    const unused = insertDepartment(s.db, "빈소속", 2);
    const special = insertLeaveType(s.db, { name: "특별휴가", sortOrder: 3 });
    const payload = (departments: string[]) => ({
      name: "특별휴가",
      deducts: true,
      balanceMode: "yearly",
      sortOrder: 3,
      target: { departments },
    });
    await s.app.inject({ method: "PUT", url: `/api/leave-types/${special}`, payload: payload(["아동사업부", "빈소속"]) });
    const renamed = await s.app.inject({
      method: "PUT",
      url: `/api/departments/${dept}`,
      payload: { name: "아동청소년부", sortOrder: 1 },
    });
    expect(renamed.statusCode).toBe(200);
    const types = (await s.app.inject({ url: "/api/leave-types" })).json<{ name: string; target: { departments: string[] } }[]>();
    expect(types.find((t) => t.name === "특별휴가")!.target.departments).toEqual(["아동청소년부", "빈소속"]);
    // 직원 소속도 바뀌었으므로 홍길동은 계속 대상
    const balances = (await s.app.inject({ url: `/api/balances?employeeId=${s.emp}&year=2026` })).json<{ name: string }[]>();
    expect(balances.map((b) => b.name)).toContain("특별휴가");

    const del = await s.app.inject({ method: "DELETE", url: `/api/departments/${unused}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toContain("적용 대상으로 쓰는 휴가 종류(특별휴가)");
    await s.app.inject({ method: "PUT", url: `/api/leave-types/${special}`, payload: payload(["아동청소년부"]) });
    expect((await s.app.inject({ method: "DELETE", url: `/api/departments/${unused}` })).statusCode).toBe(204);
  });
});
