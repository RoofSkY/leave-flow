import type { AuditAction, AuditEntity } from "@leave-flow/shared";
import { execute, type Db } from "../db/index.ts";

interface AuditInput {
  entity: AuditEntity;
  entityId?: number | null;
  /** 관련 직원 (변경 이력을 직원으로 필터할 때 사용) */
  employeeId?: number | null;
  action: AuditAction;
  /** 사람이 읽는 한 줄 설명. 예: "홍길동 휴가원 취소 (2026.10.01. 10:00 ~ 19:00)" */
  summary: string;
  before?: unknown;
  after?: unknown;
}

/** 변경 이력 기록. 데이터 변경과 같은 트랜잭션 안에서 호출할 것. */
export function writeAudit(db: Db, ip: string, input: AuditInput, at: string): void {
  execute(
    db,
    `INSERT INTO audit_logs (at, ip, entity, entity_id, employee_id, action, summary, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      at,
      ip,
      input.entity,
      input.entityId ?? null,
      input.employeeId ?? null,
      input.action,
      input.summary,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
    ],
  );
}
