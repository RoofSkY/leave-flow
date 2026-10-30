// 휴가원 저장·미리보기·출력에 쓰는 공통 로직 (routes/leaveRequests.ts, routes/calendar.ts)
import {
  DEFAULT_APPROVAL_ROLES,
  dayMinutesOf,
  distinctLeaveTypeLabels,
  expirePeriodYearOf,
  formatDotDate,
  formatLeaveMinutes,
  formatPeriod,
  isCumulativeMode,
  leaveTypeAppliesTo,
  validateLeaveRange,
  yearOf,
  type ApprovalRole,
  type BalanceRow,
  type BalanceUsage,
  type LeavePreview,
  type LeavePrintData,
  type LeaveRequest,
  type LeaveRequestItemInput,
  type LeaveDayUsage,
  type LeaveType,
  type LeaveUsage,
  type Warning,
  type WorkSchedule,
} from "@leave-flow/shared";
import { execute, parseJson, queryAll, queryOne, type Db } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { getEmployeeBalances } from "./balances.ts";
import { byDateJson, computeItemUsage } from "./leaveUsage.ts";
import { employeeTargetInfo, getEmployee, listLeaveTypes, typeLabelSql } from "./queries.ts";

export const ZERO_MINUTES_MESSAGE = "선택한 기간에 휴가로 계산되는 근무시간이 없습니다.";

export function scheduleOf(s: { workDays: readonly number[]; workStart: string; workEnd: string }): WorkSchedule {
  return { workDays: [...s.workDays], workStart: s.workStart, workEnd: s.workEnd };
}

interface EvaluatedItem {
  input: LeaveRequestItemInput;
  type: LeaveType | null;
  usage: LeaveUsage | null;
  error: string | null;
}

/**
 * 휴가 항목 검사 + 사용 시간 계산 (현재 공휴일·휴무일 반영).
 * @param allowInactive 수정 중인 휴가원에 이미 있던 종류 (비활성이거나 이 직원이 적용 대상에서 빠졌어도 허용)
 */
export function evaluateItems(
  db: Db,
  employeeId: number,
  items: readonly LeaveRequestItemInput[],
  schedule: WorkSchedule,
  allowInactive: ReadonlySet<number> = new Set(),
): EvaluatedItem[] {
  const types = new Map(listLeaveTypes(db, { includeInactive: true }).map((t) => [t.id, t]));
  const employee = employeeTargetInfo(db, employeeId);
  return items.map((input) => {
    const type = types.get(input.leaveTypeId) ?? null;
    const fail = (error: string): EvaluatedItem => ({ input, type, usage: null, error });
    if (!type) return fail("휴가 종류를 찾을 수 없습니다.");
    if (!type.active && !allowInactive.has(type.id)) return fail(`사용하지 않는 휴가 종류입니다. (${type.name})`);
    if (!leaveTypeAppliesTo(type, employee) && !allowInactive.has(type.id)) {
      return fail(`이 직원에게 적용되지 않는 휴가 종류입니다. (${type.name})`);
    }
    const rangeError = validateLeaveRange(input.startAt, input.endAt, schedule);
    if (rangeError) return fail(rangeError);
    const usage = computeItemUsage(db, input.startAt, input.endAt, schedule);
    if (usage.minutes === 0) return fail(ZERO_MINUTES_MESSAGE);
    return { input, type, usage, error: null };
  });
}

/** 저장용: 오류가 있는 항목이 있으면 400 (항목이 여러 개면 몇 번째인지 함께) */
export function assertItemsValid(evaluated: readonly EvaluatedItem[]): void {
  const idx = evaluated.findIndex((e) => e.error);
  if (idx < 0) return;
  const message = evaluated[idx]!.error!;
  throw badRequest(
    evaluated.length > 1 ? `${idx + 1}번째 항목: ${message}` : message,
    evaluated.map((e) => e.error),
  );
}

