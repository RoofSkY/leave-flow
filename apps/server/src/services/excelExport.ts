// 전체 데이터를 사람이 읽을 수 있는 엑셀(.xlsx)로. 시트 이름·열 이름은 한국어.
import ExcelJS from "exceljs";
import {
  WEEKDAY_LABELS,
  dayMinutesOf,
  formatDotDate,
  formatHoursMinutes,
  formatLeaveMinutes,
  isCumulativeMode,
  weekdayOf,
  type AuditAction,
  type AuditEntity,
  type BalanceRow,
  type TableExportInput,
} from "@leave-flow/shared";
import { parseJson, queryAll, toBool, toNum, type Db, type Row } from "../db/index.ts";
import { getEmployeeBalances } from "./balances.ts";
import { listEmployees } from "./queries.ts";

type Cell = string | number | null;

interface Column {
  header: string;
  width: number;
}

const ENTITY_LABELS: Record<AuditEntity, string> = {
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

const ACTION_LABELS: Record<AuditAction, string> = {
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

const CATEGORY_LABELS: Record<string, string> = {
  official_event: "공식행사",
  special_work: "특별근무",
  special_leave: "특별휴가",
  award: "시상",
};

const OVERTIME_KIND_LABELS: Record<string, string> = {
  general: "일반",
  soldier: "사회복무요원 특별휴가",
  award: "사회복무요원 특별휴가(시상)",
};

/** 엑셀 셀 최대 글자 수 (32,767) 보다 짧게 */
const MAX_CELL = 32_000;

const yesNo = (v: unknown) => (toBool(v) ? "예" : "아니오");
const statusLabel = (v: unknown) => (v === "cancelled" ? "취소" : "신청");
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** 1일 = 그 직원의 하루 근무시간 */
const fmt = (minutes: number, dayMinutes: number) => formatLeaveMinutes(minutes, dayMinutes);
const dayOfRow = (r: Row) => dayMinutesOf({ workStart: String(r.work_start), workEnd: String(r.work_end) });
const workDaysLabel = (v: unknown) =>
  parseJson<number[]>(v, [])
    .map((d) => WEEKDAY_LABELS[d] ?? "")
    .join("·");
const jsonCell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
};

function addSheet(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: Cell[][]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  for (const r of rows) ws.addRow(r);
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F0" } };
  header.alignment = { vertical: "middle" };
  if (rows.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

const cols = (...defs: [string, number][]): Column[] => defs.map(([header, width]) => ({ header, width }));

function employeesSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(db, "SELECT * FROM employees WHERE deleted = 0 ORDER BY active DESC, name, id").map((r): Cell[] => [
    toNum(r.id),
    String(r.name),
    String(r.department),
    String(r.color),
    workDaysLabel(r.work_days),
    String(r.work_start),
    String(r.work_end),
    String(r.emergency_contact),
    parseJson<string[]>(r.approval_roles, []).join("·"),
    String(r.category),
    yesNo(r.active),
    String(r.created_at),
    String(r.updated_at),
  ]);
  addSheet(
    wb,
    "직원",
    cols(
      ["ID", 6],
      ["성명", 12],
      ["소속", 16],
      ["색상", 10],
      ["근무 요일", 16],
      ["근무 시작", 10],
      ["근무 종료", 10],
      ["비상연락처", 16],
      ["결재칸", 18],
      ["구분", 14],
      ["활성", 8],
      ["생성일시", 20],
      ["수정일시", 20],
    ),
    rows,
  );
}

/** 잔여 방식: "연도별", "누적", "매년 2월 28일 소멸", "부여 후 12개월 소멸", "소진" */
function balanceModeLabel(r: Row): string {
  if (r.balance_mode === "cumulative") return "누적";
  if (r.balance_mode === "used_up") return toBool(r.hide_when_empty) ? "소진 (남은 양이 없으면 휴가원에서 숨김)" : "소진";
  if (r.balance_mode === "expire_date") return `매년 ${toNum(r.expire_month)}월 ${toNum(r.expire_day)}일 소멸`;
  if (r.balance_mode === "grant_period") return `부여 후 ${toNum(r.valid_months)}개월 소멸`;
  return "연도별";
}

function leaveTypesSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(db, "SELECT * FROM leave_types WHERE deleted = 0 ORDER BY sort_order, id").map((r): Cell[] => [
    toNum(r.id),
    String(r.name),
    String(r.display_name),
    yesNo(r.deducts),
    balanceModeLabel(r),
    toNum(r.sort_order),
    yesNo(r.active),
    String(r.created_at),
    String(r.updated_at),
  ]);
  addSheet(
    wb,
    "휴가 종류",
    cols(
      ["ID", 6],
      ["이름", 16],
      ["표시 이름", 12],
      ["잔여 차감", 10],
      ["잔여 방식", 20],
      ["표시 순서", 10],
      ["활성", 8],
      ["생성일시", 20],
      ["수정일시", 20],
    ),
    rows,
  );
}

function grantsSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(
    db,
    `SELECT g.*, e.name AS employee_name, e.work_start, e.work_end, t.name AS type_name
       FROM leave_grants g JOIN employees e ON e.id = g.employee_id JOIN leave_types t ON t.id = g.leave_type_id
      WHERE e.deleted = 0
      ORDER BY g.grant_date DESC, g.id DESC`,
  ).map((r): Cell[] => [
    toNum(r.id),
    toNum(r.employee_id),
    String(r.employee_name),
    String(r.type_name),
    String(r.grant_date),
    toNum(r.minutes),
    fmt(toNum(r.minutes), dayOfRow(r)),
    String(r.note),
    r.source === "overtime" ? "시간외근무" : "직접 입력",
    r.overtime_request_id === null ? null : toNum(r.overtime_request_id),
    String(r.created_at),
    String(r.updated_at),
  ]);
  addSheet(
    wb,
    "부여 내역",
    cols(
      ["ID", 6],
      ["직원 ID", 8],
      ["성명", 12],
      ["휴가 종류", 14],
      ["부여일자", 12],
      ["부여량(분)", 11],
      ["부여량", 12],
      ["비고", 30],
      ["출처", 12],
      ["시간외근무 신청서 ID", 18],
      ["생성일시", 20],
      ["수정일시", 20],
    ),
    rows,
  );
}

function openingBalancesSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(
    db,
    `SELECT o.*, e.name AS employee_name, e.work_start, e.work_end, t.name AS type_name
       FROM opening_balances o JOIN employees e ON e.id = o.employee_id JOIN leave_types t ON t.id = o.leave_type_id
      WHERE e.deleted = 0
      ORDER BY o.year DESC, e.name, t.sort_order, t.id`,
  ).map((r): Cell[] => {
    const day = dayOfRow(r);
    return [
      toNum(r.id),
      toNum(r.employee_id),
      String(r.employee_name),
      String(r.type_name),
      toNum(r.year),
      String(r.base_date),
      fmt(toNum(r.total_granted_minutes), day),
      toNum(r.remaining_minutes),
      fmt(toNum(r.remaining_minutes), day),
      toNum(r.used_minutes),
      fmt(toNum(r.used_minutes), day),
      String(r.created_at),
      String(r.updated_at),
    ];
  });
  addSheet(
    wb,
    "기존 잔여량",
    cols(
      ["ID", 6],
      ["직원 ID", 8],
      ["성명", 12],
      ["휴가 종류", 14],
      ["연도", 8],
      ["기준일자", 12],
      ["총 부여량", 10],
      ["입력 당시 잔여(분)", 16],
      ["입력 당시 잔여", 14],
      ["기존 사용량(분)", 15],
      ["기존 사용량", 14],
      ["생성일시", 20],
      ["수정일시", 20],
    ),
    rows,
  );
}

function leaveRequestsSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(
    db,
    `SELECT r.*, (SELECT COALESCE(SUM(i.minutes), 0) FROM leave_request_items i WHERE i.request_id = r.id) AS total_minutes
       FROM leave_requests r ORDER BY r.id DESC`,
  ).map((r): Cell[] => [
    toNum(r.id),
    toNum(r.employee_id),
    String(r.employee_name),
    String(r.department),
    String(r.applied_on),
    workDaysLabel(r.work_days),
    `${String(r.work_start)}~${String(r.work_end)}`,
    String(r.reason),
    String(r.emergency_contact),
    String(r.handover_note),
    statusLabel(r.status),
    str(r.cancelled_at),
    str(r.last_printed_at),
    toNum(r.total_minutes),
    String(r.created_at),
    String(r.updated_at),
  ]);
  addSheet(
    wb,
    "휴가원",
    cols(
      ["ID", 6],
      ["직원 ID", 8],
      ["성명", 12],
      ["소속", 16],
      ["신청일자", 12],
      ["근무 요일", 16],
      ["근무시간", 13],
      ["휴가사유", 30],
      ["비상연락처", 16],
      ["업무인계 및 기타사항", 36],
      ["상태", 8],
      ["취소일시", 20],
      ["최근 출력일시", 20],
      ["합계(분)", 10],
      ["생성일시", 20],
      ["수정일시", 20],
    ),
    rows,
  );
}

function leaveItemsSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(
    db,
    `SELECT i.*, r.employee_name, r.status, r.work_start, r.work_end, t.name AS type_name
       FROM leave_request_items i JOIN leave_requests r ON r.id = i.request_id JOIN leave_types t ON t.id = i.leave_type_id
      ORDER BY i.start_at DESC, i.id DESC`,
  ).map((r): Cell[] => {
    const day = dayOfRow(r);
    const byYear = Object.entries(parseJson<Record<string, number>>(r.minutes_by_year, {}))
      .map(([y, m]) => `${y}년 ${fmt(m, day)}`)
      .join(", ");
    return [
      toNum(r.id),
      toNum(r.request_id),
      String(r.employee_name),
      String(r.type_name),
      String(r.start_at).replace("T", " "),
      String(r.end_at).replace("T", " "),
      toNum(r.minutes),
      fmt(toNum(r.minutes), day),
      byYear,
      statusLabel(r.status),
    ];
  });
  addSheet(
    wb,
    "휴가원 항목",
    cols(
      ["ID", 6],
      ["휴가원 ID", 10],
      ["성명", 12],
      ["휴가 종류", 14],
      ["시작일시", 18],
      ["종료일시", 18],
      ["사용 시간(분)", 13],
      ["사용 시간", 12],
      ["연도별 사용", 20],
      ["휴가원 상태", 11],
    ),
    rows,
  );
}

function overtimeSheet(wb: ExcelJS.Workbook, db: Db): void {
  const targets = new Map<number, Row[]>();
  for (const t of queryAll(
    db,
    `SELECT ot.*, t.name AS type_name FROM overtime_targets ot LEFT JOIN leave_types t ON t.id = ot.leave_type_id
      ORDER BY ot.overtime_request_id, ot.sort_order, ot.id`,
  )) {
    const id = toNum(t.overtime_request_id);
    targets.set(id, [...(targets.get(id) ?? []), t]);
  }
  const rows = queryAll(
    db,
    `SELECT o.*, EXISTS (SELECT 1 FROM leave_grants g WHERE g.overtime_request_id = o.id) AS accrued
       FROM overtime_requests o
      ORDER BY o.id DESC`,
  ).map((r): Cell[] => {
    const general = r.kind === "general";
    const own = targets.get(toNum(r.id)) ?? [];
    // 대상자마다 고른 적립 종류
    const typeNames = [...new Set(own.filter((t) => t.type_name !== null).map((t) => String(t.type_name)))].join(", ");
    const list = own
      .map((t) =>
        general
          ? String(t.employee_name)
          : `${String(t.employee_name)} ${toNum(t.days)}일${t.month === null ? "" : `(${toNum(t.month)}월)`}`,
      )
      .join(", ");
    const minutes = r.minutes === null ? null : toNum(r.minutes);
    return [
      toNum(r.id),
      OVERTIME_KIND_LABELS[String(r.kind)] ?? String(r.kind),
      list,
      str(r.work_start_at)?.replace("T", " ") ?? null,
      str(r.work_end_at)?.replace("T", " ") ?? null,
      minutes,
      minutes === null ? null : formatHoursMinutes(minutes),
      String(r.cumulative_note),
      CATEGORY_LABELS[String(r.category)] ?? String(r.category),
      String(r.work_details),
      str(r.paid_on),
      str(r.submitted_on),
      typeNames || null,
      yesNo(r.accrued),
      statusLabel(r.status),
      str(r.cancelled_at),
      str(r.last_printed_at),
      String(r.created_at),
      String(r.updated_at),
    ];
  });
  addSheet(
    wb,
    "시간외근무 신청서",
    cols(
      ["ID", 6],
      ["종류", 20],
      ["대상자", 30],
      ["근무 시작일시", 18],
      ["근무 종료일시", 18],
      ["금일발생(분)", 12],
      ["금일발생", 11],
      ["누적", 14],
      ["상세내용", 10],
      ["근무내역", 40],
      ["지급일자", 12],
      ["제출일", 12],
      ["적립 휴가 종류", 14],
      ["적립됨", 8],
      ["상태", 8],
      ["취소일시", 20],
      ["최근 출력일시", 20],
      ["생성일시", 20],
      ["수정일시", 20],
    ),
    rows,
  );
}

function holidaysSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(db, "SELECT * FROM holidays ORDER BY date, kind, name").map((r): Cell[] => [
    toNum(r.id),
    String(r.date),
    WEEKDAY_LABELS[weekdayOf(String(r.date))] ?? "",
    String(r.name),
    r.kind === "center" ? "센터 휴무일" : "법정공휴일",
    r.source === "manual" ? "수동" : "자동",
    yesNo(r.active),
  ]);
  addSheet(
    wb,
    "공휴일·휴무일",
    cols(["ID", 6], ["날짜", 12], ["요일", 6], ["이름", 20], ["구분", 12], ["등록 방식", 10], ["사용", 8]),
    rows,
  );
}

/** 잔여를 계산한 범위: "2026년", "누적(2026년까지)", "2026.03.01.~2027.02.28.", "2026.10.20. 기준" */
function balanceScopeLabel(b: BalanceRow): string {
  if (isCumulativeMode(b.balanceMode)) return `누적(${b.year}년까지)`;
  if (b.balanceMode === "grant_period") return b.asOf ? `${formatDotDate(b.asOf)} 기준` : `${b.year}년`;
  if (b.balanceMode === "expire_date" && b.periodStart && b.periodEnd) {
    return `${formatDotDate(b.periodStart)}~${formatDotDate(b.periodEnd)}`;
  }
  return `${b.year}년`;
}

function usageSheet(wb: ExcelJS.Workbook, db: Db, year: number, today: string): void {
  const rows: Cell[][] = [];
  for (const e of listEmployees(db, { includeInactive: true })) {
    for (const b of getEmployeeBalances(db, e.id, year, { today })) {
      rows.push([
        e.name,
        e.department,
        e.active ? "예" : "아니오",
        b.name,
        balanceScopeLabel(b),
        fmt(b.grantedMinutes, dayMinutesOf(e)),
        fmt(b.usedMinutes, dayMinutesOf(e)),
        b.remainingMinutes === null ? "차감 안 함" : fmt(b.remainingMinutes, dayMinutesOf(e)),
        b.grantedMinutes,
        b.usedMinutes,
        b.remainingMinutes,
      ]);
    }
  }
  addSheet(
    wb,
    "사용 현황 요약",
    cols(
      ["성명", 12],
      ["소속", 16],
      ["재직", 8],
      ["휴가 종류", 14],
      ["기준", 16],
      ["부여", 12],
      ["사용", 12],
      ["잔여", 12],
      ["부여(분)", 10],
      ["사용(분)", 10],
      ["잔여(분)", 10],
    ),
    rows,
  );
}

function auditSheet(wb: ExcelJS.Workbook, db: Db): void {
  const rows = queryAll(db, "SELECT * FROM audit_logs ORDER BY at DESC, id DESC").map((r): Cell[] => [
    toNum(r.id),
    String(r.at),
    String(r.ip),
    ENTITY_LABELS[String(r.entity) as AuditEntity] ?? String(r.entity),
    r.entity_id === null ? null : toNum(r.entity_id),
    r.employee_id === null ? null : toNum(r.employee_id),
    ACTION_LABELS[String(r.action) as AuditAction] ?? String(r.action),
    String(r.summary),
    jsonCell(r.before_json),
    jsonCell(r.after_json),
  ]);
  addSheet(
    wb,
    "변경 이력",
    cols(
      ["ID", 7],
      ["일시", 20],
      ["IP", 15],
      ["대상", 16],
      ["대상 ID", 8],
      ["직원 ID", 8],
      ["작업", 10],
      ["내용", 50],
      ["변경 전", 40],
      ["변경 후", 40],
    ),
    rows,
  );
}

