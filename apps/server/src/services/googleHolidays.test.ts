import { describe, expect, it } from "vitest";
import { execute, queryAll, queryOne, type Db } from "../db/index.ts";
import { createTestApp, insertEmployee, insertHoliday, insertLeaveType } from "../testing.ts";
import { importGoogleHolidays, parseGoogleHolidayIcs } from "./googleHolidays.ts";

const event = (start: string, end: string, summary: string, description = "공휴일", extra = "") =>
  [
    "BEGIN:VEVENT",
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `DESCRIPTION:${description}`,
    `SUMMARY:${summary}`,
    ...(extra ? [extra] : []),
    "END:VEVENT",
  ].join("\r\n");

const ics = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR", ""].join("\r\n");

describe("parseGoogleHolidayIcs", () => {
  it("설명 첫 줄이 '공휴일'인 것만, 날짜순", () => {
    const text = ics(
      event("20261225", "20261226", "크리스마스"),
      event("20260505", "20260506", "어버이날", "기념일\\n기념일을 숨기려면 Google Calendar 설정으로 이동하세요."),
      event("20261009", "20261010", "한글날"),
      event("20261003", "20261004", "개천절", "공휴일", "STATUS:CANCELLED"),
    );
    expect(parseGoogleHolidayIcs(text)).toEqual([
      { date: "2026-10-09", name: "한글날" },
      { date: "2026-12-25", name: "크리스마스" },
    ]);
  });

  it("이어진 줄·이스케이프·여러 날 일정·같은 날 여러 개", () => {
    const text = ics(
      ["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260924", "DTEND;VALUE=DATE:20260927", "DESCRIPTION:공휴일", "SUMMARY:추석 연", " 휴\\, 3일", "END:VEVENT"].join("\r\n"),
      event("20250505", "20250506", "어린이날"),
      event("20250505", "20250506", "부처님오신날"),
      event("20250505", "20250506", "어린이날"),
      event("20260101", "", "새해첫날"),
    );
    expect(parseGoogleHolidayIcs(text)).toEqual([
      { date: "2025-05-05", name: "어린이날·부처님오신날" },
      { date: "2026-01-01", name: "새해첫날" },
      { date: "2026-09-24", name: "추석 연휴, 3일" },
      { date: "2026-09-25", name: "추석 연휴, 3일" },
      { date: "2026-09-26", name: "추석 연휴, 3일" },
    ]);
  });

  it("날짜가 틀리거나 이름이 없으면 버림", () => {
    const text = ics(event("20261340", "20261341", "이상한 날"), event("20261009", "20261010", " "));
    expect(parseGoogleHolidayIcs(text)).toEqual([]);
    expect(parseGoogleHolidayIcs("<html>오류</html>")).toEqual([]);
  });
});

/** 신청 상태 휴가원 + 항목 1개 (근무 월~금 10:00~19:00) */
function insertLeave(db: Db, employeeId: number, leaveTypeId: number, startAt: string, endAt: string, minutes: number) {
  const rid = execute(
    db,
    `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
       status, created_at, updated_at) VALUES (?, '홍길동', '', '2026-10-01', '[1,2,3,4,5]', '10:00', '19:00', 'active', 'x', 'x')`,
    [employeeId],
  ).lastInsertRowid;
  execute(
    db,
    `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [rid, leaveTypeId, startAt, endAt, minutes, JSON.stringify({ [startAt.slice(0, 4)]: minutes })],
  );
  return rid;
}

describe("importGoogleHolidays", () => {
  it("올해부터, 공휴일 행이 없는 날짜만 자동 등록분으로 추가 + 이력", async () => {
    const { ctx, db } = await createTestApp(); // 오늘 2026-10-19
    insertHoliday(db, { date: "2026-12-25", name: "기독탄신일" }); // 직접 추가 (이름 다름)
    const deleted = insertHoliday(db, { date: "2026-10-09", name: "한글날", source: "auto" });
    execute(db, "UPDATE holidays SET active = 0 WHERE id = ?", [deleted]); // 관리자가 지운 자동 등록분
    insertHoliday(db, { date: "2026-10-28", name: "체육대회", kind: "center" }); // 센터 휴무일은 막지 않음

    const added = importGoogleHolidays(ctx, [
      { date: "2025-12-25", name: "크리스마스" }, // 지난해 → 건너뜀
      { date: "2026-10-09", name: "한글날" },
      { date: "2026-10-28", name: "임시공휴일" },
      { date: "2026-12-25", name: "크리스마스" },
      { date: "2027-01-01", name: "새해첫날" },
    ]);
    expect(added.map((h) => [h.date, h.name, h.kind, h.source, h.active])).toEqual([
      ["2026-10-28", "임시공휴일", "public", "auto", true],
      ["2027-01-01", "새해첫날", "public", "auto", true],
    ]);
    expect(queryOne<{ active: number }>(db, "SELECT active FROM holidays WHERE id = ?", [deleted])!.active).toBe(0);
    expect(queryAll(db, "SELECT * FROM holidays WHERE date = '2026-12-25'")).toHaveLength(1);

    const logs = queryAll(db, "SELECT ip, entity, action, summary FROM audit_logs WHERE entity = 'holiday' ORDER BY id");
    expect(logs.map((l) => l.summary)).toEqual([
      "공휴일 2026.10.28. 임시공휴일 추가 (구글 캘린더)",
      "공휴일 2027.01.01. 새해첫날 추가 (구글 캘린더)",
    ]);
    expect(logs[0]).toMatchObject({ ip: "", action: "create" });

    // 다시 돌려도 더 넣지 않음
    expect(importGoogleHolidays(ctx, [{ date: "2027-01-01", name: "신정" }])).toEqual([]);
  });

  it("추가한 공휴일로 아직 지나지 않은 휴가원을 다시 계산", async () => {
    const { ctx, db } = await createTestApp();
    const emp = insertEmployee(db);
    const type = insertLeaveType(db);
    const rid = insertLeave(db, emp, type, "2026-10-26T10:00", "2026-10-30T19:00", 2400);

    importGoogleHolidays(ctx, [{ date: "2026-10-28", name: "임시공휴일" }]);
    const minutes = Number(
      queryOne<{ minutes: number }>(db, "SELECT minutes FROM leave_request_items WHERE request_id = ?", [rid])!.minutes,
    );
    expect(minutes).toBe(1920);
    const recalc = queryAll(db, "SELECT summary FROM audit_logs WHERE action = 'recalculate'");
    expect(recalc).toHaveLength(1);
    expect(String(recalc[0]!.summary)).toContain("구글 캘린더 공휴일 1건 추가");
  });
});