/** 경고 계산에 쓰는 항목 */
interface WarningItem {
  /** 화면에 보여줄 항목 번호 (1부터) */
  no: number;
  leaveTypeId: number;
  startAt: string;
  endAt: string;
  minutesByYear: Record<string, number>;
  /** 날짜별 사용 (기존 잔여 입력 기준일자 이전 사용 빼기, 정한 날짜·부여 후 기간 소멸 경고) */
  byDate: readonly LeaveDayUsage[];
}

/** 아직 저장 안 한 신청을 잔여 계산에 더할 사용량으로 */
function extraUsageOf(items: readonly WarningItem[]): BalanceUsage[] {
  return items.map((i) => ({ leaveTypeId: i.leaveTypeId, minutesByYear: i.minutesByYear, byDate: i.byDate }));
}

/**
 * 잔여 초과를 확인할 연도 (오름차순).
 * - 이번 항목이 사용하는 연도
 * - 누적 종류(소진 포함): 이번에 그 종류를 처음 쓰는 연도보다 뒤에 그 종류 기록(다른 신청 상태 휴가원 사용·부여·기존 잔여)이 있는 연도.
 *   누적 잔여는 뒤 연도에도 이번 사용분이 들어가므로, 이미 신청해 둔 다음 해 휴가 때문에 그 해 잔여가 음수가 될 수 있음
 */
