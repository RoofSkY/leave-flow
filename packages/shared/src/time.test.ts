import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { addDays, dateToDayNumber, formatPeriod, startOfWeekMonday, weekdayOf, isDateString } from "./time.ts";
import {
  dateString,
  dateTimeString,
  employeeInput,
  grantInput,
  holidayInput,
  leavePreviewInput,
  leaveRequestInput,
  leaveTypeInput,
  openingBalanceInput,
  overtimeGeneralInput,
  overtimeSoldierInput,
  soldierWorkDetails,
} from "./schemas.ts";

describe("time", () => {
  it("요일", () => {
    expect(weekdayOf("2026-10-19")).toBe(1);
    expect(startOfWeekMonday("2026-10-25")).toBe("2026-10-19");
    expect(startOfWeekMonday("2026-10-19")).toBe("2026-10-19");
  });

  it("날짜 검사", () => {
    expect(isDateString("2026-02-29")).toBe(false);
    expect(isDateString("2028-02-29")).toBe(true);
  });

  it("0~99년을 1900년대로 바꾸지 않음", () => {
    expect(weekdayOf("0026-10-19")).not.toBe(weekdayOf("1926-10-19"));
    expect(dateToDayNumber("0026-10-19")).toBeLessThan(dateToDayNumber("1000-01-01"));
    expect(addDays("0026-12-31", 1)).toBe("0027-01-01");
    expect(isDateString("0000-02-29")).toBe(true); // 0년은 윤년 (그레고리력 연장)
    expect(isDateString("0100-02-29")).toBe(false);
  });

  it("출력용 기간", () => {
    expect(formatPeriod("2026-10-01T10:00", "2026-10-01T19:00")).toBe("2026.10.01. 10:00 ~ 19:00");
    expect(formatPeriod("2026-10-01T10:00", "2026-10-03T19:00")).toBe(
      "2026.10.01. 10:00 ~ 2026.10.03. 19:00",
    );
  });
});

