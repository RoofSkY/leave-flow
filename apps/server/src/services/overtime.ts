// 시간외근무 신청서: 저장·수정·취소·복구·출력과 휴가 적립(부여 내역 자동 생성).
// 적립 규칙: 일반 = 처음 출력할 때(제출일 = 그날), 요원·시상 = 저장할 때(부여일 = 지급일자). 대상자마다 부여 1건.
// 적립 종류: 신청서에서 대상자마다 고른 종류 (저장할 때 대상자마다 기록).
import {
  LEAVE_STEP_MINUTES,
  dayMinutesOf,
  editBaseInput,
  formatDotDate,
  formatHoursMinutes,
  formatPeriod,
  leaveTypeAppliesTo,
  overtimeAwardInput,
  overtimeGeneralInput,
  overtimeSoldierInput,
  parseDateTime,
  yearOf,
  type DocStatus,
  type OvertimeInput,
  type OvertimeKind,
  type OvertimePrintData,
  type OvertimeRequest,
} from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { execute, queryAll, queryOne, toNullableNum, toNum, transaction, type Db } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { parseInput } from "../lib/http.ts";
import { writeAudit } from "./audit.ts";
import { recordPrint } from "./printLog.ts";
import { employeeTargetInfo, getEmployee, getLeaveType, getOvertimeRequest, overtimeFromRow } from "./queries.ts";

/** 적립 부여 내역의 비고 (일반은 근무시간을 붙임) */
const GRANT_NOTE: Record<Exclude<OvertimeKind, "general">, string> = {
  soldier: "사회복무요원 특별휴가",
  award: "사회복무요원 특별휴가(시상)",
};

interface TargetInput {
  employeeId: number;
  employeeName: string;
  leaveTypeId: number;
  minutes: number;
  days: number | null;
  month: number | null;
}

/** kind 로 일반/요원/시상 양식을 골라 검사 (각 양식의 한국어 오류 메시지가 그대로 나가도록) */
function parseOvertimeInput(body: unknown): OvertimeInput {
  const kind = (body as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "soldier") return parseInput(overtimeSoldierInput, body);
  if (kind === "award") return parseInput(overtimeAwardInput, body);
  if (kind !== "general") throw badRequest("신청서 종류가 올바르지 않습니다.");
  const input = parseInput(overtimeGeneralInput, body);
  for (const at of [input.workStartAt, input.workEndAt]) {
    if (parseDateTime(at).minutes % LEAVE_STEP_MINUTES !== 0) throw badRequest("근무시간은 10분 단위로 입력하세요.");
  }
  return input;
}

export function findOvertime(db: Db, id: number): OvertimeRequest {
  const r = getOvertimeRequest(db, id);
  if (!r) throw notFound("시간외근무 신청서를 찾을 수 없습니다.");
  return r;
}

export function listOvertime(
  db: Db,
  q: { kind?: OvertimeKind; status: DocStatus | "all"; year?: number },
): OvertimeRequest[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.kind) {
    where.push("kind = ?");
    params.push(q.kind);
  }
  if (q.status !== "all") {
    where.push("status = ?");
    params.push(q.status);
  }
  if (q.year !== undefined) {
    // 일반 = 근무 시작 연도, 요원·시상 = 지급 연도
    where.push(
      "((kind = 'general' AND substr(work_start_at, 1, 4) = ?) OR (kind <> 'general' AND substr(paid_on, 1, 4) = ?))",
    );
    params.push(String(q.year), String(q.year));
  }
  const sql = `SELECT * FROM overtime_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC`;
  return queryAll(db, sql, params).map((r) => overtimeFromRow(db, r));
}

/** 출력 데이터 (기록·적립 없음). 일반: 제출일(미제출이면 오늘), 요원·시상: 오늘 */
export function overtimePrintData(ctx: AppContext, req: OvertimeRequest): OvertimePrintData {
  if (req.status === "cancelled") throw conflict("취소된 신청서는 출력할 수 없습니다.");
  if (req.kind === "general") {
    const submitDate = req.submittedOn ?? ctx.today();
    return { request: req, submitDate, year: yearOf(submitDate) };
  }
  return { request: req, submitDate: ctx.today(), year: yearOf(req.paidOn ?? ctx.today()) };
}