function overBalanceYears(
  db: Db,
  employeeId: number,
  items: readonly WarningItem[],
  excludeRequestId: number | null,
): number[] {
  const years = new Set<number>();
  for (const i of items) {
    for (const [y, m] of Object.entries(i.minutesByYear)) if (m > 0) years.add(Number(y));
  }

  const cumulative = new Set(
    listLeaveTypes(db, { includeInactive: true })
      .filter((t) => isCumulativeMode(t.balanceMode))
      .map((t) => t.id),
  );
  /** 누적 종류별 이번 항목의 가장 이른 사용 연도 */
  const firstYear = new Map<number, number>();
  for (const i of items) {
    if (!cumulative.has(i.leaveTypeId)) continue;
    for (const [y, m] of Object.entries(i.minutesByYear)) {
      const year = Number(y);
      if (m > 0 && year < (firstYear.get(i.leaveTypeId) ?? Infinity)) firstYear.set(i.leaveTypeId, year);
    }
  }

  if (firstYear.size > 0) {
    const records = queryAll<{ leave_type_id: number; minutes_by_year: string | null; year: number | null }>(
      db,
      `SELECT i.leave_type_id, i.minutes_by_year, NULL AS year
         FROM leave_request_items i JOIN leave_requests r ON r.id = i.request_id
        WHERE r.employee_id = ? AND r.status = 'active' AND r.id <> ?
       UNION ALL
       SELECT leave_type_id, NULL, CAST(substr(grant_date, 1, 4) AS INTEGER) FROM leave_grants WHERE employee_id = ?
       UNION ALL
       SELECT leave_type_id, NULL, year FROM opening_balances WHERE employee_id = ?`,
      [employeeId, excludeRequestId ?? -1, employeeId, employeeId],
    );
    for (const r of records) {
      const from = firstYear.get(Number(r.leave_type_id));
      if (from === undefined) continue;
      const recordYears =
        r.year !== null
          ? [Number(r.year)]
          : Object.entries(parseJson<Record<string, number>>(r.minutes_by_year, {}))
              .filter(([, m]) => m > 0)
              .map(([y]) => Number(y));
      for (const y of recordYears) if (y > from) years.add(y);
    }
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * 저장은 허용하는 경고: 잔여 초과, 기존 휴가와 겹침, 항목끼리 겹침.
 * items는 아직 사용량에 반영되지 않은 신청 (excludeRequestId 휴가원은 DB 사용량·겹침 검사에서 제외).
 */
export function collectWarnings(
  db: Db,
  employeeId: number,
  items: readonly WarningItem[],
  excludeRequestId: number | null,
): Warning[] {
  const warnings: Warning[] = [];
  if (items.length === 0) return warnings;

  // 잔여 초과: 이번 사용이 들어가는 (종류, 연도)마다 신청 후 잔여가 음수인지
  const years = overBalanceYears(db, employeeId, items, excludeRequestId);
  const extraUsage = extraUsageOf(items);
  const dayMinutes = dayMinutesOf(getEmployee(db, employeeId));
  const warned = new Set<string>();
  for (const y of years) {
    const rows = getEmployeeBalances(db, employeeId, y, {
      excludeRequestId,
      extraUsage,
      includeInactiveTypes: true,
    });
    const label = distinctLeaveTypeLabels(rows);
    for (const row of rows) {
      if (row.remainingMinutes === null || row.remainingMinutes >= 0) continue;
      if (row.balanceMode !== "yearly" && !isCumulativeMode(row.balanceMode)) continue; // 아래에서 따로
      // 연도별 종류는 그 해 사용분, 누적 종류는 그 해까지(포함)의 사용분이 있을 때만
      const affected = items.some(
        (i) =>
          i.leaveTypeId === row.leaveTypeId &&
          Object.entries(i.minutesByYear).some(
            ([iy, m]) => m > 0 && (isCumulativeMode(row.balanceMode) ? Number(iy) <= y : Number(iy) === y),
          ),
      );
      const key = `${row.leaveTypeId}:${y}`;
      if (!affected || warned.has(key)) continue;
      warned.add(key);
      warnings.push({
        code: "over_balance",
        message: `${label(row)} 잔여가 부족합니다. (${y}년 신청 후 잔여 ${formatLeaveMinutes(row.remainingMinutes, dayMinutes)})`,
      });
    }
  }

  // 정한 날짜 소멸·부여 후 기간 소멸: 이번 항목이 쓰는 날마다 (기간이 바뀌는 첫날 기준) 신청 후 잔여 확인
  const dated = listLeaveTypes(db, { includeInactive: true }).filter(
    (t) => t.balanceMode === "expire_date" || t.balanceMode === "grant_period",
  );
  for (const t of dated) {
    const days = [...new Set(items.filter((i) => i.leaveTypeId === t.id).flatMap((i) => i.byDate.map((d) => d.date)))].sort();
    const checked = new Set<string>();
    for (const date of days) {
      // 정한 날짜 소멸은 기간마다 한 번, 부여 후 기간 소멸은 쓰는 날마다
      const key = t.balanceMode === "expire_date" ? String(expirePeriodYearOf(date, t.expireMonth ?? 12, t.expireDay ?? 31)) : date;
      if (checked.has(key)) continue;
      checked.add(key);
      const dayRows = getEmployeeBalances(db, employeeId, yearOf(date), {
        excludeRequestId,
        extraUsage,
        includeInactiveTypes: true,
        date,
      });
      const row = dayRows.find((r) => r.leaveTypeId === t.id);
      if (!row || row.remainingMinutes === null || row.remainingMinutes >= 0) continue;
      const when =
        t.balanceMode === "expire_date" && row.periodStart && row.periodEnd
          ? `${formatDotDate(row.periodStart)}~${formatDotDate(row.periodEnd)}`
          : `${formatDotDate(date)} 기준`;
      warnings.push({
        code: "over_balance",
        message: `${distinctLeaveTypeLabels(dayRows)(row)} 잔여가 부족합니다. (${when} 신청 후 잔여 ${formatLeaveMinutes(row.remainingMinutes, dayMinutes)})`,
      });
      break; // 종류마다 한 번만 알림
    }
  }

  // 같은 직원의 다른 신청 상태 휴가원과 시간 겹침
  const minStart = items.reduce((m, i) => (i.startAt < m ? i.startAt : m), items[0]!.startAt);
  const maxEnd = items.reduce((m, i) => (i.endAt > m ? i.endAt : m), items[0]!.endAt);
  const others = queryAll<{ start_at: string; end_at: string; type_name: string }>(
    db,
    `SELECT i.start_at, i.end_at, ${typeLabelSql("t")} AS type_name
       FROM leave_request_items i
       JOIN leave_requests r ON r.id = i.request_id
       JOIN leave_types t ON t.id = i.leave_type_id
      WHERE r.employee_id = ? AND r.status = 'active' AND r.id <> ? AND i.start_at < ? AND i.end_at > ?
      ORDER BY i.start_at, i.id`,
    [employeeId, excludeRequestId ?? -1, maxEnd, minStart],
  );
  for (const o of others) {
    if (items.some((i) => i.startAt < o.end_at && o.start_at < i.endAt)) {
      warnings.push({
        code: "overlap_existing",
        message: `같은 기간에 이미 신청한 휴가가 있습니다. (${o.type_name} ${formatPeriod(o.start_at, o.end_at)})`,
      });
    }
  }

  // 같은 휴가원 항목끼리 겹침
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const x = items[a]!;
      const y = items[b]!;
      if (x.startAt < y.endAt && y.startAt < x.endAt) {
        warnings.push({
          code: "overlap_items",
          message: `${x.no}번째와 ${y.no}번째 휴가 항목의 기간이 겹칩니다.`,
        });
      }
    }
  }
  return warnings;
}

