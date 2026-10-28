// 직원·휴가 종류 영구 삭제.
// 휴가원·시간외근무 신청서는 지우지 않는다(작성 시점의 성명·종류 이름으로 계속 보임).
// - 남길 문서가 없으면 행을 지움
// - 남길 문서가 있으면 번호만 남기고(deleted = 1) 직원은 이름·연락처를 비움. 목록·선택·잔여 어디에도 나오지 않음
//   (소속·구분은 휴가 종류 적용 대상 판단에 쓰므로 남김)
// 부여 내역·기존 잔여·적용 대상은 함께 지운다. 단 휴가원이 남는 직원의 부여 내역·기존 잔여·적용 대상은
// 그 휴가원의 휴가현황을 그대로 보이도록 숨겨 보관한다(관리 화면·엑셀에 나오지 않음).
import type { DeleteCheck, Employee, LeaveType } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { execute, queryOne, toNum, transaction, type Db } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { writeAudit } from "./audit.ts";
import { createBackup } from "./backup.ts";
import { describeRequest } from "./leaveRequests.ts";
import { getEmployee, getLeaveRequest, getLeaveType } from "./queries.ts";

const count = (db: Db, sql: string, id: number) => toNum(queryOne(db, sql, [id])?.n ?? 0);

export function employeeDeleteCheck(db: Db, e: Employee): DeleteCheck {
  const leaveRequests = count(db, "SELECT COUNT(*) AS n FROM leave_requests WHERE employee_id = ?", e.id);
  return {
    leaveRequests,
    overtimeRequests: count(
      db,
      "SELECT COUNT(DISTINCT overtime_request_id) AS n FROM overtime_targets WHERE employee_id = ?",
      e.id,
    ),
    grants: count(db, "SELECT COUNT(*) AS n FROM leave_grants WHERE employee_id = ?", e.id),
    openingBalances: count(db, "SELECT COUNT(*) AS n FROM opening_balances WHERE employee_id = ?", e.id),
    balanceKept: leaveRequests > 0,
    blockedReason: e.active ? "활성 직원은 삭제할 수 없습니다. 먼저 비활성화하세요." : null,
  };
}

export function leaveTypeDeleteCheck(db: Db, t: LeaveType): DeleteCheck {
  const overtimeRequests = count(
    db,
    "SELECT COUNT(DISTINCT overtime_request_id) AS n FROM overtime_targets WHERE leave_type_id = ?",
    t.id,
  );
  let blockedReason: string | null = null;
  if (t.active) {
    blockedReason = "활성 휴가 종류는 삭제할 수 없습니다. 먼저 비활성화하세요.";
  } else if (overtimeRequests > 0) {
    // 지우면 그 신청서를 복구·출력할 때 적립할 종류가 없어짐
    blockedReason = `이 종류를 고른 시간외근무 신청서(${overtimeRequests}건)가 있어 삭제할 수 없습니다.`;
  }
  return {
    leaveRequests: count(
      db,
      "SELECT COUNT(DISTINCT request_id) AS n FROM leave_request_items WHERE leave_type_id = ?",
      t.id,
    ),
    overtimeRequests,
    grants: count(db, "SELECT COUNT(*) AS n FROM leave_grants WHERE leave_type_id = ?", t.id),
    openingBalances: count(db, "SELECT COUNT(*) AS n FROM opening_balances WHERE leave_type_id = ?", t.id),
    balanceKept: false,
    blockedReason,
  };
}

const hasRecords = (c: DeleteCheck) => c.leaveRequests + c.overtimeRequests + c.grants + c.openingBalances > 0;