export function createOvertime(ctx: AppContext, ip: string, body: unknown): OvertimeRequest {
  const input = parseOvertimeInput(body);
  const db = ctx.db;
  return transaction(db, () => {
    const targets = resolveTargets(db, input, null);
    const now = ctx.now();
    const id = execute(
      db,
      `INSERT INTO overtime_requests (kind, work_start_at, work_end_at, minutes, cumulative_note, category,
         work_details, paid_on, status, created_at, updated_at)
       VALUES (:kind, :work_start_at, :work_end_at, :minutes, :cumulative_note, :category,
         :work_details, :paid_on, 'active', :now, :now)`,
      { ...docColumns(input), kind: input.kind, now },
    ).lastInsertRowid;
    writeTargets(db, id, targets);
    const accrued = syncGrants(db, id, now);
    const created = findOvertime(db, id);
    writeAudit(
      db,
      ip,
      {
        entity: "overtime_request",
        entityId: id,
        employeeId: soleEmployeeId(created),
        action: "create",
        summary: `${describe(created)} 작성`,
        after: created,
      },
      now,
    );
    if (accrued) writeAccrueAudit(db, ip, created, now);
    return created;
  });
}

export function updateOvertime(ctx: AppContext, ip: string, id: number, body: unknown): OvertimeRequest {
  const input = parseOvertimeInput(body);
  const db = ctx.db;
  return transaction(db, () => {
    const before = findOvertime(db, id);
    const { baseUpdatedAt } = parseInput(editBaseInput, body);
    if (before.status === "cancelled") throw conflict("취소된 신청서는 수정할 수 없습니다.");
    assertNoDeletedTarget(before);
    if (before.kind !== input.kind) throw badRequest("신청서 종류는 바꿀 수 없습니다.");
    // 수정 창을 연 뒤 다른 사람이 먼저 고쳤으면 덮어쓰지 않음
    if (baseUpdatedAt !== before.updatedAt) {
      throw conflict("다른 사람이 이 신청서를 먼저 수정했습니다. 창을 닫고 다시 열어 바뀐 내용을 확인한 뒤 수정하세요.");
    }
    const targets = resolveTargets(db, input, before);
    const now = ctx.now();
    execute(
      db,
      `UPDATE overtime_requests SET work_start_at = :work_start_at, work_end_at = :work_end_at, minutes = :minutes,
         cumulative_note = :cumulative_note, category = :category, work_details = :work_details, paid_on = :paid_on,
         updated_at = :now
       WHERE id = :id`,
      { ...docColumns(input), now, id },
    );
    writeTargets(db, id, targets);
    syncGrants(db, id, now);
    const after = findOvertime(db, id);
    writeAudit(
      db,
      ip,
      {
        entity: "overtime_request",
        entityId: id,
        employeeId: soleEmployeeId(after),
        action: "update",
        summary: `${describe(after)} 수정${after.accrued ? " (적립도 함께 수정)" : ""}`,
        before,
        after,
      },
      now,
    );
    return after;
  });
}

export function cancelOvertime(ctx: AppContext, ip: string, id: number): OvertimeRequest {
  const db = ctx.db;
  return transaction(db, () => {
    const before = findOvertime(db, id);
    if (before.status === "cancelled") throw conflict("이미 취소된 신청서입니다.");
    assertNoDeletedTarget(before);
    const now = ctx.now();
    execute(db, "UPDATE overtime_requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [
      now,
      now,
      id,
    ]);
    syncGrants(db, id, now);
    const after = findOvertime(db, id);
    writeAudit(
      db,
      ip,
      {
        entity: "overtime_request",
        entityId: id,
        employeeId: soleEmployeeId(after),
        action: "cancel",
        summary: `${describe(after)} 취소${before.accrued ? " (적립 회수)" : ""}`,
        before,
        after,
      },
      now,
    );
    return after;
  });
}

