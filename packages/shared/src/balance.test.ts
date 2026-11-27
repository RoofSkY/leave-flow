import { describe, expect, it } from "vitest";
import {
  addMonths,
  computeBalances,
  expirePeriod,
  expirePeriodYearOf,
  grantExpiryDate,
  type BalanceTypeInfo,
} from "./balance.ts";

const annual: BalanceTypeInfo = { id: 1, name: "연차", deducts: true, balanceMode: "yearly", sortOrder: 1 };
const comp: BalanceTypeInfo = { id: 2, name: "대체휴가", deducts: true, balanceMode: "cumulative", sortOrder: 2 };
const official: BalanceTypeInfo = { id: 3, name: "공가", deducts: false, balanceMode: "yearly", sortOrder: 0 };

describe("computeBalances", () => {
  it("연도별: 그 해 부여·사용만 계산", () => {
    const rows = computeBalances(
      2026,
      [annual],
      [
        { leaveTypeId: 1, grantDate: "2026-01-01", minutes: 15 * 480 },
        { leaveTypeId: 1, grantDate: "2025-01-01", minutes: 15 * 480 },
      ],
      [],
      [
        { leaveTypeId: 1, minutesByYear: { "2026": 480 } },
        { leaveTypeId: 1, minutesByYear: { "2025": 960 } },
      ],
    );
    expect(rows[0]).toMatchObject({ grantedMinutes: 7200, usedMinutes: 480, remainingMinutes: 6720 });
  });

  it("누적: 그 해까지 전체 합계, 이후 연도는 제외", () => {
    const rows = computeBalances(
      2026,
      [comp],
      [
        { leaveTypeId: 2, grantDate: "2025-05-01", minutes: 600 },
        { leaveTypeId: 2, grantDate: "2026-03-01", minutes: 150 },
        { leaveTypeId: 2, grantDate: "2027-01-02", minutes: 999 },
      ],
      [],
      [{ leaveTypeId: 2, minutesByYear: { "2025": 120, "2026": 60, "2027": 30 } }],
    );
    expect(rows[0]).toMatchObject({ grantedMinutes: 750, usedMinutes: 180, remainingMinutes: 570 });
  });

  it("소진: 누적과 같이 그 해까지 전체 합계", () => {
    const rows = computeBalances(
      2026,
      [{ ...comp, balanceMode: "used_up" }],
      [
        { leaveTypeId: 2, grantDate: "2025-05-01", minutes: 480 },
        { leaveTypeId: 2, grantDate: "2027-01-02", minutes: 999 },
      ],
      [],
      [{ leaveTypeId: 2, minutesByYear: { "2025": 120, "2026": 360, "2027": 30 } }],
    );
    expect(rows[0]).toMatchObject({
      balanceMode: "used_up",
      periodStart: null,
      grantedMinutes: 480,
      usedMinutes: 480,
      remainingMinutes: 0,
    });
  });

  it("기존 잔여량 입력: 총 부여는 부여로, 기존 사용량은 사용으로 반영", () => {
    const rows = computeBalances(
      2026,
      [annual],
      [],
      [{ leaveTypeId: 1, year: 2026, baseDate: "2026-10-01", totalGrantedMinutes: 7200, usedMinutes: 15 * 480 - 2400 }],
      [{ leaveTypeId: 1, minutesByYear: { "2026": 480 } }],
    );
    expect(rows[0]).toMatchObject({ grantedMinutes: 7200, usedMinutes: 4800 + 480, remainingMinutes: 1920 });
  });

  describe("기존 잔여량 기준일자 (2026-10-19, 그날까지의 부여·사용은 입력값에 포함)", () => {
    const opening = { leaveTypeId: 1, year: 2026, baseDate: "2026-10-19", totalGrantedMinutes: 7200, usedMinutes: 2400 };
    const usage = (byDate: { date: string; minutes: number }[]) => ({
      leaveTypeId: 1,
      minutesByYear: { "2026": byDate.reduce((sum, d) => sum + d.minutes, 0) },
      byDate,
    });

    it("기준일자 이전(당일 포함) 휴가원은 더하지 않음", () => {
      const rows = computeBalances(2026, [annual], [], [opening], [
        usage([{ date: "2026-10-05", minutes: 480 }]),
        usage([{ date: "2026-10-19", minutes: 240 }]),
      ]);
      expect(rows[0]).toMatchObject({ grantedMinutes: 7200, usedMinutes: 2400, remainingMinutes: 4800 });
    });

    it("기준일자 이후 휴가원은 더함", () => {
      const rows = computeBalances(2026, [annual], [], [opening], [usage([{ date: "2026-10-20", minutes: 480 }])]);
      expect(rows[0]).toMatchObject({ usedMinutes: 2880, remainingMinutes: 4320 });
    });

    it("기준일자에 걸친 휴가원은 기준일자 이후 날짜만 더함", () => {
      const rows = computeBalances(2026, [annual], [], [opening], [
        usage([
          { date: "2026-10-16", minutes: 480 },
          { date: "2026-10-19", minutes: 480 },
          { date: "2026-10-20", minutes: 480 },
        ]),
      ]);
      expect(rows[0]).toMatchObject({ usedMinutes: 2400 + 480 });
    });

    it("날짜별 사용이 없으면 그 해 사용 전체를 더함 (모두 기준일자 뒤인 항목)", () => {
      const rows = computeBalances(2026, [annual], [], [opening], [{ leaveTypeId: 1, minutesByYear: { "2026": 480 } }]);
      expect(rows[0]).toMatchObject({ usedMinutes: 2880 });
    });

    it("기준일자까지(당일 포함)의 부여는 총 부여량에 포함되어 더하지 않음", () => {
      const rows = computeBalances(
        2026,
        [annual],
        [
          { leaveTypeId: 1, grantDate: "2026-01-01", minutes: 15 * 480 },
          { leaveTypeId: 1, grantDate: "2026-10-19", minutes: 480 },
          { leaveTypeId: 1, grantDate: "2026-10-20", minutes: 480 },
        ],
        [opening],
        [],
      );
      expect(rows[0]).toMatchObject({ grantedMinutes: 7200 + 480, usedMinutes: 2400, remainingMinutes: 5280 });
    });

    it("기존 잔여 입력이 없는 연도의 사용·부여는 그대로 (누적 종류)", () => {
      const cumulativeOpening = { ...opening, leaveTypeId: 2, totalGrantedMinutes: 600 };
      const rows = computeBalances(
        2026,
        [comp],
        [{ leaveTypeId: 2, grantDate: "2025-05-01", minutes: 600 }],
        [cumulativeOpening],
        [
          {
            leaveTypeId: 2,
            minutesByYear: { "2025": 60, "2026": 120 },
            byDate: [
              { date: "2025-12-31", minutes: 60 },
              { date: "2026-01-02", minutes: 120 },
            ],
          },
        ],
      );
      // 2025: 부여 600·사용 60 그대로, 2026: 총 부여 10h·기존 사용 2400, 01-02 사용은 기준일자 전이라 제외
      expect(rows[0]).toMatchObject({ grantedMinutes: 600 + 600, usedMinutes: 60 + 2400 });
    });
  });

  it("차감하지 않는 종류는 잔여 null, 표시 순서대로 정렬", () => {
    const rows = computeBalances(2026, [annual, official], [], [], [
      { leaveTypeId: 3, minutesByYear: { "2026": 480 } },
    ]);
    expect(rows.map((r) => r.leaveTypeId)).toEqual([3, 1]);
    expect(rows[0]).toMatchObject({ usedMinutes: 480, remainingMinutes: null });
  });
});