export function warningItemsOf(evaluated: readonly EvaluatedItem[]): WarningItem[] {
  const out: WarningItem[] = [];
  evaluated.forEach((e, idx) => {
    if (!e.usage) return;
    out.push({
      no: idx + 1,
      leaveTypeId: e.input.leaveTypeId,
      startAt: e.input.startAt,
      endAt: e.input.endAt,
      minutesByYear: e.usage.byYear,
      byDate: e.usage.byDate,
    });
  });
  return out;
}

/** 작성 화면 미리보기. 항목 오류는 던지지 않고 items[i].error 로 */
export function buildPreview(
  db: Db,
  employeeId: number,
  schedule: WorkSchedule,
  items: readonly LeaveRequestItemInput[],
  excludeRequestId: number | null,
  allowInactive: ReadonlySet<number>,
  today: string,
): LeavePreview {
  const evaluated = evaluateItems(db, employeeId, items, schedule, allowInactive);
  const valid = warningItemsOf(evaluated);

  const totals = new Map<number, number>();
  for (const e of evaluated) {
    if (e.usage) totals.set(e.input.leaveTypeId, (totals.get(e.input.leaveTypeId) ?? 0) + e.usage.minutes);
  }

  // 잔여 기준일 = 휴가 시작일 (정한 날짜 소멸은 그날이 든 기간, 부여 후 기간 소멸은 그날 쓸 수 있는 양)
  const date = (items[0]?.startAt ?? today).slice(0, 10);
  const year = yearOf(date);
  const usedTypes = new Set(items.map((i) => i.leaveTypeId));
  const activeTypes = new Set(listLeaveTypes(db).map((t) => t.id));
  const visible = (rows: BalanceRow[]) =>
    rows.filter((r) => activeTypes.has(r.leaveTypeId) || usedTypes.has(r.leaveTypeId));
  const balancesBefore = getEmployeeBalances(db, employeeId, year, {
    excludeRequestId,
    includeInactiveTypes: true,
    date,
    today,
  });
  const balancesAfter = getEmployeeBalances(db, employeeId, year, {
    excludeRequestId,
    includeInactiveTypes: true,
    extraUsage: extraUsageOf(valid),
    date,
    today,
  });

  return {
    items: evaluated.map((e) => ({
      minutes: e.usage?.minutes ?? 0,
      minutesByYear: e.usage?.byYear ?? {},
      error: e.error,
    })),
    totalsByType: [...totals].map(([leaveTypeId, minutes]) => ({ leaveTypeId, minutes })),
    balancesBefore: visible(balancesBefore),
    balancesAfter: visible(balancesAfter),
    warnings: collectWarnings(db, employeeId, valid, excludeRequestId),
  };
}

