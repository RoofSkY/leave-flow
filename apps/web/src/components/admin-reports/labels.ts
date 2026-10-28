import type { AuditAction, AuditEntity, HolidayKind } from "@leave-flow/shared";

export const ENTITY_LABELS: Record<AuditEntity, string> = {
  leave_request: "휴가원",
  overtime_request: "시간외근무 신청서",
  employee: "직원",
  leave_type: "휴가 종류",
  leave_grant: "부여 내역",
  opening_balance: "기존 잔여량",
  holiday: "공휴일·휴무일",
  department: "소속",
  category: "구분",
  settings: "설정",
  system: "시스템",
};

export const ACTION_LABELS: Record<AuditAction, string> = {
  create: "추가",
  update: "수정",
  cancel: "취소",
  restore: "복구",
  activate: "활성화",
  deactivate: "비활성화",
  delete: "삭제",
  print: "출력",
  accrue: "적립",
  recalculate: "재계산",
  backup: "백업",
  restore_backup: "백업 복구",
  update_app: "업데이트",
};

export const HOLIDAY_KIND_LABELS: Record<HolidayKind, string> = {
  public: "공휴일",
  center: "센터 휴무일",
};
