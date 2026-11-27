import type { LeaveDayUsage } from "./leave.ts";
import { addDays, localToday, yearOf } from "./time.ts";
import type { BalanceMode, BalanceRow } from "./types.ts";

export interface BalanceTypeInfo {
  id: number;
  name: string;
  /** 표시 이름 (빈 값 = 관리 이름) */
  displayName?: string;
  deducts: boolean;
  balanceMode: BalanceMode;
  sortOrder: number;
  /** 정한 날짜 소멸: 소멸일 (월·일) */
  expireMonth?: number | null;
  expireDay?: number | null;
  /** 부여 후 기간 소멸: 부여일부터 사용할 수 있는 개월 수 */
  validMonths?: number | null;
}

export interface BalanceGrant {
  leaveTypeId: number;
  grantDate: string;
  minutes: number;
}

export interface BalanceOpening {
  leaveTypeId: number;
  year: number;
  /** 기준일자 "YYYY-MM-DD". 이 날짜까지(포함)의 부여·사용은 총 부여량·기존 사용량에 이미 들어 있음 */
  baseDate: string;
  /** 총 부여량(분) */
  totalGrantedMinutes: number;
  usedMinutes: number;
}

export interface BalanceUsage {
  leaveTypeId: number;
  /** {"2026": 480} */
  minutesByYear: Record<string, number>;
  /**
   * 날짜별 사용(분).
   * - 연도별·누적: 기존 잔여량 입력이 있는 연도에서 기준일자 이후 사용만 더할 때 씀. 없으면 그 연도 minutesByYear 전체를 사용으로 봄
   * - 정한 날짜 소멸·부여 후 기간 소멸: 반드시 필요 (연도가 아닌 기간·날짜로 나누므로)
   */
  byDate?: readonly LeaveDayUsage[];
  /** 출력하는 휴가원의 사용 → 그 몫을 BalanceRow.currentMinutes(양식의 금회사용)로 셈 */
  current?: boolean;
}

export interface BalanceOptions {
  /**
   * 기준일 (휴가원 미리보기·출력: 휴가 시작일, 경고: 휴가를 쓰는 날).
   * 정한 날짜 소멸은 이 날짜가 든 기간, 부여 후 기간 소멸은 이 날짜에 쓸 수 있는 양, 연도별·누적은 이 날짜의 연도.
   */
  date?: string;
  /** 오늘 (부여 후 기간 소멸의 올해 잔여 기준). 기본: 컴퓨터 날짜 */
  today?: string;
}

/** 누적처럼 그 해까지 전체 기간으로 계산하는 방식 (누적, 소진) */
export const isCumulativeMode = (mode: BalanceMode): boolean => mode === "cumulative" || mode === "used_up";

// 날짜 문자열이 연·월·일 순이라 문자열 비교 = 날짜 비교
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

/** 날짜 + n개월 (그 달에 없는 날이면 그 달 말일로) */
export function addMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const ty = y + Math.floor(m / 12);
  const tm = (((m % 12) + 12) % 12) + 1;
  const d = Math.min(Number(date.slice(8, 10)), daysInMonth(ty, tm));
  return `${ty}-${pad(tm)}-${pad(d)}`;
}

/** 부여 후 기간 소멸: 부여일에 받은 양을 쓸 수 있는 마지막 날 (예: 2026-03-01 + 12개월 → 2027-02-28) */
export function grantExpiryDate(grantDate: string, validMonths: number): string {
  return addDays(addMonths(grantDate, validMonths), -1);
}

/**
 * 정한 날짜 소멸: 소멸일 다음 날에 새 기간이 시작. 기간 이름(연도) = 시작하는 해.
 * 소멸일이 그 달 말일(2월은 28일 이후)이면 다음 달 1일에 시작. 예) 12/31 → 1/1 시작 (연도별과 같음), 2/28 → 3/1 시작
 */
function expireStartMonthDay(month: number, day: number): [number, number] {
  const last = daysInMonth(2001, month); // 윤년이 아닌 해 기준 (2월 28일 이후 = 2월 말일)
  return day >= last ? [(month % 12) + 1, 1] : [month, day + 1];
}

/** 정한 날짜 소멸: 기간 year 의 시작일·끝일(포함) */
export function expirePeriod(year: number, month: number, day: number): { start: string; end: string } {
  const [sm, sd] = expireStartMonthDay(month, day);
  const start = `${year}-${pad(sm)}-${pad(sd)}`;
  const next = `${year + 1}-${pad(sm)}-${pad(sd)}`;
  return { start, end: addDays(next, -1) };
}