/** 항목 저장 (기존 항목은 호출 전에 지울 것). sort_order = 입력 순서 */
export function insertItems(db: Db, requestId: number, evaluated: readonly EvaluatedItem[]): void {
  evaluated.forEach((e, idx) => {
    execute(
      db,
      `INSERT INTO leave_request_items (request_id, leave_type_id, start_at, end_at, minutes, minutes_by_year,
         minutes_by_date, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        e.input.leaveTypeId,
        e.input.startAt,
        e.input.endAt,
        e.usage!.minutes,
        JSON.stringify(e.usage!.byYear),
        byDateJson(e.usage!.byDate),
        idx,
      ],
    );
  });
}

/** 변경 이력 한 줄: "홍길동 휴가원 취소 (연차 2026.10.01. 10:00 ~ 19:00)" */
export function describeRequest(r: Pick<LeaveRequest, "employeeName" | "items">, verb: string): string {
  const periods = r.items.map((i) => `${i.leaveTypeName} ${formatPeriod(i.startAt, i.endAt)}`).join(", ");
  return `${r.employeeName} 휴가원 ${verb} (${periods})`;
}

/** 출력 데이터 (휴가현황 표·체크박스) */
export function buildPrintData(db: Db, request: LeaveRequest, today: string): LeavePrintData {
  // 잔여 기준일 = 휴가 시작일
  const date = (request.items[0]?.startAt ?? today).slice(0, 10);
  const year = yearOf(date);
  const usedTypes = new Set(request.items.map((i) => i.leaveTypeId));
  // 영구 삭제된 직원도 부여·기존 잔여는 숨겨 보관하므로 휴가현황을 그대로 계산
  const balances = new Map(
    getEmployeeBalances(db, request.employeeId, year, { includeInactiveTypes: true, date, today }).map((b) => [
      b.leaveTypeId,
      b,
    ]),
  );
  // 잔여 행이 없는 종류 = 이 직원에게 적용되지 않고 기록도 없는 종류. 이 휴가원의 종류는 영구 삭제됐어도 이름으로 보임
  // 잔여가 없으면 숨기는 소진 종류도 뺌 (이 휴가원에서 쓴 종류는 보임)
  const hiddenEmpty = (t: LeaveType) =>
    t.balanceMode === "used_up" && t.hideWhenEmpty && (balances.get(t.id)?.remainingMinutes ?? 0) <= 0;
  const shown = listLeaveTypes(db, { includeInactive: true, includeDeleted: true }).filter(
    (t) => (t.active && balances.has(t.id) && !hiddenEmpty(t)) || usedTypes.has(t.id),
  );
  // 보이는 이름 (양식 안에서 겹치면 관리 이름으로 구별)
  const label = distinctLeaveTypeLabels(shown);
  const currentOf = (typeId: number) =>
    request.items
      .filter((i) => i.leaveTypeId === typeId)
      .reduce((sum, i) => sum + (i.minutesByYear[String(year)] ?? 0), 0);
  // 결재칸 = 지금 직원 설정 (영구 삭제된 직원도 행은 남아 있음)
  const employee = queryOne(db, "SELECT approval_roles FROM employees WHERE id = ?", [request.employeeId]);

  return {
    request,
    submitDate: today,
    year,
    approvalRoles: parseJson<ApprovalRole[]>(employee?.approval_roles, DEFAULT_APPROVAL_ROLES),
    balanceTable: shown.map((t) => {
      const b = balances.get(t.id);
      const granted = b?.grantedMinutes ?? 0;
      const used = b?.usedMinutes ?? 0;
      return {
        leaveTypeId: t.id,
        name: label(t),
        // 차감 안 하는 종류(공가 등)는 총휴가일·잔여일 빈칸
        grantedMinutes: t.deducts ? granted : null,
        currentMinutes: currentOf(t.id),
        usedMinutes: used,
        remainingMinutes: t.deducts ? granted - used : null,
      };
    }),
    checkboxes: shown.map((t) => ({ leaveTypeId: t.id, name: label(t), checked: usedTypes.has(t.id) })),
  };
}