describe("정한 날짜에 소멸", () => {
  const fiscal: BalanceTypeInfo = {
    id: 4,
    name: "특별휴가",
    deducts: true,
    balanceMode: "expire_date",
    sortOrder: 1,
    expireMonth: 2,
    expireDay: 28,
  };
  const day = (date: string, minutes: number) => ({ leaveTypeId: 4, minutesByYear: {}, byDate: [{ date, minutes }] });

  it("기간: 소멸일 다음 날 시작, 기간 이름 = 시작하는 해 (2월 말일은 윤년에도 말일까지)", () => {
    expect(expirePeriod(2026, 2, 28)).toEqual({ start: "2026-03-01", end: "2027-02-28" });
    expect(expirePeriod(2027, 2, 28)).toEqual({ start: "2027-03-01", end: "2028-02-29" });
    expect(expirePeriod(2026, 12, 31)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(expirePeriod(2026, 6, 30)).toEqual({ start: "2026-07-01", end: "2027-06-30" });
    expect(expirePeriod(2026, 6, 15)).toEqual({ start: "2026-06-16", end: "2027-06-15" });
    expect(expirePeriodYearOf("2027-02-10", 2, 28)).toBe(2026);
    expect(expirePeriodYearOf("2027-03-01", 2, 28)).toBe(2027);
  });

  it("그 기간의 부여·사용만, 소멸일이 지나면 남은 양은 다음 기간으로 넘어가지 않음", () => {
    const grants = [
      { leaveTypeId: 4, grantDate: "2026-03-01", minutes: 10 * 480 },
      { leaveTypeId: 4, grantDate: "2027-03-01", minutes: 10 * 480 },
    ];
    const usages = [day("2027-02-10", 480), day("2027-03-05", 960)];
    const p2026 = computeBalances(2026, [fiscal], grants, [], usages)[0]!;
    expect(p2026).toMatchObject({
      year: 2026,
      periodStart: "2026-03-01",
      periodEnd: "2027-02-28",
      grantedMinutes: 4800,
      usedMinutes: 480,
      remainingMinutes: 4320,
    });
    const p2027 = computeBalances(2027, [fiscal], grants, [], usages)[0]!;
    expect(p2027).toMatchObject({ grantedMinutes: 4800, usedMinutes: 960, remainingMinutes: 3840 });
    // 기준일을 주면 그날이 든 기간 (2027-02-10 → 2026 기간)
    expect(computeBalances(2027, [fiscal], grants, [], usages, { date: "2027-02-10" })[0]).toMatchObject({ year: 2026 });
  });

  it("기존 잔여량: 기준일자가 든 기간에 넣고, 그 기간의 기준일자까지 부여·사용은 다시 더하지 않음", () => {
    const rows = computeBalances(
      2026,
      [fiscal],
      [
        { leaveTypeId: 4, grantDate: "2026-03-01", minutes: 4800 },
        { leaveTypeId: 4, grantDate: "2026-12-01", minutes: 480 },
      ],
      [{ leaveTypeId: 4, year: 2026, baseDate: "2026-10-01", totalGrantedMinutes: 4800, usedMinutes: 960 }],
      [day("2026-09-01", 480), day("2026-10-02", 240)],
    );
    expect(rows[0]).toMatchObject({ grantedMinutes: 4800 + 480, usedMinutes: 960 + 240 });
  });

  it("기존 잔여량이 한 기간에 둘이면 기준일자가 늦은 것만 씀 (그 시점의 잔여)", () => {
    // 소멸일 2/28 → 2025 기간 = 2025-03-01~2026-02-28. 연도 키가 다른 두 기록이 같은 기간에 듦
    const openings = [
      { leaveTypeId: 4, year: 2025, baseDate: "2025-12-31", totalGrantedMinutes: 4800, usedMinutes: 960 },
      { leaveTypeId: 4, year: 2026, baseDate: "2026-01-15", totalGrantedMinutes: 4800, usedMinutes: 1440 },
    ];
    const rows = computeBalances(2025, [fiscal], [], openings, [day("2026-01-10", 480), day("2026-01-20", 480)], {
      date: "2026-01-20",
    });
    expect(rows[0]).toMatchObject({ year: 2025, grantedMinutes: 4800, usedMinutes: 1440 + 480 });
  });

  it("출력하는 휴가원 몫(current 사용): 그 기간 날짜 몫 (기존 잔여 기준일자 이전도 연도별처럼 셈)", () => {
    const mine = (dates: string[]) => ({
      leaveTypeId: 4,
      minutesByYear: {},
      byDate: dates.map((date) => ({ date, minutes: 480 })),
      current: true,
    });
    const opening = { leaveTypeId: 4, year: 2026, baseDate: "2026-05-31", totalGrantedMinutes: 7200, usedMinutes: 1920 };
    // 기간 경계(2/28)를 걸치면 이 기간 몫만
    const cross = computeBalances(2026, [fiscal], [], [], [mine(["2027-02-26", "2027-03-02"])], { date: "2027-02-26" });
    expect(cross[0]).toMatchObject({ usedMinutes: 480, currentMinutes: 480 });
    // 기준일자(5/31) 이전 휴가는 기존 사용량에 들어 있어 누적에 다시 더하지 않지만 금회로는 보임
    const before = computeBalances(2026, [fiscal], [], [opening], [mine(["2026-04-10"])], { date: "2026-04-10" });
    expect(before[0]).toMatchObject({ usedMinutes: 1920, currentMinutes: 480 });
  });
});

describe("부여 후 기간이 지나면 소멸", () => {
  const comp6: BalanceTypeInfo = {
    id: 5,
    name: "대체휴가",
    deducts: true,
    balanceMode: "grant_period",
    sortOrder: 1,
    validMonths: 6,
  };
  const grant = (grantDate: string, minutes: number) => ({ leaveTypeId: 5, grantDate, minutes });
  const use = (date: string, minutes: number) => ({ leaveTypeId: 5, minutesByYear: {}, byDate: [{ date, minutes }] });

  it("쓸 수 있는 마지막 날 = 부여일 + 기간 − 1일 (그 달에 없는 날은 말일)", () => {
    expect(grantExpiryDate("2026-03-01", 12)).toBe("2027-02-28");
    expect(grantExpiryDate("2026-01-15", 6)).toBe("2026-07-14");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });

  it("기준일에 쓸 수 있는 부여만 셈, 기간이 지난 부여의 남은 양은 사라짐", () => {
    const grants = [grant("2026-01-10", 300), grant("2026-05-01", 120)];
    // 01-10 부여는 07-09까지. 6월에 60분 사용
    const usages = [use("2026-06-01", 60)];
    const june = computeBalances(2026, [comp6], grants, [], usages, { date: "2026-06-15" })[0]!;
    expect(june).toMatchObject({ asOf: "2026-06-15", grantedMinutes: 420, usedMinutes: 60, remainingMinutes: 360 });
    // 7/10이면 01-10 부여(남은 240분)가 사라지고 05-01 부여 120분만 남음
    const july = computeBalances(2026, [comp6], grants, [], usages, { date: "2026-07-10" })[0]!;
    expect(july).toMatchObject({ grantedMinutes: 120, usedMinutes: 0, remainingMinutes: 120 });
  });

  it("사용은 먼저 사라질 부여부터, 모자라면 다음 부여에서 먼저 갚음", () => {
    const grants = [grant("2026-01-10", 120), grant("2026-03-01", 300)];
    const usages = [use("2026-03-10", 180)]; // 01-10 부여 120 + 03-01 부여 60
    const r = computeBalances(2026, [comp6], grants, [], usages, { date: "2026-07-10" })[0]!;
    expect(r).toMatchObject({ grantedMinutes: 300, usedMinutes: 60, remainingMinutes: 240 });

    // 부여 전에 쓴 60분은 빚 → 다음 부여에서 갚음
    const debt = computeBalances(2026, [comp6], [grant("2026-04-01", 300)], [], [use("2026-03-20", 60)], {
      date: "2026-04-02",
    })[0]!;
    expect(debt).toMatchObject({ grantedMinutes: 300, usedMinutes: 60, remainingMinutes: 240 });
    // 갚을 부여가 없으면 음수
    const short = computeBalances(2026, [comp6], [], [], [use("2026-03-20", 60)], { date: "2026-03-21" })[0]!;
    expect(short.remainingMinutes).toBe(-60);
  });

  it("기준일까지 생긴 빚은 그 뒤(같은 해) 부여에서 갚더라도 기준일 잔여에는 남음", () => {
    // 04-01 부여는 03-21에 쓸 수 없음 → 03-20에 쓴 60분은 03-21 기준 부족
    const before = computeBalances(2026, [comp6], [grant("2026-04-01", 300)], [], [use("2026-03-20", 60)], {
      date: "2026-03-21",
    })[0]!;
    expect(before).toMatchObject({ grantedMinutes: 0, usedMinutes: 60, remainingMinutes: -60 });
    // 모자란 만큼만: 09-01 300분으로 11-10의 480분 중 180분이 모자람
    const partial = computeBalances(
      2026,
      [comp6],
      [grant("2026-09-01", 300), grant("2026-12-01", 480)],
      [],
      [use("2026-11-10", 480)],
      { date: "2026-11-10" },
    )[0]!;
    expect(partial).toMatchObject({ grantedMinutes: 300, usedMinutes: 480, remainingMinutes: -180 });
    // 기준일 뒤 빚(11-20)을 기준일 뒤 부여(12-01)가 갚으면 그 둘은 상쇄 → 기준일 빚만 남음 (이중으로 세지 않음)
    const both = computeBalances(
      2026,
      [comp6],
      [grant("2026-12-01", 480)],
      [],
      [use("2026-11-10", 480), use("2026-11-20", 480)],
      { date: "2026-11-10" },
    )[0]!;
    expect(both).toMatchObject({ grantedMinutes: 0, usedMinutes: 480, remainingMinutes: -480 });
    // 기준일 뒤에만 생긴 빚을 기준일 뒤 부여가 갚으면 기준일 잔여는 그대로
    const later = computeBalances(
      2026,
      [comp6],
      [grant("2026-09-01", 480), grant("2026-12-20", 480)],
      [],
      [use("2026-12-10", 960)],
      { date: "2026-11-10" },
    )[0]!;
    expect(later).toMatchObject({ grantedMinutes: 480, usedMinutes: 480, remainingMinutes: 0 });
    // 기준일 뒤에 신청해 둔 휴가로 생긴 빚이 그 해 말까지 남으면 미리 뺌
    const ahead = computeBalances(2026, [comp6], [grant("2026-09-01", 480)], [], [use("2026-12-10", 960)], {
      date: "2026-11-10",
    })[0]!;
    expect(ahead).toMatchObject({ grantedMinutes: 480, usedMinutes: 960, remainingMinutes: -480 });
  });

  it("휴가 날짜로 볼 때는 그날 쓸 수 있는 부여가 모두 소멸한 뒤 생기는 부족은 넣지 않음 (잔여 현황은 미리 뺌)", () => {
    // 06-01 부여는 11-30까지. 12-21 사용은 쓸 부여가 없어 부족이지만 11-10에 쓸 수 있는 양과는 무관
    const grants = [grant("2026-06-01", 480)];
    const usages = [use("2026-12-21", 480)];
    const nov10 = computeBalances(2026, [comp6], grants, [], usages, { date: "2026-11-10" })[0]!;
    expect(nov10).toMatchObject({ grantedMinutes: 480, usedMinutes: 0, remainingMinutes: 480 });
    // 그 날짜로 보면 부족
    expect(computeBalances(2026, [comp6], grants, [], usages, { date: "2026-12-21" })[0]).toMatchObject({
      remainingMinutes: -480,
    });
    // 잔여 현황(오늘 기준)은 그 해 말까지 생길 부족을 미리 뺌
    expect(computeBalances(2026, [comp6], grants, [], usages, { today: "2026-11-10" })[0]).toMatchObject({
      usedMinutes: 480,
      remainingMinutes: 0,
    });
  });

  it("기존 잔여량은 그 연도 안이면 기준일자 전 날짜에도 쓸 수 있는 부여로 봄 (연도별과 같게)", () => {
    const opening = { leaveTypeId: 5, year: 2026, baseDate: "2026-10-19", totalGrantedMinutes: 7200, usedMinutes: 2400 };
    // 03-01 부여는 기준일자 전이라 이미 총 부여량에 들어 있음
    const before = computeBalances(2026, [comp6], [grant("2026-03-01", 7200)], [opening], [], { date: "2026-09-01" })[0]!;
    expect(before).toMatchObject({ grantedMinutes: 7200, usedMinutes: 2400, remainingMinutes: 4800 });
  });

  it("출력하는 휴가원 몫(current 사용): 그날 쓸 수 있는 부여에서 쓴 양 + 그 휴가원이 만든 부족분", () => {
    const mine = (date: string, minutes: number) => ({ ...use(date, minutes), current: true });
    // 날짜가 이른 휴가원(11-02)을 나중에 내도 10-01 부여에서 쓴 1일이 금회. 뒤 날짜 휴가원 하나는 11-05 부여로 밀림
    const shifted = computeBalances(
      2026,
      [comp6],
      [grant("2026-10-01", 960), grant("2026-11-05", 1440)],
      [],
      [use("2026-11-09", 480), use("2026-11-16", 480), mine("2026-11-02", 480)],
      { date: "2026-11-02" },
    )[0]!;
    expect(shifted).toMatchObject({ grantedMinutes: 960, usedMinutes: 960, currentMinutes: 480 });
    // 부족분: 11-01 부여는 11-10이 씀. 기준일 뒤 부여(12-01)는 기준일 뒤 부족을 먼저 생긴 것(다른 휴가원 11-15)부터 갚음
    // → 11-20 부족은 이 휴가원 몫
    const debt = computeBalances(
      2026,
      [comp6],
      [grant("2026-11-01", 480), grant("2026-12-01", 480)],
      [],
      [use("2026-11-15", 480), mine("2026-11-10", 480), mine("2026-11-20", 480)],
      { date: "2026-11-10" },
    )[0]!;
    expect(debt).toMatchObject({ grantedMinutes: 480, usedMinutes: 960, currentMinutes: 960 });
    // 기존 잔여 기준일자(10-19)까지의 휴가는 기존 사용량에 들어 있어 누적에 다시 더하지 않지만 금회로는 보임 (연도별과 같게)
    const opening = { leaveTypeId: 5, year: 2026, baseDate: "2026-10-19", totalGrantedMinutes: 7200, usedMinutes: 2400 };
    const onBase = computeBalances(2026, [comp6], [], [opening], [mine("2026-10-19", 480)], { date: "2026-10-19" })[0]!;
    expect(onBase).toMatchObject({ grantedMinutes: 7200, usedMinutes: 2400, currentMinutes: 480 });
    // current 사용이 없으면 currentMinutes 없음
    expect(computeBalances(2026, [comp6], [], [], [use("2026-11-10", 60)], { date: "2026-11-10" })[0]).not.toHaveProperty(
      "currentMinutes",
    );
  });

  it("연도만 주면 올해는 오늘, 지난해는 12/31 기준. 기준일 뒤에 신청해 둔 그 해 휴가도 사용에 넣음", () => {
    const grants = [grant("2026-09-01", 300)];
    const usages = [use("2026-11-02", 120), use("2027-01-05", 60)];
    const now = computeBalances(2026, [comp6], grants, [], usages, { today: "2026-10-20" })[0]!;
    expect(now).toMatchObject({ asOf: "2026-10-20", grantedMinutes: 300, usedMinutes: 120, remainingMinutes: 180 });
    const last = computeBalances(2025, [comp6], grants, [], usages, { today: "2026-10-20" })[0]!;
    expect(last).toMatchObject({ asOf: "2025-12-31", grantedMinutes: 0, remainingMinutes: 0 });
  });

  it("기존 잔여량은 기준일자에 받은 부여로 봄", () => {
    const r = computeBalances(
      2026,
      [comp6],
      [grant("2026-02-01", 600)], // 기준일자 전 → 이미 총 부여량에 포함
      [{ leaveTypeId: 5, year: 2026, baseDate: "2026-03-01", totalGrantedMinutes: 600, usedMinutes: 120 }],
      [use("2026-02-15", 60), use("2026-04-01", 60)],
      { date: "2026-08-31" },
    )[0]!;
    expect(r).toMatchObject({ grantedMinutes: 600, usedMinutes: 180, remainingMinutes: 420 });
    // 03-01 + 6개월 → 08-31 까지
    expect(computeBalances(2026, [comp6], [], [{ leaveTypeId: 5, year: 2026, baseDate: "2026-03-01", totalGrantedMinutes: 600, usedMinutes: 120 }], [], { date: "2026-09-01" })[0]).toMatchObject({ grantedMinutes: 0, remainingMinutes: 0 });
  });
});