/** 엑셀 백업 파일 내용 (today: 사용 현황 요약 기준 연도) */
export async function buildExportWorkbook(db: Db, today: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "leave-flow";
  employeesSheet(wb, db);
  leaveTypesSheet(wb, db);
  grantsSheet(wb, db);
  openingBalancesSheet(wb, db);
  leaveRequestsSheet(wb, db);
  leaveItemsSheet(wb, db);
  overtimeSheet(wb, db);
  holidaysSheet(wb, db);
  usageSheet(wb, db, Number(today.slice(0, 4)), today);
  auditSheet(wb, db);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 엑셀 열 너비 단위에 가까운 글자 폭 (한글 등 넓은 글자 2, 나머지 1) */
const textWidth = (s: string) => [...s].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);

const THIN = { style: "thin" } as const;
const ALL_BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * 화면 표 그대로 엑셀로 (잔여 현황·사용 현황).
 * 1줄 제목, 2줄 부제목, 3줄부터 머리글(colSpan·rowSpan → 셀 병합)과 본문. 인쇄는 A4 가로, 너비를 한 장에 맞춤
 */
export async function buildTableWorkbook(input: TableExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "leave-flow";
  // 시트 이름: 31자 이하, : \ / ? * [ ] 못 씀
  const ws = wb.addWorksheet(input.title.replace(/[:\\/?*[\]]/g, " ").slice(0, 31), {
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
  });
  const title = ws.getCell(1, 1);
  title.value = input.title;
  title.font = { bold: true, size: 14 };
  if (input.subtitle) ws.getCell(2, 1).value = input.subtitle;

  const headTop = 3;
  const bodyTop = headTop + input.head.length;
  const widths: number[] = [];
  const fit = (col: number, text: string) => {
    const w = Math.max(...text.split("\n").map(textWidth));
    widths[col] = Math.max(widths[col] ?? 0, w);
  };

  // 머리글: HTML 표처럼 위 줄의 rowSpan 이 차지한 칸은 건너뛰며 배치
  const taken = new Set<string>();
  let colCount = 0;
  input.head.forEach((cells, r) => {
    let c = 0;
    for (const cell of cells) {
      while (taken.has(`${r}:${c}`)) c++;
      const rowSpan = Math.min(cell.rowSpan ?? 1, input.head.length - r);
      const colSpan = cell.colSpan ?? 1;
      for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) taken.add(`${r + dr}:${c + dc}`);
      ws.getCell(headTop + r, c + 1).value = cell.text;
      if (rowSpan > 1 || colSpan > 1) ws.mergeCells(headTop + r, c + 1, headTop + r + rowSpan - 1, c + colSpan);
      if (colSpan === 1) fit(c, cell.text);
      c += colSpan;
      colCount = Math.max(colCount, c);
    }
  });
  input.body.forEach((cells, r) => {
    cells.forEach((text, c) => {
      ws.getCell(bodyTop + r, c + 1).value = text;
      fit(c, text);
    });
    colCount = Math.max(colCount, cells.length);
  });

  for (let r = headTop; r < bodyTop + input.body.length; r++) {
    for (let c = 1; c <= colCount; c++) {
      const cell = ws.getCell(r, c);
      cell.border = ALL_BORDERS;
      if (r < bodyTop) {
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F0" } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      } else {
        cell.alignment = { vertical: "top", wrapText: true };
      }
    }
  }
  for (let c = 0; c < colCount; c++) ws.getColumn(c + 1).width = Math.min(40, Math.max(6, (widths[c] ?? 0) + 2));
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: bodyTop - 1 }];
  ws.pageSetup.printTitlesRow = `${headTop}:${bodyTop - 1}`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
