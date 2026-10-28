import { describe, expect, it } from "vitest";
import { execute, queryAll, queryOne, type Db } from "../db/index.ts";
import { createTestApp, insertEmployee, insertHoliday, insertLeaveType } from "../testing.ts";
import { insertAutoHolidays, koreanPublicHolidays, startHolidaySync } from "./holidays.ts";

const AT = "2026-10-19 09:00:00";

const EXPECTED_2026 = [
  "01-01", "02-16", "02-17", "02-18", "03-01", "03-02", "05-05", "05-24", "05-25", "06-06",
  "07-17", "08-15", "08-17", "09-24", "09-25", "09-26", "10-03", "10-05", "10-09", "12-25",
].map((d) => `2026-${d}`);

const EXPECTED_2027 = [
  "01-01", "02-06", "02-07", "02-08", "02-09", "03-01", "05-05", "05-13", "06-06", "07-17", "07-19",
  "08-15", "08-16", "09-14", "09-15", "09-16", "10-03", "10-04", "10-09", "10-11", "12-25", "12-27",
].map((d) => `2027-${d}`);

function activeAutoDates(db: Db, year: number): string[] {
  return queryAll<{ date: string }>(
    db,
    `SELECT DISTINCT date FROM holidays
      WHERE active = 1 AND kind = 'public' AND source = 'auto' AND substr(date, 1, 4) = ? ORDER BY date`,
    [String(year)],
  ).map((r) => r.date);
}

describe("법정공휴일 자동 등록 (date-holidays KR)", () => {
  it("2026년 법정공휴일 날짜가 정확함 (설날 하루 밀림 보정)", async () => {
    const { db } = await createTestApp();
    insertAutoHolidays(db, [2026], AT);
    expect(activeAutoDates(db, 2026)).toEqual(EXPECTED_2026);
  });

  it("2027년 법정공휴일 날짜가 정확함 (설날 대체공휴일 포함)", async () => {
    const { db } = await createTestApp();
    insertAutoHolidays(db, [2027], AT);
    expect(activeAutoDates(db, 2027)).toEqual(EXPECTED_2027);
  });

  it("설날은 전날·당일·다음날, 추석은 라이브러리 값 그대로", () => {
    const seollal = koreanPublicHolidays(2026).filter((h) => h.name === "설날").map((h) => h.date);
    expect(seollal).toEqual(["2026-02-16", "2026-02-17", "2026-02-18"]);
    const chuseok = koreanPublicHolidays(2026).filter((h) => h.name === "추석").map((h) => h.date);
    expect(chuseok).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
    const sub = koreanPublicHolidays(2027).filter((h) => h.name.startsWith("설날") && h.name !== "설날");
    expect(sub.map((h) => h.date)).toEqual(["2027-02-09"]);
  });

  it("법정공휴일(public)만 등록 (기념일 등 제외)", () => {
    const names = new Set(koreanPublicHolidays(2025).map((h) => h.name));
    // 제헌절은 2025년까지 기념일(observance)
    expect(names.has("제헌절")).toBe(false);
    expect(new Set(koreanPublicHolidays(2026).map((h) => h.name)).has("제헌절")).toBe(true);
  });

  it("kind=public, source=auto 로 저장하고 다시 실행하면 추가 없음", async () => {
    const { db } = await createTestApp();
    const added = insertAutoHolidays(db, [2026, 2027], AT);
    expect(added).toHaveLength(queryAll(db, "SELECT * FROM holidays").length);
    expect(queryAll(db, "SELECT * FROM holidays WHERE kind <> 'public' OR source <> 'auto' OR active <> 1")).toEqual(
      [],
    );
    expect(queryOne(db, "SELECT created_at FROM holidays LIMIT 1")).toMatchObject({ created_at: AT });
    expect(insertAutoHolidays(db, [2026, 2027], AT)).toEqual([]);
  });

  it("관리자가 지운 자동 등록분은 되살리지 않고, 같은 이름의 수동 등록분은 건드리지 않음", async () => {
    const { db } = await createTestApp();
    const manual = insertHoliday(db, { date: "2026-12-25", name: "기독탄신일", kind: "public", source: "manual" });
    insertAutoHolidays(db, [2026], AT);
    execute(db, "UPDATE holidays SET active = 0 WHERE date = '2026-10-09'");

    expect(insertAutoHolidays(db, [2026], AT)).toEqual([]);
    expect(queryOne(db, "SELECT active FROM holidays WHERE date = '2026-10-09'")).toMatchObject({ active: 0 });
    expect(queryAll(db, "SELECT id, source FROM holidays WHERE date = '2026-12-25'")).toEqual([
      { id: manual, source: "manual" },
    ]);
  });
});

describe("startHolidaySync", () => {
  it("올해 기준 앞 1년 ~ 뒤 2년을 등록하고, 지나지 않은 휴가원을 재계산하며 이력은 추가됐을 때만 기록", async () => {
    const { db, ctx } = await createTestApp();
    const emp = insertEmployee(db);
    const type = insertLeaveType(db);
    // 2026-12-24(목) ~ 12-25(금): 공휴일 등록 전 2일 = 960분
    const rid = execute(
      db,
      `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
         status, created_at, updated_at) VALUES (?, '홍길동', '', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', 'active', 'x', 'x')`,
      [emp],
    ).lastInsertRowid;
    execute(
      db,
      `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year)
       VALUES (?, ?, '2026-12-24T10:00', '2026-12-25T19:00', 960, '{"2026":960}')`,
      [rid, type],
    );

    const stop = startHolidaySync(ctx);
    stop();

    const years = queryAll<{ y: string }>(db, "SELECT DISTINCT substr(date, 1, 4) AS y FROM holidays ORDER BY y").map(
      (r) => r.y,
    );
    expect(years).toEqual(["2025", "2026", "2027", "2028"]);
    expect(queryOne(db, "SELECT minutes FROM leave_request_items WHERE request_id = ?", [rid])).toMatchObject({
      minutes: 480,
    });

    const created = queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'holiday' AND action = 'create'");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ ip: "system", at: ctx.now() });
    expect(String(created[0]!.summary)).toMatch(/^법정공휴일 자동 등록 \d+건 \(2025~2028년\)$/);
    const after = JSON.parse(String(created[0]!.after_json)) as { years: number[]; holidays: string[] };
    expect(after.years).toEqual([2025, 2026, 2027, 2028]);
    expect(after.holidays).toContain("2026-02-16 설날");
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE action = 'recalculate'")).toHaveLength(1);

    // 다시 실행: 추가 없음 → 이력도 없음
    startHolidaySync(ctx)();
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'holiday'")).toHaveLength(1);
  });
});
