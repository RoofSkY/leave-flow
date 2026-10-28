import {
  computeBalances,
  leaveTypeAppliesTo,
  type BalanceGrant,
  type BalanceOpening,
  type BalanceRow,
  type BalanceUsage,
} from "@leave-flow/shared";
import { parseJson, queryAll, toNum, type Db } from "../db/index.ts";
import { parseByDate } from "./leaveUsage.ts";
import { employeeTargetInfo, listLeaveTypes } from "./queries.ts";

export interface BalanceOptions {
  /** 이 휴가원은 사용량에서 제외 (수정·복구 중인 휴가원의 미리보기·경고) */
  excludeRequestId?: number | null;
  /**
   * 추가로 더할 사용량 (아직 저장 안 한 신청).
   * 기존 잔여 입력 기준일자 이전 사용을 빼려면 byDate(계산 결과의 날짜별 사용)도 함께 넘길 것.
   */
  extraUsage?: readonly BalanceUsage[];
  /** 비활성 휴가 종류도 포함 */
  includeInactiveTypes?: boolean;
  /** 기준일 (휴가원 미리보기·출력: 휴가 시작일, 경고: 휴가를 쓰는 날). computeBalances 참고 */
  date?: string;
  /** 오늘 (부여 후 기간 소멸의 올해 잔여 기준) */
  today?: string;
}

/**
 * 직원의 휴가 종류별 부여·사용·잔여 (year 기준).
 * 사용량 = 신청 상태 휴가원 항목 + 기존 잔여 입력의 기존 사용량. 취소된 휴가원은 제외.
 * 부여량 = 부여 내역(직접 입력 + 적립된 시간외근무) + 기존 잔여 입력의 총 부여량.
 * 기존 잔여 입력이 있는 (종류, 연도)는 기준일자 이후의 부여·사용만 더함 (computeBalances 참고).
 * 적용 대상 직원을 정한 종류는 대상이 아니면 기록이 있을 때만 행이 생김.
 */
export function getEmployeeBalances(
  db: Db,
  employeeId: number,
  year: number,
  opts: BalanceOptions = {},
): BalanceRow[] {
  const types = listLeaveTypes(db, { includeInactive: opts.includeInactiveTypes ?? false });
  const grants = queryAll(
    db,
    "SELECT leave_type_id, grant_date, minutes FROM leave_grants WHERE employee_id = ?",
    [employeeId],
  ).map<BalanceGrant>((r) => ({
    leaveTypeId: toNum(r.leave_type_id),
    grantDate: String(r.grant_date),
    minutes: toNum(r.minutes),
  }));
  const openings = queryAll(
    db,
    "SELECT leave_type_id, year, base_date, total_granted_minutes, used_minutes FROM opening_balances WHERE employee_id = ?",
    [employeeId],
  ).map<BalanceOpening>((r) => ({
    leaveTypeId: toNum(r.leave_type_id),
    year: toNum(r.year),
    baseDate: String(r.base_date),
    totalGrantedMinutes: toNum(r.total_granted_minutes),
    usedMinutes: toNum(r.used_minutes),
  }));
  // 종류별 가장 늦은 기준일자. 이보다 뒤에 시작하는 항목은 날짜별로 나눌 필요 없음
  const latestBaseDate = new Map<number, string>();
  for (const o of openings) {
    const prev = latestBaseDate.get(o.leaveTypeId);
    if (prev === undefined || o.baseDate > prev) latestBaseDate.set(o.leaveTypeId, o.baseDate);
  }
  // 정한 날짜 소멸·부여 후 기간 소멸 종류는 날짜별 사용이 필요
  const byDateTypes = new Set(
    types.filter((t) => t.balanceMode === "expire_date" || t.balanceMode === "grant_period").map((t) => t.id),
  );
  const usages = queryAll(
    db,
    `SELECT i.leave_type_id, i.start_at, i.minutes_by_year, i.minutes_by_date
       FROM leave_request_items i JOIN leave_requests r ON r.id = i.request_id
      WHERE r.employee_id = ? AND r.status = 'active' AND r.id <> ?`,
    [employeeId, opts.excludeRequestId ?? -1],
  ).map<BalanceUsage>((r) => {
    const leaveTypeId = toNum(r.leave_type_id);
    const usage: BalanceUsage = {
      leaveTypeId,
      minutesByYear: parseJson<Record<string, number>>(r.minutes_by_year, {}),
    };
    const base = latestBaseDate.get(leaveTypeId);
    const startAt = String(r.start_at);
    if (byDateTypes.has(leaveTypeId) || (base !== undefined && startAt.slice(0, 10) <= base)) {
      // 저장할 때 계산해 둔 날짜별 사용 (기준일자 이전 사용 가려내기, 기간·소멸 계산).
      // 지금 공휴일로 다시 세면 지난 날짜의 공휴일이 바뀌었을 때 휴가원의 사용 시간과 어긋남
      usage.byDate = parseByDate(r.minutes_by_date);
    }
    return usage;
  });
  // 이 직원에게 적용되지 않는 종류는 기록(부여·기존 잔여·사용)이 있을 때만.
  // 영구 삭제된 직원은 대상 목록에서 빠지므로 보관한 대상 행으로 확인
  const recorded = new Set(
    [...grants, ...openings, ...usages, ...(opts.extraUsage ?? [])].map((r) => r.leaveTypeId),
  );
  const employee = employeeTargetInfo(db, employeeId);
  const targeted = new Set(
    queryAll(db, "SELECT leave_type_id FROM leave_type_employees WHERE employee_id = ?", [employeeId]).map((r) =>
      toNum(r.leave_type_id),
    ),
  );
  return computeBalances(
    year,
    types.filter((t) => leaveTypeAppliesTo(t, employee) || targeted.has(t.id) || recorded.has(t.id)),
    grants,
    openings,
    [...usages, ...(opts.extraUsage ?? [])],
    { date: opts.date, today: opts.today },
  );
}