/** 정한 날짜 소멸: 날짜가 속한 기간 이름(연도) */
export function expirePeriodYearOf(date: string, month: number, day: number): number {
  const y = yearOf(date);
  return date >= expirePeriod(y, month, day).start ? y : y - 1;
}

/** 부여 후 기간 소멸: year 를 볼 때의 기준일 (올해 = 오늘, 지난해 = 12/31, 다음 해 = 1/1) */
function grantPeriodAsOf(year: number, today: string): string {
  const thisYear = yearOf(today);
  if (year === thisYear) return today;
  return year < thisYear ? `${year}-12-31` : `${year}-01-01`;
}

interface TypeTotals {
  granted: number;
  used: number;
  /** current 사용의 몫 (used 에 든 만큼. 기존 잔여 기준일자까지의 사용은 used 에 없어도 셈) */
  current: number;
  year: number;
  periodStart: string | null;
  periodEnd: string | null;
  asOf: string | null;
}

/**
 * 한 직원의 휴가 종류별 부여·사용·잔여 계산.
 * - 연도별: 그 해 부여 내역 + 그 해 기존 잔여 입력의 총 부여 / 그 해 사용 + 그 해 기존 사용량
 * - 누적·소진: 그 해까지(포함) 전체 기간 합계
 * - 정한 날짜 소멸: 소멸일 다음 날부터 다음 소멸일까지가 한 기간 (연도별을 기간으로 바꾼 것)
 * - 부여 후 기간 소멸: 부여마다 쓸 수 있는 기간이 있고, 사용은 먼저 소멸하는 부여부터 씀. 기준일에 아직 쓸 수 있는 부여만 셈
 * - 기존 잔여 입력이 있으면 기준일자까지(포함)의 부여·사용이 이미 총 부여량·기존 사용량에 들어 있으므로,
 *   같은 연도(정한 날짜 소멸은 같은 기간)의 부여 내역·휴가원 사용은 기준일자 이후 것만 더함
 * 잔여 = 부여 − 사용 (차감하지 않는 종류는 null)
 * current 사용이 있으면 그 몫을 currentMinutes 로 (휴가원 출력의 금회사용)
 */
export function computeBalances(
  year: number,
  types: readonly BalanceTypeInfo[],
  grants: readonly BalanceGrant[],
  openings: readonly BalanceOpening[],
  usages: readonly BalanceUsage[],
  options: BalanceOptions = {},
): BalanceRow[] {
  const today = options.today ?? localToday();
  const calendarYear = options.date ? yearOf(options.date) : year;
  const hasCurrent = usages.some((u) => u.current);

  return [...types]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((t) => {
      const typeGrants = grants.filter((g) => g.leaveTypeId === t.id);
      const typeOpenings = openings.filter((o) => o.leaveTypeId === t.id);
      const typeUsages = usages.filter((u) => u.leaveTypeId === t.id);
      let totals: TypeTotals;
      if (t.balanceMode === "expire_date" && t.expireMonth && t.expireDay) {
        totals = expireDateTotals(t.expireMonth, t.expireDay, options.date, year, typeGrants, typeOpenings, typeUsages);
      } else if (t.balanceMode === "grant_period" && t.validMonths) {
        const asOf = options.date ?? grantPeriodAsOf(year, today);
        totals = grantPeriodTotals(t.validMonths, asOf, typeGrants, typeOpenings, typeUsages, options.date !== undefined);
      } else {
        totals = calendarTotals(isCumulativeMode(t.balanceMode), calendarYear, typeGrants, typeOpenings, typeUsages);
      }
      return {
        leaveTypeId: t.id,
        name: t.name,
        displayName: t.displayName ?? "",
        deducts: t.deducts,
        balanceMode: t.balanceMode,
        sortOrder: t.sortOrder,
        year: totals.year,
        periodStart: totals.periodStart,
        periodEnd: totals.periodEnd,
        asOf: totals.asOf,
        grantedMinutes: totals.granted,
        usedMinutes: totals.used,
        remainingMinutes: t.deducts ? totals.granted - totals.used : null,
        ...(hasCurrent ? { currentMinutes: totals.current } : {}),
      };
    });
}