describe("schemas", () => {
  it("일반 시간외근무: 10분 단위 금일발생", () => {
    const base = {
      kind: "general" as const,
      targets: [
        { employeeId: 1, leaveTypeId: 3 },
        { employeeId: 2, leaveTypeId: 3 },
      ],
      workStartAt: "2026-10-03T10:00",
      workEndAt: "2026-10-03T19:00",
      cumulativeNote: "",
      category: "special_work" as const,
      workDetails: "",
    };
    expect(overtimeGeneralInput.safeParse({ ...base, minutes: 150 }).success).toBe(true);
    expect(overtimeGeneralInput.safeParse({ ...base, minutes: 155 }).success).toBe(false);
    const dup = [
      { employeeId: 1, leaveTypeId: 3 },
      { employeeId: 1, leaveTypeId: 4 },
    ];
    expect(overtimeGeneralInput.safeParse({ ...base, minutes: 150, targets: dup }).success).toBe(false);
  });

  it("2000~2100년 밖의 날짜·일시는 거부", () => {
    const message = (r: { success: boolean; error?: z.ZodError }) => r.error?.issues[0]?.message;
    expect(message(dateString.safeParse("0026-10-19"))).toBe("2000~2100년 사이의 날짜를 입력하세요.");
    expect(message(dateString.safeParse("2101-01-01"))).toBe("2000~2100년 사이의 날짜를 입력하세요.");
    expect(message(dateTimeString.safeParse("0026-10-19T10:00"))).toBe("2000~2100년 사이의 날짜를 입력하세요.");
    expect(message(dateTimeString.safeParse("9999-12-31T19:00"))).toBe("2000~2100년 사이의 날짜를 입력하세요.");
    expect(dateString.safeParse("2000-01-01").success).toBe(true);
    expect(dateTimeString.safeParse("2100-12-31T19:00").success).toBe(true);
  });

  describe("직원 근무시간: 점심을 빼고 근무시간이 있어야 함", () => {
    const base = {
      name: "홍길동",
      department: "",
      color: "#4f7cff",
      workDays: [1, 2, 3, 4, 5],
      emergencyContact: "",
      approvalRoles: ["담당"],
      category: "",
    };
    const parse = (workStart: string, workEnd: string) => employeeInput.safeParse({ ...base, workStart, workEnd });

    it("점심시간 안의 근무시간은 거부", () => {
      for (const [s, e] of [
        ["12:00", "13:00"],
        ["12:10", "12:50"],
      ] as const) {
        const r = parse(s, e);
        expect(r.success).toBe(false);
        expect(r.error?.issues).toEqual([
          expect.objectContaining({ path: ["workEnd"], message: "점심시간(12:00~13:00)을 빼면 근무시간이 없습니다." }),
        ]);
      }
    });

    it("정상 근무시간은 통과", () => {
      expect(parse("10:00", "19:00").success).toBe(true);
      expect(parse("13:00", "18:00").success).toBe(true);
      expect(parse("08:00", "12:00").success).toBe(true);
    });

    it("종료 ≤ 시작이면 메시지 하나만", () => {
      const r = parse("13:00", "12:00");
      expect(r.error?.issues.map((i) => i.message)).toEqual(["근무 종료시각은 시작시각보다 뒤여야 합니다."]);
    });

    it("시각 형식이 틀려도 예외 없이 형식 오류", () => {
      const r = parse("aa", "19:00");
      expect(r.error?.issues.map((i) => i.message)).toEqual(["시각 형식이 올바르지 않습니다. (HH:MM)"]);
    });
  });

  it("범위·형식 오류 메시지는 모두 한국어", () => {
    const hangul = /[가-힣]/;
    const ids = { employeeId: 1, leaveTypeId: 1 };
    const item = { leaveTypeId: 1, startAt: "2026-10-19T10:00", endAt: "2026-10-19T19:00" };
    const general = {
      kind: "general",
      targets: [{ employeeId: 1, leaveTypeId: 1 }],
      workStartAt: "2026-10-03T10:00",
      workEndAt: "2026-10-03T19:00",
      minutes: 60,
      cumulativeNote: "",
      category: "special_work",
      workDetails: "",
    };
    const soldier = {
      kind: "soldier",
      targets: [{ employeeId: 1, leaveTypeId: 1, days: 1, month: 10 }],
      paidOn: "2026-10-19",
      category: "official_event",
      workDetails: "",
    };
    const leaveType = { name: "연차", deducts: true, balanceMode: "yearly", sortOrder: 0 };
    const opening = { ...ids, year: 2026, baseDate: "2026-10-19", totalGrantedMinutes: 7200, remainingMinutes: 4800 };
    const employee = {
      name: "홍길동",
      department: "",
      color: "#4f7cff",
      workDays: [1],
      workStart: "10:00",
      workEnd: "19:00",
      emergencyContact: "",
      approvalRoles: ["담당"],
      category: "",
    };
    // 기본값은 통과해야 아래 실패가 바꾼 값 하나 때문임을 보장
    const bases: [string, z.ZodType, unknown][] = [
      ["휴가 종류", leaveTypeInput, leaveType],
      ["기존 잔여", openingBalanceInput, opening],
      ["직원", employeeInput, employee],
      ["일반 시간외근무", overtimeGeneralInput, general],
      ["요원 특별휴가", overtimeSoldierInput, soldier],
    ];
    for (const [label, schema, value] of bases) expect(schema.safeParse(value).success, label).toBe(true);
    const cases: [string, z.ZodType, unknown][] = [
      ["표시 순서 -1", leaveTypeInput, { ...leaveType, sortOrder: -1 }],
      ["표시 순서 12345", leaveTypeInput, { ...leaveType, sortOrder: 12345 }],
      ["표시 순서 1.5", leaveTypeInput, { ...leaveType, sortOrder: 1.5 }],
      ["표시 순서 문자", leaveTypeInput, { ...leaveType, sortOrder: "1" }],
      ["잔여 방식", leaveTypeInput, { ...leaveType, balanceMode: "monthly" }],
      ["소진 + 차감 안 함", leaveTypeInput, { ...leaveType, deducts: false, balanceMode: "used_up" }],
      ["차감 여부", leaveTypeInput, { ...leaveType, deducts: "yes" }],
      ["부여량 10000일", grantInput, { ...ids, grantDate: "2026-10-19", days: 10000, hours: 0, note: "" }],
      ["연도 1999", openingBalanceInput, { ...opening, year: 1999 }],
      ["연도 2026.5", openingBalanceInput, { ...opening, year: 2026.5 }],
      ["총 부여량 -1", openingBalanceInput, { ...opening, totalGrantedMinutes: -1 }],
      ["총 부여량 10000일", openingBalanceInput, { ...opening, totalGrantedMinutes: 10000 * 24 * 60 }],
      ["잔여량 1.5", openingBalanceInput, { ...opening, remainingMinutes: 1.5 }],
      ["근무 요일 7", employeeInput, { ...employee, workDays: [7] }],
      ["근무 요일 1.5", employeeInput, { ...employee, workDays: [1.5] }],
      ["구분 31자", employeeInput, { ...employee, category: "가".repeat(31) }],
      ["결재칸 없음", employeeInput, { ...employee, approvalRoles: [] }],
      ["결재칸 부장", employeeInput, { ...employee, approvalRoles: ["부장"] }],
      ["휴가 항목 21개", leaveRequestInput, { employeeId: 1, items: Array(21).fill(item), reason: "개인 사유", emergencyContact: "010-1234-5678", handoverNote: "" }],
      ["미리보기 항목 21개", leavePreviewInput, { employeeId: 1, items: Array(21).fill(item) }],
      ["금일발생 1.5", overtimeGeneralInput, { ...general, minutes: 1.5 }],
      ["일반 대상 51명", overtimeGeneralInput, { ...general, targets: Array.from({ length: 51 }, (_, i) => ({ employeeId: i + 1, leaveTypeId: 1 })) }],
      ["일반 상세내용", overtimeGeneralInput, { ...general, category: "x" }],
      ["요원 대상 51명", overtimeSoldierInput, { ...soldier, targets: Array.from({ length: 51 }, (_, i) => ({ employeeId: i + 1, leaveTypeId: 1, days: 1, month: 10 })) }],
      ["발생 일수 0", overtimeSoldierInput, { ...soldier, targets: [{ employeeId: 1, leaveTypeId: 1, days: 0, month: 10 }] }],
      ["발생 일수 32", overtimeSoldierInput, { ...soldier, targets: [{ employeeId: 1, leaveTypeId: 1, days: 32, month: 10 }] }],
      ["발생 월 13", overtimeSoldierInput, { ...soldier, targets: [{ employeeId: 1, leaveTypeId: 1, days: 1, month: 13 }] }],
      ["발생 월 1.5", overtimeSoldierInput, { ...soldier, targets: [{ employeeId: 1, leaveTypeId: 1, days: 1, month: 1.5 }] }],
      ["요원 상세내용", overtimeSoldierInput, { ...soldier, category: "special_work" }],
      ["공휴일 구분", holidayInput, { date: "2026-10-19", name: "휴무", kind: "x" }],
    ];
    for (const [label, schema, value] of cases) {
      const r = schema.safeParse(value);
      expect(r.success, label).toBe(false);
      for (const issue of r.error!.issues) expect(issue.message, label).toMatch(hangul);
    }
  });

  it("요원 근무내역 기본 문구", () => {
    const text = soldierWorkDetails([{ name: "홍길동", month: 10, days: 1 }]);
    expect(text.split("\n").at(-1)).toBe("- 홍길동 10월 총 1개 발생");
  });
});