/** 변경 이력용: "휴가원 3건은 남김, 부여 2건·기존 잔여 1건은 휴가현황용으로 숨겨 보관" */
function recordsText(c: DeleteCheck): string {
  const kept = [
    c.leaveRequests ? `휴가원 ${c.leaveRequests}건` : "",
    c.overtimeRequests ? `시간외근무 신청서 ${c.overtimeRequests}건` : "",
  ].filter(Boolean);
  const balance = [
    c.grants ? `부여 ${c.grants}건` : "",
    c.openingBalances ? `기존 잔여 ${c.openingBalances}건` : "",
  ].filter(Boolean);
  const balanceText = balance.length
    ? `${balance.join("·")}${c.balanceKept ? "은 휴가현황용으로 숨겨 보관" : " 삭제"}`
    : "";
  return [kept.length ? `${kept.join("·")}은 남김` : "", balanceText].filter(Boolean).join(", ");
}

/**
 * 삭제 전 공통 확인. 기록이 있으면 이름을 그대로 입력해야 하고, 지우기 직전에 백업을 만든다.
 * @returns 백업을 만들었는지
 */
async function prepare(ctx: AppContext, name: string, check: DeleteCheck, confirmName: string): Promise<boolean> {
  if (check.blockedReason) throw conflict(check.blockedReason);
  if (!hasRecords(check)) return false;
  if (confirmName !== name) throw badRequest(`확인을 위해 이름(${name})을 그대로 입력하세요.`);
  await createBackup(ctx, "pre-delete");
  return true;
}

export async function deleteEmployee(ctx: AppContext, ip: string, id: number, confirmName: string): Promise<void> {
  const { db } = ctx;
  const found = getEmployee(db, id);
  if (!found) throw notFound("직원을 찾을 수 없습니다.");
  const backedUp = await prepare(ctx, found.name, employeeDeleteCheck(db, found), confirmName);

  transaction(db, () => {
    // 백업하는 사이 바뀌었을 수 있으므로 다시 확인
    const e = getEmployee(db, id);
    if (!e) throw conflict("직원을 찾을 수 없습니다.");
    const check = employeeDeleteCheck(db, e);
    if (check.blockedReason) throw conflict(check.blockedReason);
    if (hasRecords(check) && !backedUp) throw conflict("그 사이 기록이 생겼습니다. 다시 시도하세요.");

    if (!check.balanceKept) {
      execute(db, "DELETE FROM leave_grants WHERE employee_id = ?", [id]);
      execute(db, "DELETE FROM opening_balances WHERE employee_id = ?", [id]);
      execute(db, "DELETE FROM leave_type_employees WHERE employee_id = ?", [id]);
    }
    const keepRow = check.leaveRequests + check.overtimeRequests > 0;
    const now = ctx.now();
    if (keepRow) {
      execute(
        db,
        `UPDATE employees SET name = '', emergency_contact = '', active = 0, deleted = 1, updated_at = ?
         WHERE id = ?`,
        [now, id],
      );
    } else {
      execute(db, "DELETE FROM employees WHERE id = ?", [id]);
    }
    const detail = recordsText(check);
    writeAudit(
      db,
      ip,
      {
        entity: "employee",
        entityId: id,
        employeeId: id,
        action: "delete",
        summary: `${e.name} 직원 영구 삭제${detail ? ` (${detail})` : ""}`,
        before: e,
      },
      now,
    );
  });
}

