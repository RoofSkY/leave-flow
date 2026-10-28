// 화면과 서버가 주고받는 데이터 형태 (API 응답). 입력 형태는 schemas.ts 참고.
import type { ApprovalRole } from "./leave.ts";

/** 연도별 / 누적 / 정한 날짜에 소멸 / 부여 후 기간이 지나면 소멸 / 소진 (누적처럼 쌓이고, 남은 양이 없으면 휴가원에서 숨길 수 있음) */
export type BalanceMode = "yearly" | "cumulative" | "expire_date" | "grant_period" | "used_up";
export type DocStatus = "active" | "cancelled";

export interface Employee {
  id: number;
  name: string;
  department: string;
  /** "#RRGGBB" */
  color: string;
  /** 근무 요일 (0=일 … 6=토), 오름차순 */
  workDays: number[];
  /** "HH:MM" */
  workStart: string;
  workEnd: string;
  emergencyContact: string;
  /** 휴가원 결재칸 (APPROVAL_ROLES 순서) */
  approvalRoles: ApprovalRole[];
  /** 구분 이름 (관리 > 설정의 구분 목록, 빈 값 = 구분 없음) */
  category: string;
  /** 구분이 "사회복무요원 특별휴가 대상"인지 (구분 설정에서 계산, 저장하지 않음) */
  isSocialServiceAgent: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 휴가 종류 적용 대상 (leaveTypeAppliesTo): 소속·구분 조건에 맞거나(고른 칸끼리 모두 맞아야, 칸 안에서는 하나만),
 * 따로 고른 직원이면 대상. 소속·구분은 조건이라 새 직원이나 소속·구분이 바뀐 직원에게도 바로 적용됨.
 */
export interface LeaveTypeTarget {
  /** 소속 이름 (소속 목록 순서) */
  departments: string[];
  /** 구분 이름 (구분 목록 순서) */
  categories: string[];
  /** 따로 고른 직원 ID (오름차순) */
  employeeIds: number[];
}

export interface LeaveType {
  id: number;
  /** 관리 이름 (활성 종류끼리 겹치면 안 됨, 예: "연차(강사)") */
  name: string;
  /**
   * 표시 이름: 휴가원 작성·양식·목록·달력에 보이는 이름 (예: "연차"). 빈 값 = 관리 이름 그대로.
   * 여러 종류가 같은 표시 이름을 쓸 수 있지만 한 직원에게 둘 이상 적용되면 안 됨
   */
  displayName: string;
  /** 잔여에서 차감하는지 (예: 공가 = false) */
  deducts: boolean;
  balanceMode: BalanceMode;
  /** 정한 날짜 소멸: 소멸일 (월·일). 다른 방식은 null */
  expireMonth: number | null;
  expireDay: number | null;
  /** 부여 후 기간 소멸: 부여일부터 쓸 수 있는 개월 수. 다른 방식은 null */
  validMonths: number | null;
  /** 소진: 잔여가 0 이하인 직원의 휴가원 작성 목록·휴가원 양식에서 숨김. 다른 방식은 false */
  hideWhenEmpty: boolean;
  /** 적용 대상. null = 전체 직원 */
  target: LeaveTypeTarget | null;
  sortOrder: number;
  active: boolean;
  /** 부여·사용 기록이 있으면 true → 잔여 방식 변경 불가 */
  inUse: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GrantSource = "manual" | "overtime";

export interface Grant {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  grantDate: string;
  /** 부여량(분). 직접 입력분은 일·시간을 그 직원의 1일 기준으로 바꾼 값 */
  minutes: number;
  note: string;
  source: GrantSource;
  /** source = overtime 일 때 연결된 시간외근무 신청서 (수정·삭제는 신청서에서만) */
  overtimeRequestId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpeningBalance {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  year: number;
  baseDate: string;
  /** 올해 총 부여량(분) */
  totalGrantedMinutes: number;
  /** 입력 당시 잔여량(분) */
  remainingMinutes: number;
  /** 기존 사용량(분) = 총 부여(분) − 잔여(분) */
  usedMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  /** 직원 추가 시 근무 시작·종료 기본값 "HH:MM" */
  defaultWorkStart: string;
  defaultWorkEnd: string;
}

/** 소속 (관리 > 설정에서 추가·수정·삭제) */
export interface Department {
  id: number;
  name: string;
  sortOrder: number;
  /** 이 소속인 직원 수 (비활성 포함) */
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 직원 구분 (관리 > 설정에서 추가·수정·삭제) */
export interface Category {
  id: number;
  name: string;
  /** 이 구분인 직원이 사회복무요원 특별휴가·특별휴가(시상) 신청서의 대상 */
  socialServiceAgent: boolean;
  sortOrder: number;
  /** 이 구분인 직원 수 (비활성 포함) */
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BalanceRow {
  leaveTypeId: number;
  /** 관리 이름 */
  name: string;
  /** 표시 이름 (빈 값 = 관리 이름). leaveTypeLabel 로 보이는 이름을 구함 */
  displayName: string;
  deducts: boolean;
  balanceMode: BalanceMode;
  sortOrder: number;
  /** 기준 연도 (연도별: 그 해, 누적: 그 해까지 전체, 정한 날짜 소멸: 그 해 시작하는 기간) */
  year: number;
  /** 계산 기간 (연도별·정한 날짜 소멸). 누적은 시작 null, 부여 후 기간 소멸은 둘 다 null */
  periodStart: string | null;
  periodEnd: string | null;
  /** 부여 후 기간 소멸: 이 날 쓸 수 있는 양으로 계산. 다른 방식은 null */
  asOf: string | null;
  grantedMinutes: number;
  usedMinutes: number;
  /** 차감하지 않는 종류는 null */
  remainingMinutes: number | null;
}

export interface LeaveRequestItem {
  id: number;
  leaveTypeId: number;
  /** 관리 이름 */
  leaveTypeName: string;
  /** 보이는 이름 (표시 이름, 없으면 관리 이름) */
  leaveTypeDisplayName: string;
  /** 휴가 종류가 영구 삭제됨 (이름만 남음, 잔여 계산에서 빠짐) */
  leaveTypeDeleted: boolean;
  startAt: string;
  endAt: string;
  minutes: number;
  minutesByYear: Record<string, number>;
}

export interface LeaveRequest {
  id: number;
  employeeId: number;
  /** 신청 시점 값 */
  employeeName: string;
  department: string;
  /** 직원 색상 (현재 값) */
  color: string;
  /** 직원이 영구 삭제됨 → 보기·출력만 (수정·취소·복구 불가) */
  employeeDeleted: boolean;
  appliedOn: string;
  /** 신청(수정) 시점 근무 일정 */
  workDays: number[];
  workStart: string;
  workEnd: string;
  reason: string;
  emergencyContact: string;
  handoverNote: string;
  status: DocStatus;
  cancelledAt: string | null;
  lastPrintedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: LeaveRequestItem[];
  /** 전체 항목 합계(분) */
  totalMinutes: number;
}

export type WarningCode =
  | "over_balance"
  | "overlap_existing"
  | "overlap_items"
  | "zero_minutes";

export interface Warning {
  code: WarningCode;
  message: string;
}

export interface LeavePreviewItem {
  /** 오류가 있으면 minutes = 0, error에 메시지 */
  minutes: number;
  minutesByYear: Record<string, number>;
  error: string | null;
}

export interface LeavePreview {
  items: LeavePreviewItem[];
  /** 종류별 이번 사용량 */
  totalsByType: { leaveTypeId: number; minutes: number }[];
  /** 이번 신청을 반영하기 전 잔여 (수정 중이면 그 휴가원 제외) */
  balancesBefore: BalanceRow[];
  /** 이번 신청을 반영한 뒤 잔여 */
  balancesAfter: BalanceRow[];
  warnings: Warning[];
}

export interface LeaveSaveResult {
  request: LeaveRequest;
  warnings: Warning[];
}

export interface CalendarEvent {
  /** 휴가원 항목 id */
  itemId: number;
  requestId: number;
  employeeId: number;
  employeeName: string;
  /** 직원의 지금 소속·구분 (달력 필터용) */
  department: string;
  category: string;
  color: string;
  leaveTypeName: string;
  startAt: string;
  endAt: string;
  minutes: number;
  status: DocStatus;
  /** 휴가원에 저장된(신청·수정 시점) 근무 일정 — 주 보기에서 날짜별 블록을 나눌 때 사용 */
  workDays: number[];
  workStart: string;
  workEnd: string;
}

export interface AbsenceRow {
  requestId: number;
  itemId: number;
  employeeId: number;
  employeeName: string;
  color: string;
  leaveTypeName: string;
  startAt: string;
  endAt: string;
  minutes: number;
  /** 표시용 1일(분) = 휴가원에 저장된 근무시간 기준 */
  dayMinutes: number;
}

export interface Absences {
  date: string;
  weekStart: string;
  weekEnd: string;
  today: AbsenceRow[];
  week: AbsenceRow[];
}

/** 휴가원 출력 데이터 */
export interface LeavePrintData {
  request: LeaveRequest;
  /** 양식 제출일자 (= 출력하는 날짜) */
  submitDate: string;
  /** 휴가현황 기준 연도 */
  year: number;
  /** 결재칸 (출력할 때의 직원 설정) */
  approvalRoles: ApprovalRole[];
  /** 휴가현황 표: 체크박스와 같은 종류(차감 여부 무관), 표시 순서대로. name = 보이는 이름 (양식 안에서 겹치면 관리 이름) */
  balanceTable: {
    leaveTypeId: number;
    name: string;
    /** 차감 안 하는 종류는 null */
    grantedMinutes: number | null;
    currentMinutes: number;
    /** 누적사용 (금회 포함) */
    usedMinutes: number;
    /** 차감 안 하는 종류는 null */
    remainingMinutes: number | null;
  }[];
  /** 상세내용 체크박스: 그 직원에게 적용되거나 기록이 있는 활성 종류(표시 순서) + 이번에 사용한 종류 (비활성·영구 삭제 포함). name 은 휴가현황 표와 같은 규칙 */
  checkboxes: { leaveTypeId: number; name: string; checked: boolean }[];
}

/** 일반 / 사회복무요원 특별휴가 / 사회복무요원 특별휴가(시상) */
export type OvertimeKind = "general" | "soldier" | "award";
export type OvertimeCategory = "official_event" | "special_work" | "special_leave" | "award";

export interface OvertimeTarget {
  employeeId: number;
  /** 작성 시점 값 */
  employeeName: string;
  /** 직원이 영구 삭제됨 (적립도 함께 삭제됨) */
  employeeDeleted: boolean;
  /** 적립량(분). 일반 = 금일발생, 요원·시상 = 일수 × 그 요원의 하루 근무시간 */
  minutes: number;
  /** 요원·시상: 발생 일수. 일반: null */
  days: number | null;
  /** 요원: 발생 월 (1~12). 일반·시상: null */
  month: number | null;
  /** 적립 휴가 종류 (신청서에서 대상자마다 고름) */
  leaveTypeId: number;
}

export interface OvertimeRequest {
  id: number;
  kind: OvertimeKind;
  /** 일반: 근무 시작·종료 일시 */
  workStartAt: string | null;
  workEndAt: string | null;
  /** 일반: 금일발생(분, 대상 전원 동일) */
  minutes: number | null;
  /** 일반: 누적 (선택 입력, 출력하지 않음) */
  cumulativeNote: string;
  category: OvertimeCategory;
  workDetails: string;
  /** 요원·시상: 지급일자 */
  paidOn: string | null;
  /** 일반: 제출일 = 처음 출력한 날 (null = 미제출·미적립) */
  submittedOn: string | null;
  status: DocStatus;
  cancelledAt: string | null;
  lastPrintedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targets: OvertimeTarget[];
  /** 현재 부여 내역이 생성되어 있는지 */
  accrued: boolean;
}

export interface OvertimePrintData {
  request: OvertimeRequest;
  /** 양식 제출일자: 일반 = 저장된 제출일, 요원·시상 = 출력하는 날짜 */
  submitDate: string;
  /** 머리글·발생현황 연도 */
  year: number;
}

export type HolidayKind = "public" | "center";
export type HolidaySource = "auto" | "manual";

export interface Holiday {
  id: number;
  date: string;
  name: string;
  kind: HolidayKind;
  source: HolidaySource;
  active: boolean;
}

export interface RecalcChange {
  requestId: number;
  itemId: number;
  employeeName: string;
  /** 표시용 1일(분) = 휴가원에 저장된 근무시간 기준 */
  dayMinutes: number;
  leaveTypeName: string;
  startAt: string;
  endAt: string;
  beforeMinutes: number;
  afterMinutes: number;
}

export interface HolidayChangeResult {
  holiday: Holiday | null;
  recalculated: RecalcChange[];
}

export type AuditEntity =
  | "leave_request"
  | "overtime_request"
  | "employee"
  | "leave_type"
  | "leave_grant"
  | "opening_balance"
  | "holiday"
  | "department"
  | "category"
  | "settings"
  | "system";

export type AuditAction =
  | "create"
  | "update"
  | "cancel"
  | "restore"
  | "activate"
  | "deactivate"
  | "delete"
  | "print"
  | "accrue"
  | "recalculate"
  | "backup"
  | "restore_backup"
  | "update_app";

export interface AuditLog {
  id: number;
  at: string;
  ip: string;
  entity: AuditEntity;
  entityId: number | null;
  /** 관련 직원 (필터용, 없으면 null) */
  employeeId: number | null;
  action: AuditAction;
  summary: string;
  before: unknown;
  after: unknown;
}

export interface AuditLogPage {
  rows: AuditLog[];
  total: number;
}

export interface UsageReport {
  year: number;
  leaveTypes: LeaveType[];
  rows: {
    employee: Employee;
    balances: BalanceRow[];
  }[];
}

export interface BackupFile {
  name: string;
  location: "local" | "nas";
  size: number;
  modifiedAt: string;
}

export interface SystemInfo {
  version: string;
  dataDir: string;
  port: number;
  updateRepo: string | null;
  autoUpdate: boolean;
  lastUpdateCheckAt: string | null;
  lastUpdatedAt: string | null;
  latestVersion: string | null;
  lastBackupAt: string | null;
  lastBackupError: string | null;
  nasBackupDir: string | null;
  backupDir: string;
  backupTime: string;
  backupKeepDays: number;
  /** 서버 프로세스마다 다른 값. 재시작을 기다릴 때 바뀌었는지 확인 */
  bootId: string;
  /** 새 버전이 정상 기동하지 않아 되돌린 기록 */
  updateFailure: { version: string; at: string; message: string } | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string;
}

/** 영구 삭제 전 확인: 함께 지워지거나 남는 기록 수 */
export interface DeleteCheck {
  /** 휴가원 (직원: 그 직원의 휴가원, 휴가 종류: 그 종류 항목이 있는 휴가원). 지우지 않고 남김 */
  leaveRequests: number;
  /** 시간외근무 신청서 (직원: 대상으로 들어간 신청서). 지우지 않고 남김 */
  overtimeRequests: number;
  /** 부여 내역 (balanceKept 이면 숨겨 보관, 아니면 함께 지움) */
  grants: number;
  /** 기존 잔여 (balanceKept 이면 숨겨 보관, 아니면 함께 지움) */
  openingBalances: number;
  /** 남는 휴가원의 휴가현황을 그대로 보이도록 부여 내역·기존 잔여를 지우지 않고 숨겨 보관 (휴가원이 있는 직원) */
  balanceKept: boolean;
  /** 삭제할 수 없는 이유 (null = 삭제 가능) */
  blockedReason: string | null;
}