/** 연도별·누적 */
function calendarTotals(
  cumulative: boolean,
  year: number,
  grants: readonly BalanceGrant[],
  openings: readonly BalanceOpening[],
  usages: readonly BalanceUsage[],
): TypeTotals {
  const inScope = (y: number) => (cumulative ? y <= year : y === year);
  /** 그 연도의 기존 잔여 입력 기준일자. 없으면 undefined */
  const baseDateOf = (y: number | string) => openings.find((o) => String(o.year) === String(y))?.baseDate;
  let granted = 0;
  let used = 0;
  let current = 0;
  for (const g of grants) {
    const gy = yearOf(g.grantDate);
    if (!inScope(gy)) continue;
    const base = baseDateOf(gy);
    if (base !== undefined && g.grantDate <= base) continue; // 총 부여량에 포함
    granted += g.minutes;
  }
  for (const o of openings) {
    if (!inScope(o.year)) continue;
    granted += o.totalGrantedMinutes;
    used += o.usedMinutes;
  }
  for (const u of usages) {
    for (const [y, m] of Object.entries(u.minutesByYear)) {
      if (!inScope(Number(y))) continue;
      if (u.current) current += m;
      const base = baseDateOf(y);
      if (base === undefined || !u.byDate) {
        used += m;
        continue;
      }
      // 기준일자까지의 사용은 기존 사용량에 포함
      for (const d of u.byDate) {
        if (d.date.startsWith(`${y}-`) && d.date > base) used += d.minutes;
      }
    }
  }
  return {
    granted,
    used,
    current,
    year,
    periodStart: cumulative ? null : `${year}-01-01`,
    periodEnd: `${year}-12-31`,
    asOf: null,
  };
}

/** 정한 날짜 소멸: 기간 하나 (연도별을 기간으로 바꾼 것) */
function expireDateTotals(
  month: number,
  day: number,
  date: string | undefined,
  year: number,
  grants: readonly BalanceGrant[],
  openings: readonly BalanceOpening[],
  usages: readonly BalanceUsage[],
): TypeTotals {
  const label = date ? expirePeriodYearOf(date, month, day) : year;
  const { start, end } = expirePeriod(label, month, day);
  const inPeriod = (d: string) => d >= start && d <= end;
  // 기존 잔여는 연도마다 저장되므로 한 기간에 둘 들 수 있음 → 기준일자가 가장 늦은 것만 (그 시점의 잔여)
  const opening = openings
    .filter((o) => inPeriod(o.baseDate))
    .reduce<BalanceOpening | undefined>((b, o) => (b === undefined || o.baseDate > b.baseDate ? o : b), undefined);
  const base = opening?.baseDate;
  const counts = (d: string) => inPeriod(d) && (base === undefined || d > base);

  let granted = opening?.totalGrantedMinutes ?? 0;
  let used = opening?.usedMinutes ?? 0;
  let current = 0;
  for (const g of grants) if (counts(g.grantDate)) granted += g.minutes;
  for (const u of usages) {
    for (const d of u.byDate ?? []) {
      if (counts(d.date)) used += d.minutes;
      if (u.current && inPeriod(d.date)) current += d.minutes;
    }
  }
  return { granted, used, current, year: label, periodStart: start, periodEnd: end, asOf: null };
}

interface Lot {
  date: string;
  expiry: string;
  amount: number;
  consumed: number;
  /** current 사용이 가져간 양 */
  currentTaken: number;
  /** 기존 잔여 입력이면 그 연도 (그 연도 안이면 기준일자 전 날짜에도 쓸 수 있는 부여로 봄) */
  openingYear?: number;
}

/**
 * 부여 후 기간 소멸.
 * 부여(기존 잔여 입력은 기준일자에 받은 것으로 봄)마다 쓸 수 있는 기간이 있고, 사용은 그날 쓸 수 있는 부여 중
 * 먼저 소멸하는 것부터 씀. 쓸 수 있는 부여가 모자라면 모자란 만큼 빚으로 두고 다음 부여에서 먼저 갚음.
 * 기준일(asOf)에 쓸 수 있는 부여의 양 = 부여, 그 부여에서 쓴 양(기준일 뒤에 신청해 둔 휴가 포함, 그 해 말까지) + 빚 = 사용.
 * 기존 잔여 입력은 그 연도 안이면 기준일자 전 날짜에도 쓸 수 있는 부여로 봄 (연도별처럼 그 연도의 잔여).
 * 빚 = 기준일까지 쌓인 빚(기준일 뒤 부여에서 갚게 되더라도 기준일에는 남아 있음)
 *    + 기준일 뒤에 생긴 빚 중 기준일 뒤 부여가 먼저 생긴 것부터 갚고 남은 것.
 *    휴가 날짜로 볼 때(leaveDate)는 기준일에 쓸 수 있는 부여가 모두 소멸한 뒤 생긴 빚은 넣지 않음 (그날 잔여와 무관, 그 날짜로 볼 때 드러남)
 * current 몫 = 기준일에 쓸 수 있는 부여에서 current 사용이 가져간 양 + 위 빚 중 current 사용이 만든 것
 *    + 기존 잔여 기준일자까지의 current 사용
 */