export function restoreOvertime(ctx: AppContext, ip: string, id: number): OvertimeRequest {
  const db = ctx.db;
  return transaction(db, () => {
    const before = findOvertime(db, id);
    if (before.status !== "cancelled") throw conflict("취소된 신청서만 복구할 수 있습니다.");
    assertNoDeletedTarget(before);
    const now = ctx.now();
    execute(db, "UPDATE overtime_requests SET status = 'active', cancelled_at = NULL, updated_at = ? WHERE id = ?", [
      now,
      id,
    ]);
    const accrued = syncGrants(db, id, now);
    const after = findOvertime(db, id);
    writeAudit(
      db,
      ip,
      {
        entity: "overtime_request",
        entityId: id,
        employeeId: soleEmployeeId(after),
        action: "restore",
        summary: `${describe(after)} 복구`,
        before,
        after,
      },
      now,
    );
    if (accrued) writeAccrueAudit(db, ip, after, now);
    return after;
  });
}

/** 출력 기록. 미제출 일반 신청서는 이때 제출일을 오늘로 정하고 적립 */
export function printOvertime(ctx: AppContext, ip: string, id: number): OvertimePrintData {
  const db = ctx.db;
  return transaction(db, () => {
    const before = findOvertime(db, id);
    if (before.status === "cancelled") throw conflict("취소된 신청서는 출력할 수 없습니다.");
    const now = ctx.now();
    let accrued = 0;
    if (before.kind === "general" && !before.submittedOn) {
      execute(db, "UPDATE overtime_requests SET submitted_on = ? WHERE id = ?", [ctx.today(), id]);
      accrued = syncGrants(db, id, now);
    }
    recordPrint(db, "overtime", id, now);
    const after = findOvertime(db, id);
    if (accrued) writeAccrueAudit(db, ip, after, now);
    writeAudit(
      db,
      ip,
      {
        entity: "overtime_request",
        entityId: id,
        employeeId: soleEmployeeId(after),
        action: "print",
        summary: `${describe(after)} 출력`,
        // 대상이 여러 명이면 employee_id 가 비므로, 나중에 대상이 바뀌어도 직원 필터로 찾을 수 있게 출력 당시 대상을 남김
        after: { targets: after.targets.map((t) => ({ employeeId: t.employeeId })) },
      },
      now,
    );
    return overtimePrintData(ctx, after);
  });
}

/* ---------- 내부 ---------- */

function docColumns(input: OvertimeInput) {
  return input.kind === "general"
    ? {
        work_start_at: input.workStartAt,
        work_end_at: input.workEndAt,
        minutes: input.minutes,
        cumulative_note: input.cumulativeNote,
        category: input.category,
        work_details: input.workDetails,
        paid_on: null,
      }
    : {
        work_start_at: null,
        work_end_at: null,
        minutes: null,
        cumulative_note: "",
        category: input.category,
        work_details: input.workDetails,
        paid_on: input.paidOn,
      };
}

/** 영구 삭제된 직원이 들어 있는 신청서는 보기·출력만 */
function assertNoDeletedTarget(req: OvertimeRequest): void {
  if (req.targets.some((t) => t.employeeDeleted)) {
    throw conflict("영구 삭제된 직원이 들어 있는 신청서는 수정·취소·복구할 수 없습니다. (보기·출력만 가능)");
  }
}

/**
 * 대상자 확인 + 성명 기록(작성 시점 값).
 * 새로 고르는 대상은 활성 직원이어야 하고, 요원·시상 신청서는 구분이 사회복무요원 특별휴가 대상인 직원만.
 * 고른 적립 종류는 활성이고 그 직원에게 적용되는 종류여야 함.
 * 수정할 때 원래 대상이던 직원은 그 뒤 비활성·구분 변경되었어도 그대로 둘 수 있고 (원래 고른 종류도 마찬가지),
 * 성명도 작성 시점 값을 그대로 둔다 (그 뒤 이름이 바뀌어도 제출된 양식의 성명이 바뀌지 않도록).
 * 수정 때 새로 추가한 대상만 지금 이름으로 기록.
 */