export async function deleteLeaveType(ctx: AppContext, ip: string, id: number, confirmName: string): Promise<void> {
  const { db } = ctx;
  const found = getLeaveType(db, id);
  if (!found) throw notFound("휴가 종류를 찾을 수 없습니다.");
  const backedUp = await prepare(ctx, found.name, leaveTypeDeleteCheck(db, found), confirmName);

  transaction(db, () => {
    const t = getLeaveType(db, id);
    if (!t) throw conflict("휴가 종류를 찾을 수 없습니다.");
    const check = leaveTypeDeleteCheck(db, t);
    if (check.blockedReason) throw conflict(check.blockedReason);
    if (hasRecords(check) && !backedUp) throw conflict("그 사이 기록이 생겼습니다. 다시 시도하세요.");

    execute(db, "DELETE FROM leave_grants WHERE leave_type_id = ?", [id]);
    execute(db, "DELETE FROM opening_balances WHERE leave_type_id = ?", [id]);
    execute(db, "DELETE FROM leave_type_employees WHERE leave_type_id = ?", [id]);
    const now = ctx.now();
    if (check.leaveRequests > 0) {
      // 휴가원 항목에 이름이 보이도록 이름은 남김
      execute(db, "UPDATE leave_types SET active = 0, deleted = 1, updated_at = ? WHERE id = ?", [now, id]);
    } else {
      execute(db, "DELETE FROM leave_types WHERE id = ?", [id]);
    }
    const detail = recordsText(check);
    writeAudit(
      db,
      ip,
      {
        entity: "leave_type",
        entityId: id,
        action: "delete",
        summary: `${t.name} 휴가 종류 영구 삭제${detail ? ` (${detail})` : ""}`,
        before: t,
      },
      now,
    );
  });
}

/**
 * 휴가원 영구 삭제. 취소된 휴가원만 (영구 삭제된 직원의 휴가원은 취소할 수 없으므로 상태와 관계없이).
 * 지우기 직전에 백업. 출력 기록도 함께 지운다.
 */
export async function deleteLeaveRequest(ctx: AppContext, ip: string, id: number): Promise<void> {
  const { db } = ctx;
  const assertDeletable = () => {
    const r = getLeaveRequest(db, id);
    if (!r) throw notFound("휴가원을 찾을 수 없습니다.");
    if (r.status === "active" && !r.employeeDeleted) {
      throw conflict("신청 상태인 휴가원은 영구 삭제할 수 없습니다. 먼저 취소하세요.");
    }
    return r;
  };
  assertDeletable();
  await createBackup(ctx, "pre-delete");

  transaction(db, () => {
    const r = assertDeletable();
    execute(db, "DELETE FROM leave_requests WHERE id = ?", [id]); // 항목은 함께 지워짐 (ON DELETE CASCADE)
    execute(db, "DELETE FROM print_logs WHERE doc_type = 'leave' AND doc_id = ?", [id]);
    cleanupDeletedRows(db);
    const now = ctx.now();
    writeAudit(
      db,
      ip,
      {
        entity: "leave_request",
        entityId: id,
        employeeId: r.employeeId,
        action: "delete",
        summary: describeRequest(r, "영구 삭제"),
        before: r,
      },
      now,
    );
  });
}

/**
 * 휴가원이 지워져 더 이상 가리키는 문서가 없는 "번호만 남은" 직원·휴가 종류 정리.
 * - 휴가원이 없는 삭제된 직원: 휴가현황용으로 숨겨 둔 부여·기존 잔여·적용 대상을 지움. 시간외근무 신청서도 없으면 행도 지움
 * - 휴가원 항목이 없는 삭제된 휴가 종류: 행을 지움 (부여·기존 잔여는 삭제할 때 이미 지움)
 */
function cleanupDeletedRows(db: Db): void {
  const unused = "deleted = 1 AND id NOT IN (SELECT employee_id FROM leave_requests)";
  for (const table of ["leave_grants", "opening_balances", "leave_type_employees"]) {
    execute(db, `DELETE FROM ${table} WHERE employee_id IN (SELECT id FROM employees WHERE ${unused})`);
  }
  execute(db, `DELETE FROM employees WHERE ${unused} AND id NOT IN (SELECT employee_id FROM overtime_targets)`);
  execute(
    db,
    `DELETE FROM leave_types WHERE deleted = 1
       AND id NOT IN (SELECT leave_type_id FROM leave_request_items)
       AND id NOT IN (SELECT leave_type_id FROM leave_grants)
       AND id NOT IN (SELECT leave_type_id FROM opening_balances)
       AND id NOT IN (SELECT leave_type_id FROM overtime_targets WHERE leave_type_id IS NOT NULL)`,
  );
}
