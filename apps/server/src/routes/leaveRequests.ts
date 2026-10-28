import type { SQLInputValue } from "node:sqlite";
import {
  addDays,
  editBaseInput,
  formatPeriod,
  leavePreviewInput,
  leaveRequestInput,
  type LeaveRequest,
  type LeaveSaveResult,
  type Warning,
} from "@leave-flow/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { execute, queryAll, transaction } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { clientIp, dateQuery, parseId, parseInput, queryInt, queryStr } from "../lib/http.ts";
import { writeAudit } from "../services/audit.ts";
import {
  assertItemsValid,
  buildPreview,
  buildPrintData,
  collectWarnings,
  describeRequest,
  evaluateItems,
  insertItems,
  scheduleOf,
  warningItemsOf,
} from "../services/leaveRequests.ts";
import { byDateJson, computeItemUsage } from "../services/leaveUsage.ts";
import { recordPrint } from "../services/printLog.ts";
import { deleteLeaveRequest } from "../services/purge.ts";
import { getEmployee, getLeaveRequest, getLeaveRequests } from "../services/queries.ts";

export function registerLeaveRequestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const findRequest = (params: unknown): LeaveRequest => {
    const r = getLeaveRequest(db, parseId(params));
    if (!r) throw notFound("휴가원을 찾을 수 없습니다.");
    return r;
  };
  /** 영구 삭제된 직원의 휴가원은 보기·출력만 */
  const assertEmployeeKept = (r: LeaveRequest) => {
    if (r.employeeDeleted) {
      throw conflict("영구 삭제된 직원의 휴가원은 수정·취소·복구할 수 없습니다. (보기·출력만 가능)");
    }
  };
  const findEmployee = (id: number) => {
    const e = getEmployee(db, id);
    if (!e) throw notFound("직원을 찾을 수 없습니다.");
    return e;
  };

  // 목록: 첫 항목 시작 내림차순. from/to 는 항목 기간이 겹치는 휴가원
  app.get("/leave-requests", async (req) => {
    const employeeId = queryInt(req.query, "employeeId");
    const status = queryStr(req.query, "status") ?? "active";
    if (status !== "active" && status !== "cancelled" && status !== "all") {
      throw badRequest("status 값이 올바르지 않습니다.");
    }
    const from = dateQuery(req.query, "from");
    const to = dateQuery(req.query, "to");
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (employeeId !== undefined) {
      where.push("r.employee_id = ?");
      params.push(employeeId);
    }
    if (status !== "all") {
      where.push("r.status = ?");
      params.push(status);
    }
    if (from || to) {
      where.push(
        `EXISTS (SELECT 1 FROM leave_request_items i WHERE i.request_id = r.id AND i.end_at > ? AND i.start_at < ?)`,
      );
      params.push(from ?? "", to ? addDays(to, 1) : "9999");
    }
    const ids = queryAll<{ id: number }>(
      db,
      `SELECT r.id FROM leave_requests r ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY (SELECT MIN(start_at) FROM leave_request_items WHERE request_id = r.id) DESC, r.id DESC`,
      params,
    ).map((r) => Number(r.id));
    return getLeaveRequests(db, ids);
  });

  app.get("/leave-requests/:id", async (req) => findRequest(req.params));

  app.post("/leave-requests/preview", async (req) => {
    const input = parseInput(leavePreviewInput, req.body);
    const employee = findEmployee(input.employeeId);
    const excludeId = input.excludeRequestId ?? null;
    let allowInactive = new Set<number>();
    if (excludeId !== null) {
      const existing = getLeaveRequest(db, excludeId);
      if (!existing) throw notFound("휴가원을 찾을 수 없습니다.");
      allowInactive = new Set(existing.items.map((i) => i.leaveTypeId));
    }
    return buildPreview(db, employee.id, scheduleOf(employee), input.items, excludeId, allowInactive, ctx.today());
  });

  app.post("/leave-requests", async (req, reply) => {
    const input = parseInput(leaveRequestInput, req.body);
    const employee = findEmployee(input.employeeId);
    if (!employee.active) throw badRequest("비활성 직원은 휴가원을 작성할 수 없습니다.");
    const schedule = scheduleOf(employee);
    const evaluated = evaluateItems(db, employee.id, input.items, schedule);
    assertItemsValid(evaluated);

    const result = transaction(db, (): LeaveSaveResult => {
      const now = ctx.now();
      const id = execute(
        db,
        `INSERT INTO leave_requests (employee_id, employee_name, department, applied_on, work_days, work_start, work_end,
           reason, emergency_contact, handover_note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          employee.id,
          employee.name,
          employee.department,
          ctx.today(),
          JSON.stringify(schedule.workDays),
          schedule.workStart,
          schedule.workEnd,
          input.reason,
          input.emergencyContact,
          input.handoverNote,
          now,
          now,
        ],
      ).lastInsertRowid;
      insertItems(db, id, evaluated);
      const request = getLeaveRequest(db, id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_request",
          entityId: id,
          employeeId: employee.id,
          action: "create",
          summary: describeRequest(request, "작성"),
          after: request,
        },
        now,
      );
      return { request, warnings: collectWarnings(db, employee.id, warningItemsOf(evaluated), id) };
    });
    return reply.status(201).send(result);
  });

  app.put("/leave-requests/:id", async (req) => {
    const before = findRequest(req.params);
    const input = parseInput(leaveRequestInput, req.body);
    const { baseUpdatedAt } = parseInput(editBaseInput, req.body);
    assertEmployeeKept(before);
    if (before.status === "cancelled") throw conflict("취소된 휴가원은 수정할 수 없습니다. 먼저 복구하세요.");
    if (before.items.some((i) => i.leaveTypeDeleted)) {
      throw conflict("영구 삭제된 휴가 종류가 들어 있는 휴가원은 수정할 수 없습니다. (취소·출력은 가능)");
    }
    // 수정 창을 연 뒤 다른 사람이 먼저 고쳤으면 덮어쓰지 않음
    if (baseUpdatedAt !== before.updatedAt) {
      throw conflict("다른 사람이 이 휴가원을 먼저 수정했습니다. 창을 닫고 다시 열어 바뀐 내용을 확인한 뒤 수정하세요.");
    }
    if (input.employeeId !== before.employeeId) {
      throw badRequest("휴가원의 직원은 바꿀 수 없습니다. 새 휴가원을 작성하세요.");
    }
    const employee = findEmployee(before.employeeId);
    const schedule = scheduleOf(employee);
    const evaluated = evaluateItems(db, employee.id, input.items, schedule, new Set(before.items.map((i) => i.leaveTypeId)));
    assertItemsValid(evaluated);

    return transaction(db, (): LeaveSaveResult => {
      const now = ctx.now();
      // 성명·소속·신청일자는 유지, 근무 일정은 수정 시점 값으로 다시 저장
      execute(
        db,
        `UPDATE leave_requests SET work_days = ?, work_start = ?, work_end = ?, reason = ?, emergency_contact = ?,
           handover_note = ?, updated_at = ? WHERE id = ?`,
        [
          JSON.stringify(schedule.workDays),
          schedule.workStart,
          schedule.workEnd,
          input.reason,
          input.emergencyContact,
          input.handoverNote,
          now,
          before.id,
        ],
      );
      execute(db, "DELETE FROM leave_request_items WHERE request_id = ?", [before.id]);
      insertItems(db, before.id, evaluated);
      const request = getLeaveRequest(db, before.id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_request",
          entityId: before.id,
          employeeId: before.employeeId,
          action: "update",
          summary: describeRequest(request, "수정"),
          before,
          after: request,
        },
        now,
      );
      return { request, warnings: collectWarnings(db, before.employeeId, warningItemsOf(evaluated), before.id) };
    });
  });

  app.post("/leave-requests/:id/cancel", async (req) => {
    const before = findRequest(req.params);
    assertEmployeeKept(before);
    if (before.status === "cancelled") throw conflict("이미 취소된 휴가원입니다.");
    return transaction(db, (): LeaveSaveResult => {
      const now = ctx.now();
      execute(db, "UPDATE leave_requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [
        now,
        now,
        before.id,
      ]);
      const request = getLeaveRequest(db, before.id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_request",
          entityId: before.id,
          employeeId: before.employeeId,
          action: "cancel",
          summary: describeRequest(request, "취소"),
          before,
          after: request,
        },
        now,
      );
      return { request, warnings: [] };
    });
  });

  // 복구: 신청 상태로 돌리고 저장된 근무 일정 + 현재 공휴일·휴무일로 사용 시간 재계산
  app.post("/leave-requests/:id/restore", async (req) => {
    const before = findRequest(req.params);
    assertEmployeeKept(before);
    if (before.status === "active") throw conflict("취소되지 않은 휴가원입니다.");
    const schedule = scheduleOf(before);
    return transaction(db, (): LeaveSaveResult => {
      const now = ctx.now();
      const zeroWarnings: Warning[] = [];
      const items = before.items.map((item, idx) => {
        const usage = computeItemUsage(db, item.startAt, item.endAt, schedule);
        execute(db, "UPDATE leave_request_items SET minutes = ?, minutes_by_year = ?, minutes_by_date = ? WHERE id = ?", [
          usage.minutes,
          JSON.stringify(usage.byYear),
          byDateJson(usage.byDate),
          item.id,
        ]);
        if (usage.minutes === 0) {
          zeroWarnings.push({
            code: "zero_minutes",
            message: `${idx + 1}번째 항목(${item.leaveTypeName} ${formatPeriod(item.startAt, item.endAt)})은 사용 시간이 0입니다. 공휴일·휴무일을 확인하세요.`,
          });
        }
        return {
          no: idx + 1,
          leaveTypeId: item.leaveTypeId,
          startAt: item.startAt,
          endAt: item.endAt,
          minutesByYear: usage.byYear,
          byDate: usage.byDate,
        };
      });
      execute(db, "UPDATE leave_requests SET status = 'active', cancelled_at = NULL, updated_at = ? WHERE id = ?", [
        now,
        before.id,
      ]);
      const request = getLeaveRequest(db, before.id)!;
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_request",
          entityId: before.id,
          employeeId: before.employeeId,
          action: "restore",
          summary: describeRequest(request, "복구"),
          before,
          after: request,
        },
        now,
      );
      const warnings = collectWarnings(
        db,
        before.employeeId,
        items.filter((i) => Object.keys(i.minutesByYear).length > 0),
        before.id,
      );
      return { request, warnings: [...warnings, ...zeroWarnings] };
    });
  });

  // 영구 삭제: 취소된 휴가원 (영구 삭제된 직원의 휴가원은 상태와 관계없이). 지우기 직전 백업
  app.post("/leave-requests/:id/delete", async (req, reply) => {
    await deleteLeaveRequest(ctx, clientIp(req), parseId(req.params));
    return reply.status(204).send();
  });

  const printable = (params: unknown): LeaveRequest => {
    const r = findRequest(params);
    if (r.status === "cancelled") throw conflict("취소된 휴가원은 출력할 수 없습니다. 먼저 복구하세요.");
    return r;
  };

  // 출력 미리보기 (기록 안 함)
  app.get("/leave-requests/:id/print-data", async (req) => buildPrintData(db, printable(req.params), ctx.today()));

  // 출력: 출력 기록 + 변경 이력
  app.post("/leave-requests/:id/print", async (req) => {
    const r = printable(req.params);
    return transaction(db, () => {
      const now = ctx.now();
      recordPrint(db, "leave", r.id, now);
      writeAudit(
        db,
        clientIp(req),
        {
          entity: "leave_request",
          entityId: r.id,
          employeeId: r.employeeId,
          action: "print",
          summary: describeRequest(r, "출력"),
        },
        now,
      );
      return buildPrintData(db, getLeaveRequest(db, r.id)!, ctx.today());
    });
  });
}