function resolveTargets(db: Db, input: OvertimeInput, existing: OvertimeRequest | null): TargetInput[] {
  const stored = new Map(existing?.targets.map((t) => [t.employeeId, t]) ?? []);
  const items =
    input.kind === "general"
      ? input.targets.map((t) => ({ employeeId: t.employeeId, leaveTypeId: t.leaveTypeId, days: null, month: null }))
      : input.targets.map((t) => ({
          employeeId: t.employeeId,
          leaveTypeId: t.leaveTypeId,
          days: t.days,
          month: "month" in t ? t.month : null,
        }));
  return items.map((t) => {
    const e = getEmployee(db, t.employeeId);
    if (!e) throw badRequest("선택한 직원을 찾을 수 없습니다.");
    // 일반: 금일발생(대상 전원 같은 시간), 요원·시상: 일수 × 그 요원의 하루 근무시간
    const minutes = t.days === null ? (input.kind === "general" ? input.minutes : 0) : t.days * dayMinutesOf(e);
    const prev = stored.get(e.id);
    if (prev === undefined) {
      if (!e.active) throw badRequest(`${e.name}님은 비활성 직원이라 선택할 수 없습니다.`);
      if (input.kind !== "general" && !e.isSocialServiceAgent) {
        throw badRequest(`${e.name}님의 구분은 사회복무요원 특별휴가 대상이 아닙니다.`);
      }
    }
    if (prev?.leaveTypeId !== t.leaveTypeId) {
      const type = getLeaveType(db, t.leaveTypeId);
      if (!type) throw badRequest("선택한 휴가 종류를 찾을 수 없습니다.");
      if (!type.active) throw badRequest(`비활성화된 휴가 종류(${type.name})는 고를 수 없습니다.`);
      if (!leaveTypeAppliesTo(type, e)) throw badRequest(`${e.name}님에게 적용되지 않는 휴가 종류입니다. (${type.name})`);
    }
    return { ...t, minutes, employeeName: prev?.employeeName ?? e.name };
  });
}

