// DB 행 → API 타입 변환과 자주 쓰는 조회. 모든 기능에서 공통으로 사용.
import type {
  ApprovalRole,
  AuditLog,
  BalanceMode,
  Employee,
  Grant,
  Holiday,
  LeaveRequest,
  LeaveRequestItem,
  LeaveType,
  OpeningBalance,
  OvertimeCategory,
  OvertimeKind,
  OvertimeRequest,
  OvertimeTarget,
} from "@leave-flow/shared";
import { DEFAULT_APPROVAL_ROLES } from "@leave-flow/shared";
import {
  parseJson,
  queryAll,
  queryOne,
  toBool,
  toNullableNum,
  toNullableStr,
  toNum,
  type Db,
  type Row,
} from "../db/index.ts";

function employeeFromRow(r: Row): Employee {
  return {
    id: toNum(r.id),
    name: String(r.name),
    department: String(r.department),
    color: String(r.color),
    workDays: parseJson<number[]>(r.work_days, [1, 2, 3, 4, 5]),
    workStart: String(r.work_start),
    workEnd: String(r.work_end),
    emergencyContact: String(r.emergency_contact),
    approvalRoles: parseJson<ApprovalRole[]>(r.approval_roles, DEFAULT_APPROVAL_ROLES),
    category: String(r.category),
    isSocialServiceAgent: toBool(r.social_service_agent),
    active: toBool(r.active),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** 직원 + 구분의 사회복무요원 특별휴가 대상 여부 */
const EMPLOYEE_SELECT = `SELECT e.*, COALESCE(c.social_service_agent, 0) AS social_service_agent
  FROM employees e LEFT JOIN categories c ON c.name = e.category AND e.category <> ''`;

export function listEmployees(db: Db, opts: { includeInactive?: boolean; includeDeleted?: boolean } = {}): Employee[] {
  const conds = [opts.includeDeleted ? "" : "e.deleted = 0", opts.includeInactive ? "" : "e.active = 1"].filter(Boolean);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return queryAll(db, `${EMPLOYEE_SELECT} ${where} ORDER BY e.active DESC, e.name, e.id`).map(employeeFromRow);
}

/** 적용 대상 판단용 직원 정보 (영구 삭제된 직원도: 소속·구분은 남겨 둠) */
export function employeeTargetInfo(db: Db, id: number): Pick<Employee, "id" | "department" | "category"> {
  const r = queryOne(db, "SELECT department, category FROM employees WHERE id = ?", [id]);
  return { id, department: r ? String(r.department) : "", category: r ? String(r.category) : "" };
}

export function getEmployee(db: Db, id: number): Employee | null {
  const r = queryOne(db, `${EMPLOYEE_SELECT} WHERE e.id = ? AND e.deleted = 0`, [id]);
  return r ? employeeFromRow(r) : null;
}

/** SQL: 휴가 종류의 보이는 이름 (표시 이름, 없으면 관리 이름). alias = leave_types 별칭 */
export const typeLabelSql = (alias: string) =>
  `CASE WHEN ${alias}.display_name <> '' THEN ${alias}.display_name ELSE ${alias}.name END`;

const LEAVE_TYPE_IN_USE = `(
  EXISTS (SELECT 1 FROM leave_grants g WHERE g.leave_type_id = t.id)
  OR EXISTS (SELECT 1 FROM leave_request_items i WHERE i.leave_type_id = t.id)
  OR EXISTS (SELECT 1 FROM opening_balances o WHERE o.leave_type_id = t.id)
) AS in_use`;

/**
 * @param employeeIds 따로 고른 대상 직원 (leave_type_employees). undefined = 행 없음.
 *   영구 삭제된 직원의 행만 있으면 [] (대상을 정한 종류)
 */
function leaveTypeFromRow(r: Row, employeeIds?: number[]): LeaveType {
  const departments = parseJson<string[]>(r.target_departments, []);
  const categories = parseJson<string[]>(r.target_categories, []);
  const restricted = employeeIds !== undefined || departments.length > 0 || categories.length > 0;
  return {
    id: toNum(r.id),
    name: String(r.name),
    displayName: String(r.display_name),
    deducts: toBool(r.deducts),
    balanceMode: r.balance_mode as BalanceMode,
    expireMonth: toNullableNum(r.expire_month),
    expireDay: toNullableNum(r.expire_day),
    validMonths: toNullableNum(r.valid_months),
    hideWhenEmpty: toBool(r.hide_when_empty),
    target: restricted ? { departments, categories, employeeIds: employeeIds ?? [] } : null,
    sortOrder: toNum(r.sort_order),
    active: toBool(r.active),
    inUse: toBool(r.in_use),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * 종류별로 따로 고른 대상 직원 ID (오름차순). 행이 없는 종류는 map 에 없음.
 * 영구 삭제된 직원의 행(휴가현황용으로 보관)은 대상 목록에 넣지 않지만, 그 행만 있어도 "선택한 직원만" 종류로 봄.
 */
function leaveTypeEmployeeIds(db: Db, leaveTypeId?: number): Map<number, number[]> {
  const rows = queryAll(
    db,
    `SELECT x.leave_type_id, x.employee_id, e.deleted
       FROM leave_type_employees x JOIN employees e ON e.id = x.employee_id
      ${leaveTypeId === undefined ? "" : "WHERE x.leave_type_id = ?"}
      ORDER BY x.leave_type_id, x.employee_id`,
    leaveTypeId === undefined ? [] : [leaveTypeId],
  );
  const map = new Map<number, number[]>();
  for (const r of rows) {
    const typeId = toNum(r.leave_type_id);
    const ids = map.get(typeId) ?? [];
    if (!toBool(r.deleted)) ids.push(toNum(r.employee_id));
    map.set(typeId, ids);
  }
  return map;
}

/** 표시 순서대로. 영구 삭제된 종류는 includeDeleted 일 때만 (휴가원 양식에 이름을 보일 때) */
export function listLeaveTypes(
  db: Db,
  opts: { includeInactive?: boolean; includeDeleted?: boolean } = {},
): LeaveType[] {
  const conds = [opts.includeDeleted ? "" : "t.deleted = 0", opts.includeInactive ? "" : "t.active = 1"].filter(Boolean);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const targets = leaveTypeEmployeeIds(db);
  return queryAll(
    db,
    `SELECT t.*, ${LEAVE_TYPE_IN_USE} FROM leave_types t ${where} ORDER BY t.sort_order, t.id`,
  ).map((r) => leaveTypeFromRow(r, targets.get(toNum(r.id))));
}

export function getLeaveType(db: Db, id: number): LeaveType | null {
  const r = queryOne(db, `SELECT t.*, ${LEAVE_TYPE_IN_USE} FROM leave_types t WHERE t.id = ? AND t.deleted = 0`, [id]);
  return r ? leaveTypeFromRow(r, leaveTypeEmployeeIds(db, id).get(id)) : null;
}

export function grantFromRow(r: Row): Grant {
  return {
    id: toNum(r.id),
    employeeId: toNum(r.employee_id),
    leaveTypeId: toNum(r.leave_type_id),
    grantDate: String(r.grant_date),
    minutes: toNum(r.minutes),
    note: String(r.note),
    source: r.source === "overtime" ? "overtime" : "manual",
    overtimeRequestId: toNullableNum(r.overtime_request_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function openingFromRow(r: Row): OpeningBalance {
  return {
    id: toNum(r.id),
    employeeId: toNum(r.employee_id),
    leaveTypeId: toNum(r.leave_type_id),
    year: toNum(r.year),
    baseDate: String(r.base_date),
    totalGrantedMinutes: toNum(r.total_granted_minutes),
    remainingMinutes: toNum(r.remaining_minutes),
    usedMinutes: toNum(r.used_minutes),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function leaveItemFromRow(r: Row): LeaveRequestItem {
  return {
    id: toNum(r.id),
    leaveTypeId: toNum(r.leave_type_id),
    leaveTypeName: String(r.type_name),
    leaveTypeDisplayName: String(r.type_label),
    leaveTypeDeleted: toBool(r.type_deleted),
    startAt: String(r.start_at),
    endAt: String(r.end_at),
    minutes: toNum(r.minutes),
    minutesByYear: parseJson<Record<string, number>>(r.minutes_by_year, {}),
  };
}

function leaveRequestFromRow(r: Row, items: LeaveRequestItem[]): LeaveRequest {
  return {
    id: toNum(r.id),
    employeeId: toNum(r.employee_id),
    employeeName: String(r.employee_name),
    department: String(r.department),
    color: String(r.color),
    employeeDeleted: toBool(r.employee_deleted),
    appliedOn: String(r.applied_on),
    workDays: parseJson<number[]>(r.work_days, [1, 2, 3, 4, 5]),
    workStart: String(r.work_start),
    workEnd: String(r.work_end),
    reason: String(r.reason),
    emergencyContact: String(r.emergency_contact),
    handoverNote: String(r.handover_note),
    status: r.status === "cancelled" ? "cancelled" : "active",
    cancelledAt: toNullableStr(r.cancelled_at),
    lastPrintedAt: toNullableStr(r.last_printed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    items,
    totalMinutes: items.reduce((s, i) => s + i.minutes, 0),
  };
}

const LEAVE_ITEM_SELECT = `SELECT i.*, t.name AS type_name, ${typeLabelSql("t")} AS type_label, t.deleted AS type_deleted
  FROM leave_request_items i JOIN leave_types t ON t.id = i.leave_type_id`;

export function getLeaveRequest(db: Db, id: number): LeaveRequest | null {
  const r = queryOne(
    db,
    "SELECT r.*, e.color, e.deleted AS employee_deleted FROM leave_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = ?",
    [id],
  );
  if (!r) return null;
  const items = queryAll(db, `${LEAVE_ITEM_SELECT} WHERE i.request_id = ? ORDER BY i.sort_order, i.id`, [id]).map(
    leaveItemFromRow,
  );
  return leaveRequestFromRow(r, items);
}

/** 여러 휴가원을 한 번에 (id 순서 유지) */
export function getLeaveRequests(db: Db, ids: readonly number[]): LeaveRequest[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = queryAll(
    db,
    `SELECT r.*, e.color, e.deleted AS employee_deleted FROM leave_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id IN (${placeholders})`,
    [...ids],
  );
  const items = queryAll(
    db,
    `${LEAVE_ITEM_SELECT} WHERE i.request_id IN (${placeholders}) ORDER BY i.sort_order, i.id`,
    [...ids],
  );
  const byRequest = new Map<number, LeaveRequestItem[]>();
  for (const it of items) {
    const rid = toNum(it.request_id);
    const list = byRequest.get(rid) ?? [];
    list.push(leaveItemFromRow(it));
    byRequest.set(rid, list);
  }
  const map = new Map(rows.map((r) => [toNum(r.id), leaveRequestFromRow(r, byRequest.get(toNum(r.id)) ?? [])]));
  return ids.map((id) => map.get(id)).filter((r): r is LeaveRequest => r !== undefined);
}

function overtimeTargetFromRow(r: Row): OvertimeTarget {
  return {
    employeeId: toNum(r.employee_id),
    employeeName: String(r.employee_name),
    employeeDeleted: toBool(r.employee_deleted),
    minutes: toNum(r.minutes),
    days: toNullableNum(r.days),
    month: toNullableNum(r.month),
    leaveTypeId: toNum(r.leave_type_id),
  };
}

export function overtimeFromRow(db: Db, r: Row): OvertimeRequest {
  const id = toNum(r.id);
  const kind = r.kind as OvertimeKind;
  const targets = queryAll(
    db,
    `SELECT ot.*, e.deleted AS employee_deleted FROM overtime_targets ot JOIN employees e ON e.id = ot.employee_id
      WHERE ot.overtime_request_id = ? ORDER BY ot.sort_order, ot.id`,
    [id],
  ).map(overtimeTargetFromRow);
  const accrued = !!queryOne(db, "SELECT 1 AS x FROM leave_grants WHERE overtime_request_id = ? LIMIT 1", [id]);
  return {
    id,
    kind,
    workStartAt: toNullableStr(r.work_start_at),
    workEndAt: toNullableStr(r.work_end_at),
    minutes: toNullableNum(r.minutes),
    cumulativeNote: String(r.cumulative_note),
    category: r.category as OvertimeCategory,
    workDetails: String(r.work_details),
    paidOn: toNullableStr(r.paid_on),
    submittedOn: toNullableStr(r.submitted_on),
    status: r.status === "cancelled" ? "cancelled" : "active",
    cancelledAt: toNullableStr(r.cancelled_at),
    lastPrintedAt: toNullableStr(r.last_printed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    targets,
    accrued,
  };
}

export function getOvertimeRequest(db: Db, id: number): OvertimeRequest | null {
  const r = queryOne(db, "SELECT * FROM overtime_requests WHERE id = ?", [id]);
  return r ? overtimeFromRow(db, r) : null;
}

export function holidayFromRow(r: Row): Holiday {
  return {
    id: toNum(r.id),
    date: String(r.date),
    name: String(r.name),
    kind: r.kind === "center" ? "center" : "public",
    source: r.source === "manual" ? "manual" : "auto",
    active: toBool(r.active),
  };
}

export function auditFromRow(r: Row): AuditLog {
  return {
    id: toNum(r.id),
    at: String(r.at),
    ip: String(r.ip),
    entity: String(r.entity) as AuditLog["entity"],
    entityId: toNullableNum(r.entity_id),
    employeeId: toNullableNum(r.employee_id),
    action: String(r.action) as AuditLog["action"],
    summary: String(r.summary),
    before: parseJson<unknown>(r.before_json, null),
    after: parseJson<unknown>(r.after_json, null),
  };
}