function grantPeriodTotals(
  validMonths: number,
  asOf: string,
  grants: readonly BalanceGrant[],
  openings: readonly BalanceOpening[],
  usages: readonly BalanceUsage[],
  leaveDate: boolean,
): TypeTotals {
  const horizon = `${yearOf(asOf)}-12-31`;
  /** 같은 연도에 기존 잔여 입력이 있으면 그 기준일자까지의 부여·사용은 이미 들어 있음 */
  const covered = (d: string) => openings.some((o) => o.year === yearOf(d) && d <= o.baseDate);

  const lots: Lot[] = [];
  type Event = { date: string; order: number; lot?: Lot; minutes?: number; current?: boolean };
  const events: Event[] = [];
  for (const o of openings) {
    if (o.baseDate > horizon) continue;
    const lot = { date: o.baseDate, expiry: grantExpiryDate(o.baseDate, validMonths), amount: o.totalGrantedMinutes, consumed: o.usedMinutes, currentTaken: 0, openingYear: o.year };
    events.push({ date: o.baseDate, order: 0, lot });
  }
  for (const g of grants) {
    if (g.grantDate > horizon || covered(g.grantDate)) continue;
    const lot = { date: g.grantDate, expiry: grantExpiryDate(g.grantDate, validMonths), amount: g.minutes, consumed: 0, currentTaken: 0 };
    events.push({ date: g.grantDate, order: 0, lot });
  }
  /** current 사용 중 기존 잔여 기준일자까지의 것: 기존 사용량에 들어 있어 사용에는 다시 넣지 않지만 금회로는 셈 (연도별과 같게) */
  let currentCovered = 0;
  for (const u of usages) {
    for (const d of u.byDate ?? []) {
      if (d.date > horizon || d.minutes <= 0) continue;
      if (covered(d.date)) {
        if (u.current) currentCovered += d.minutes;
        continue;
      }
      events.push({ date: d.date, order: 1, minutes: d.minutes, current: u.current });
    }
  }
  // 같은 날은 부여를 먼저
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  let debt = 0;
  /** 기준일까지(포함) 쌓인 빚 */
  let debtAsOf: number | null = null;
  /** current 사용이 기준일까지 만든 빚 */
  let currentDebtAsOf = 0;
  /** 기준일 뒤에 생긴 빚(생긴 순서)과 기준일 뒤 부여가 갚은 양 */
  const laterDebts: { date: string; minutes: number; current: boolean }[] = [];
  let laterPaid = 0;
  for (const e of events) {
    if (debtAsOf === null && e.date > asOf) debtAsOf = debt;
    if (e.lot) {
      const pay = Math.min(debt, e.lot.amount - e.lot.consumed);
      e.lot.consumed += pay;
      debt -= pay;
      if (e.date > asOf) laterPaid += pay;
      lots.push(e.lot);
      continue;
    }
    let need = e.minutes ?? 0;
    const usable = lots
      .filter((l) => l.date <= e.date && l.expiry >= e.date && l.consumed < l.amount)
      .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
    for (const l of usable) {
      if (need === 0) break;
      const take = Math.min(need, l.amount - l.consumed);
      l.consumed += take;
      if (e.current) l.currentTaken += take;
      need -= take;
    }
    debt += need;
    if (e.date > asOf) laterDebts.push({ date: e.date, minutes: need, current: e.current === true });
    else if (e.current) currentDebtAsOf += need;
  }

  const alive = lots.filter((l) => (l.date <= asOf || l.openingYear === yearOf(asOf)) && l.expiry >= asOf);
  const granted = alive.reduce((s, l) => s + l.amount, 0);
  // 기준일 뒤 빚 중 갚고 남은 것 (휴가 날짜로 볼 때는 기준일에 쓸 수 있는 부여의 마지막 소멸일까지 생긴 것만).
  // 날짜 조건이 없으면 합 = 그 해 말 빚 − 기준일 빚 (0 이상)
  const lastExpiry = alive.reduce<string | null>((m, l) => (m === null || l.expiry > m ? l.expiry : m), null);
  let laterUsed = 0;
  let laterCurrent = 0;
  let paid = laterPaid;
  for (const d of laterDebts) {
    const repaid = Math.min(paid, d.minutes);
    paid -= repaid;
    if (leaveDate && (lastExpiry === null || d.date > lastExpiry)) continue;
    laterUsed += d.minutes - repaid;
    if (d.current) laterCurrent += d.minutes - repaid;
  }
  const used = alive.reduce((s, l) => s + l.consumed, 0) + (debtAsOf ?? debt) + laterUsed;
  const current = alive.reduce((s, l) => s + l.currentTaken, 0) + currentDebtAsOf + currentCovered + laterCurrent;
  return { granted, used, current, year: yearOf(asOf), periodStart: null, periodEnd: null, asOf };
}
