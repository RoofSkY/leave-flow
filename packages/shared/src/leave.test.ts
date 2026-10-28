import { describe, expect, it } from "vitest";
import {
  calculateLeaveUsage,
  dailyWorkMinutes,
  formatLeaveMinutes,
  dayMinutesOf,
  daysHoursToMinutes,
  formatHoursMinutes,
  leaveTypeAppliesTo,
  needsReprint,
  quickRangeTimes,
  selectableLeaveTimes,
  validateLeaveRange,
  type WorkSchedule,
} from "./leave.ts";

const MON_FRI = [1, 2, 3, 4, 5];
const tenToSeven: WorkSchedule = { workDays: MON_FRI, workStart: "10:00", workEnd: "19:00" };
const nineToSix: WorkSchedule = { workDays: MON_FRI, workStart: "09:00", workEnd: "18:00" };
const none = new Set<string>();

// 2026-10-01(목), 10-02(금), 10-03(토), 10-04(일), 10-05(월)

describe("calculateLeaveUsage", () => {
  it("10:00~19:00 하루 = 점심 제외 8시간", () => {
    const u = calculateLeaveUsage("2026-10-01T10:00", "2026-10-01T19:00", tenToSeven, none);
    expect(u.minutes).toBe(480);
  });

  it("점심시간에 걸친 부분은 제외", () => {
    const u = calculateLeaveUsage("2026-10-01T11:00", "2026-10-01T14:00", tenToSeven, none);
    expect(u.minutes).toBe(120);
  });

  it("점심시간 안에서만 쉰 경우 0분", () => {
    const u = calculateLeaveUsage("2026-10-01T12:00", "2026-10-01T13:00", tenToSeven, none);
    expect(u.minutes).toBe(0);
    expect(u.byDate).toEqual([]);
  });

  it("여러 날: 첫날은 시작~퇴근, 중간은 하루, 마지막 날은 출근~종료", () => {
    const u = calculateLeaveUsage("2026-10-01T14:00", "2026-10-05T12:00", tenToSeven, none);
    expect(u.byDate).toEqual([
      { date: "2026-10-01", minutes: 300 },
      { date: "2026-10-02", minutes: 480 },
      { date: "2026-10-05", minutes: 120 },
    ]);
    expect(u.minutes).toBe(900);
  });

  it("근무시간 밖의 시각은 잘라냄", () => {
    const u = calculateLeaveUsage("2026-10-01T07:00", "2026-10-01T23:00", nineToSix, none);
    expect(u.minutes).toBe(480);
  });

  it("공휴일·휴무일은 제외", () => {
    const closed = new Set(["2026-10-02"]);
    const u = calculateLeaveUsage("2026-10-01T09:00", "2026-10-05T18:00", nineToSix, closed);
    expect(u.byDate.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-05"]);
    expect(u.minutes).toBe(960);
  });

  it("근무 요일이 아닌 날은 제외 (월·화·수 근무)", () => {
    const partTime: WorkSchedule = { workDays: [1, 2, 3], workStart: "09:00", workEnd: "18:00" };
    const u = calculateLeaveUsage("2026-10-05T09:00", "2026-10-09T18:00", partTime, none);
    expect(u.byDate.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("오후 근무자는 점심 영향 없음", () => {
    const afternoon: WorkSchedule = { workDays: MON_FRI, workStart: "13:00", workEnd: "18:00" };
    const u = calculateLeaveUsage("2026-10-01T13:00", "2026-10-01T18:00", afternoon, none);
    expect(u.minutes).toBe(300);
  });

  it("연도를 넘는 휴가는 연도별로 나눔", () => {
    const u = calculateLeaveUsage(
      "2026-12-31T09:00",
      "2027-01-04T18:00",
      nineToSix,
      new Set(["2027-01-01"]),
    );
    expect(u.byYear).toEqual({ "2026": 480, "2027": 480 });
  });

  it("종료가 시작보다 앞서면 오류", () => {
    expect(() =>
      calculateLeaveUsage("2026-10-01T15:00", "2026-10-01T10:00", tenToSeven, none),
    ).toThrow();
  });

  it("잘못된 날짜는 오류", () => {
    expect(() =>
      calculateLeaveUsage("2026-02-30T09:00", "2026-03-02T10:00", nineToSix, none),
    ).toThrow();
  });
});

describe("반차 (근무시간의 절반)", () => {
  it("10:00~19:00 → 오전 10:00~15:00, 오후 15:00~19:00", () => {
    expect(quickRangeTimes(tenToSeven, "am")).toEqual({ start: "10:00", end: "15:00" });
    expect(quickRangeTimes(tenToSeven, "pm")).toEqual({ start: "15:00", end: "19:00" });
    expect(quickRangeTimes(tenToSeven, "full")).toEqual({ start: "10:00", end: "19:00" });
  });

  it("09:00~18:00 → 오전 09:00~14:00", () => {
    expect(quickRangeTimes(nineToSix, "am")).toEqual({ start: "09:00", end: "14:00" });
  });

  it("13:00~18:00(5h) → 오전 13:00~15:30, 오후 15:30~18:00", () => {
    const s: WorkSchedule = { workDays: MON_FRI, workStart: "13:00", workEnd: "18:00" };
    expect(quickRangeTimes(s, "am")).toEqual({ start: "13:00", end: "15:30" });
    expect(quickRangeTimes(s, "pm")).toEqual({ start: "15:30", end: "18:00" });
  });

  it("08:00~13:00(점심 걸침, 4h) → 오전 08:00~10:00", () => {
    const s: WorkSchedule = { workDays: MON_FRI, workStart: "08:00", workEnd: "13:00" };
    expect(dailyWorkMinutes(s)).toBe(240);
    expect(quickRangeTimes(s, "am")).toEqual({ start: "08:00", end: "10:00" });
  });

  it("오전·오후 사용 시간이 정확히 절반", () => {
    for (const s of [tenToSeven, nineToSix]) {
      const am = quickRangeTimes(s, "am");
      const pm = quickRangeTimes(s, "pm");
      const a = calculateLeaveUsage(`2026-10-01T${am.start}`, `2026-10-01T${am.end}`, s, none);
      const p = calculateLeaveUsage(`2026-10-01T${pm.start}`, `2026-10-01T${pm.end}`, s, none);
      expect(a.minutes).toBe(240);
      expect(p.minutes).toBe(240);
    }
  });

  it("반차 경계가 10분 단위가 아니어도 허용 (09:00~17:10, 7h10m)", () => {
    const s: WorkSchedule = { workDays: MON_FRI, workStart: "09:00", workEnd: "17:10" };
    expect(quickRangeTimes(s, "am").end).toBe("13:35");
    expect(selectableLeaveTimes(s)).toContain("13:35");
  });
});

describe("validateLeaveRange", () => {
  it("정상 범위는 null", () => {
    expect(validateLeaveRange("2026-10-01T10:00", "2026-10-02T19:00", tenToSeven)).toBeNull();
  });
  it("근무 요일이 아닌 날 시작은 오류", () => {
    expect(validateLeaveRange("2026-10-03T10:00", "2026-10-05T19:00", tenToSeven)).toMatch(/근무 요일/);
  });
  it("근무시간 밖 시각은 오류", () => {
    expect(validateLeaveRange("2026-10-01T09:00", "2026-10-01T19:00", tenToSeven)).toMatch(/근무시간 밖/);
  });
  it("10분 단위가 아니면 오류", () => {
    expect(validateLeaveRange("2026-10-01T10:05", "2026-10-01T19:00", tenToSeven)).toMatch(/10분/);
  });
  it("종료가 시작보다 앞서면 오류", () => {
    expect(validateLeaveRange("2026-10-01T15:00", "2026-10-01T15:00", tenToSeven)).toMatch(/뒤여야/);
  });
  it("기간은 366일까지", () => {
    // 2026-10-01(목) ~ 2027-10-01(금) = 365일, 2026-10-01 ~ 2027-10-04(월) = 368일
    expect(validateLeaveRange("2026-10-01T10:00", "2027-10-01T19:00", tenToSeven)).toBeNull();
    expect(validateLeaveRange("2026-10-01T10:00", "2027-10-04T19:00", tenToSeven)).toMatch(/1년\(366일\) 이내/);
    expect(validateLeaveRange("2000-01-03T10:00", "2100-12-31T19:00", tenToSeven)).toMatch(/366일/);
  });
  it("2000~2100년 밖의 날짜는 오류", () => {
    expect(validateLeaveRange("0026-10-19T10:00", "0026-10-19T19:00", tenToSeven)).toMatch(/2000~2100년/);
    expect(validateLeaveRange("0202-10-19T10:00", "2026-10-20T19:00", tenToSeven)).toMatch(/2000~2100년/);
    expect(validateLeaveRange("2100-12-31T10:00", "2101-01-03T19:00", tenToSeven)).toMatch(/2000~2100년/);
  });
});

describe("표시·변환", () => {
  it("0인 부분은 빼고 표시, 전부 0이면 0일", () => {
    expect(formatLeaveMinutes(480 + 150, 480)).toBe("1일 2시간 30분");
    expect(formatLeaveMinutes(0, 480)).toBe("0일");
    expect(formatLeaveMinutes(-240, 480)).toBe("-4시간");
    expect(formatLeaveMinutes(13 * 480, 480)).toBe("13일");
  });

  it("하루 근무시간을 넘는 시간도 일로 묶어 표시", () => {
    expect(formatLeaveMinutes(1500, 480)).toBe("3일 1시간");
    expect(formatLeaveMinutes(150, 480)).toBe("2시간 30분");
    expect(formatLeaveMinutes(12 * 480 + 10, 480)).toBe("12일 10분");
    expect(formatLeaveMinutes(-10, 480)).toBe("-10분");
  });

  it("1일 = 그 직원의 하루 근무시간 (점심 제외)", () => {
    const part = { workStart: "10:00", workEnd: "16:00" }; // 점심 1시간 빼고 5시간
    expect(dayMinutesOf(part)).toBe(300);
    expect(dayMinutesOf({ workStart: "09:00", workEnd: "18:00" })).toBe(480);
    expect(dayMinutesOf({ workStart: "13:00", workEnd: "17:30" })).toBe(270);
    expect(dayMinutesOf(null)).toBe(480);
    expect(formatLeaveMinutes(15 * 300 + 120, 300)).toBe("15일 2시간");
    expect(formatLeaveMinutes(330, 270)).toBe("1일 1시간");
    expect(formatLeaveMinutes(-300, 300)).toBe("-1일");
  });

  it("일·시간 → 분, 시간만 표시", () => {
    expect(daysHoursToMinutes(15, 0, 480)).toBe(15 * 480);
    expect(daysHoursToMinutes(15, 2, 300)).toBe(15 * 300 + 120);
    expect(daysHoursToMinutes(0, 2.5, 300)).toBe(150);
    expect(formatHoursMinutes(150)).toBe("2시간 30분");
    expect(formatHoursMinutes(600)).toBe("10시간");
    expect(formatHoursMinutes(0)).toBe("0시간");
  });
});

describe("leaveTypeAppliesTo (적용 대상)", () => {
  const kid = { id: 1, department: "아동사업부", category: "직원" };
  const kidAgent = { id: 2, department: "아동사업부", category: "사회복무요원" };
  const family = { id: 3, department: "가족사업부", category: "직원" };
  const noDept = { id: 4, department: "", category: "" };
  const target = (over: Partial<{ departments: string[]; categories: string[]; employeeIds: number[] }>) => ({
    target: { departments: [], categories: [], employeeIds: [], ...over },
  });

  it.each([
    { desc: "대상 없음(null) = 전체", type: { target: null }, applies: [true, true, true, true] },
    { desc: "소속만", type: target({ departments: ["아동사업부"] }), applies: [true, true, false, false] },
    { desc: "구분만", type: target({ categories: ["직원"] }), applies: [true, false, true, false] },
    {
      desc: "소속 + 구분 = 둘 다 맞아야",
      type: target({ departments: ["아동사업부"], categories: ["직원"] }),
      applies: [true, false, false, false],
    },
    {
      desc: "같은 칸 안 여러 개 = 하나만 맞으면",
      type: target({ departments: ["아동사업부", "가족사업부"], categories: ["직원"] }),
      applies: [true, false, true, false],
    },
    {
      desc: "따로 고른 직원은 조건과 관계없이 더함",
      type: target({ departments: ["아동사업부"], categories: ["직원"], employeeIds: [4] }),
      applies: [true, false, false, true],
    },
    { desc: "직원만 고름", type: target({ employeeIds: [3] }), applies: [false, false, true, false] },
  ])("$desc", ({ type, applies }) => {
    expect([kid, kidAgent, family, noDept].map((e) => leaveTypeAppliesTo(type, e))).toEqual(applies);
  });
});

describe("needsReprint (출력 후 수정됨)", () => {
  const printed = { status: "active" as const, lastPrintedAt: "2026-10-01 10:00:00" };
  it.each([
    { desc: "출력 뒤 수정", r: { ...printed, updatedAt: "2026-10-01 10:00:01" }, expected: true },
    { desc: "수정 뒤 출력", r: { ...printed, updatedAt: "2026-10-01 09:59:59" }, expected: false },
    { desc: "같은 때", r: { ...printed, updatedAt: "2026-10-01 10:00:00" }, expected: false },
    { desc: "출력 안 함", r: { ...printed, lastPrintedAt: null, updatedAt: "2026-10-02 09:00:00" }, expected: false },
    { desc: "취소됨", r: { ...printed, status: "cancelled" as const, updatedAt: "2026-10-02 09:00:00" }, expected: false },
  ])("$desc", ({ r, expected }) => {
    expect(needsReprint(r)).toBe(expected);
  });
});