/** 대상자를 다시 씀 */
function writeTargets(db: Db, id: number, targets: readonly TargetInput[]): void {
  execute(db, "DELETE FROM overtime_targets WHERE overtime_request_id = ?", [id]);
  targets.forEach((t, i) =>
    execute(
      db,
      `INSERT INTO overtime_targets (overtime_request_id, employee_id, employee_name, minutes, days, month, sort_order,
         leave_type_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.employeeId, t.employeeName, t.minutes, t.days, t.month, i, t.leaveTypeId],
    ),
  );
}

/**
 * 연결된 부여를 지우고, 적립 대상(신청 상태 + 요원·시상 또는 제출된 일반)이면 대상자마다 고른 종류로 다시 만든다.
 * 아직 적립되지 않은 대상자는 고른 종류가 지금도 그 직원에게 적용되어야 함 (저장 뒤 소속·구분이 바뀌었으면 400).
 * @returns 만든 부여 건수
 */
function syncGrants(db: Db, id: number, now: string): number {
  // 이미 적립된 직원은 그 사이 적용 대상에서 빠졌어도 다시 적립 허용
  const granted = new Set(
    queryAll(db, "SELECT employee_id FROM leave_grants WHERE overtime_request_id = ?", [id]).map((g) => toNum(g.employee_id)),
  );
  // 영구 삭제된 직원의 적립은 휴가현황용으로 그대로 둠 (다시 만들지도 않음)
  execute(
    db,
    "DELETE FROM leave_grants WHERE overtime_request_id = ? AND employee_id NOT IN (SELECT id FROM employees WHERE deleted = 1)",
    [id],
  );
  const r = queryOne(db, "SELECT * FROM overtime_requests WHERE id = ?", [id]);
  if (!r || r.status !== "active") return 0;
  const kind = r.kind as OvertimeKind;
  const grantDate = kind === "general" ? r.submitted_on : r.paid_on;
  if (typeof grantDate !== "string") return 0; // 미제출 일반: 아직 적립 안 함

  const note =
    kind === "general" ? `시간외근무 ${formatPeriod(String(r.work_start_at), String(r.work_end_at))}` : GRANT_NOTE[kind];
  const targets = queryAll(
    db,
    `SELECT ot.employee_id, ot.employee_name, ot.minutes, ot.month, ot.leave_type_id FROM overtime_targets ot
       JOIN employees e ON e.id = ot.employee_id
      WHERE ot.overtime_request_id = ? AND e.deleted = 0 ORDER BY ot.sort_order, ot.id`,
    [id],
  );

  // 아직 적립되지 않은 대상자: 고른 종류가 지금도 그 직원에게 적용되는지
  const problems: string[] = [];
  for (const t of targets) {
    const employeeId = toNum(t.employee_id);
    const type = getLeaveType(db, toNum(t.leave_type_id));
    if (type && !granted.has(employeeId) && !leaveTypeAppliesTo(type, employeeTargetInfo(db, employeeId))) {
      problems.push(`${String(t.employee_name)}(${type.name} 적용 안 됨)`);
    }
  }
  if (problems.length > 0) {
    throw badRequest(
      `고른 휴가 종류가 적용되지 않는 직원이 있습니다: ${problems.join(", ")}. 신청서를 수정해 종류를 다시 고르거나 관리 > 휴가 종류의 적용 대상을 확인하세요.`,
    );
  }

  for (const t of targets) {
    const month = toNullableNum(t.month);
    execute(
      db,
      `INSERT INTO leave_grants (employee_id, leave_type_id, grant_date, minutes, note, source, overtime_request_id,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'overtime', ?, ?, ?)`,
      [
        toNum(t.employee_id),
        toNum(t.leave_type_id),
        grantDate,
        toNum(t.minutes),
        month ? `${note} (${month}월분)` : note,
        id,
        now,
        now,
      ],
    );
  }
  return targets.length;
}

function soleEmployeeId(req: OvertimeRequest): number | null {
  return req.targets.length === 1 ? req.targets[0]!.employeeId : null;
}

function targetNames(req: OvertimeRequest): string {
  return req.kind === "general"
    ? req.targets.map((t) => t.employeeName).join(", ")
    : req.targets.map((t) => `${t.employeeName} ${t.days ?? 0}일`).join(", ");
}

/** 변경 이력용 한 줄 설명 */
function describe(req: OvertimeRequest): string {
  if (req.kind === "general") {
    const period = req.workStartAt && req.workEndAt ? `, ${formatPeriod(req.workStartAt, req.workEndAt)}` : "";
    return `시간외근무 신청서 (${targetNames(req)}${period})`;
  }
  return `${GRANT_NOTE[req.kind]} 신청서 (${targetNames(req)}, 지급일자 ${formatDotDate(req.paidOn ?? "")})`;
}

function writeAccrueAudit(db: Db, ip: string, req: OvertimeRequest, now: string): void {
  const typeNames = new Set(req.targets.map((t) => (t.leaveTypeId ? getLeaveType(db, t.leaveTypeId)?.name : undefined)));
  typeNames.delete(undefined);
  const typeName = [...typeNames].join("·") || "휴가";
  const grantDate = req.kind === "general" ? req.submittedOn : req.paidOn;
  const amount =
    req.kind === "general" ? ` 각 ${formatHoursMinutes(req.minutes ?? 0)}` : "";
  writeAudit(
    db,
    ip,
    {
      entity: "overtime_request",
      entityId: req.id,
      employeeId: soleEmployeeId(req),
      action: "accrue",
      summary: `${typeName} 적립: ${targetNames(req)}${amount} (부여일 ${formatDotDate(grantDate ?? "")})`,
      after: {
        grantDate,
        targets: req.targets.map((t) => ({ employeeId: t.employeeId, leaveTypeId: t.leaveTypeId, minutes: t.minutes })),
      },
    },
    now,
  );
}
