// 휴가원 관리대장 엑셀(.xlsx): 고른 연도의 휴가사용내역·휴가부여내역·잔여내역. 사용자가 준 양식(.dev/2026 휴가원 관리대장.xlsx)의 모양.
// 모든 시트 A열 소속, B열 구분 (직원의 지금 값), 휴가 종류는 표시 이름. 영구 삭제한 직원은 넣지 않음
import ExcelJS from "exceljs";
import {
  balanceScopeText,
  columnBalances,
  dayMinutesOf,
  distinctLeaveTypeLabels,
  formatLeaveMinutes,
  leaveTypeColumns,
  type BalanceRow,
  type LeaveType,
} from "@leave-flow/shared";
import { queryAll, toBool, toNum, type Db, type Row } from "../db/index.ts";
import { getEmployeeBalances, listReportEmployees } from "./balances.ts";
import { parseByDate } from "./leaveUsage.ts";
import { listLeaveTypes } from "./queries.ts";

type Cell = string | number | null;

interface Column {
  header: string;
  width: number;
  /** 왼쪽 정렬 (긴 글). 기본은 가운데 */
  left?: boolean;
}

const FONT_NAME = "맑은 고딕";
const HEADER_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 11, bold: true };
const BODY_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 11 };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F0" } };
const THIN = { style: "thin" } as const;
const ALL_BORDERS: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/** 시간외근무 신청서의 상세내용 */
const CATEGORY_LABELS: Record<string, string> = {
  official_event: "공식행사",
  special_work: "특별근무",
  special_leave: "특별휴가",
  award: "시상",
};

/** 1일 = 그 직원의 하루 근무시간 */
const fmt = (minutes: number, dayMinutes: number) => formatLeaveMinutes(minutes, dayMinutes);
const dayOfRow = (r: Row) => dayMinutesOf({ workStart: String(r.work_start), workEnd: String(r.work_end) });

/** 머리글 1줄 + 본문 표: 모든 칸 테두리, 머리글은 굵게·회색 바탕, 본문은 가운데 정렬(left 칸 제외), 첫 줄 고정·필터 */
function addSheet(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: Cell[][]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  for (const r of rows) ws.addRow(r);
  ws.eachRow((row, n) => {
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.border = ALL_BORDERS;
      if (n === 1) {
        cell.font = HEADER_FONT;
        cell.fill = HEADER_FILL;
        cell.alignment = c.left ? { vertical: "middle" } : { horizontal: "center", vertical: "middle" };
      } else {
        cell.font = BODY_FONT;
        if (!c.left) cell.alignment = { horizontal: "center" };
      }
    });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

const cols = (...defs: ([string, number] | [string, number, "left"])[]): Column[] =>
  defs.map(([header, width, align]) => ({ header, width, left: align === "left" }));

interface TypedLine {
  employeeId: number;
  leaveTypeId: number;
  /** 관리 이름 */
  name: string;
  /** 표시 이름 (빈 값 = 관리 이름) */
  displayName: string;
}

/**
 * 직원마다 휴가 종류의 보이는 이름. 한 직원에게 표시 이름이 같은 종류가 둘 이상 나오면
 * (구분이 바뀐 직원의 예전 기록 등) 그 종류들은 관리 이름으로 구별
 */
function labelsByEmployee(lines: readonly TypedLine[]): (line: TypedLine) => string {
  const types = new Map<number, Map<number, TypedLine>>();
  for (const l of lines) {
    const own = types.get(l.employeeId) ?? new Map<number, TypedLine>();
    if (!own.has(l.leaveTypeId)) own.set(l.leaveTypeId, l);
    types.set(l.employeeId, own);
  }
  const labels = new Map<string, string>();
  for (const [employeeId, own] of types) {
    const label = distinctLeaveTypeLabels([...own.values()]);
    for (const t of own.values()) labels.set(`${employeeId}:${t.leaveTypeId}`, label(t));
  }
  return (l) => labels.get(`${l.employeeId}:${l.leaveTypeId}`) ?? (l.displayName || l.name);
}

/** 정렬: 문자열 칸을 차례로 비교 */
const byKeys = <T>(...keys: ((x: T) => string | number)[]) => (a: T, b: T): number => {
  for (const k of keys) {
    const x = k(a);
    const y = k(b);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

interface UsageLine extends TypedLine {
  itemId: number;
  department: string;
  category: string;
  employeeName: string;
  date: string;
  start: string;
  end: string;
  reason: string;
  minutes: number;
  dayMinutes: number;
  note: string;
}

/**
 * 휴가사용내역: 신청 상태 휴가원 항목을 날짜마다 1줄 (그 해 날짜만, 저장된 날짜별 사용량).
 * 시작·종료시각: 항목 첫날은 항목 시작부터, 마지막 날은 항목 종료까지, 그 밖은 휴가원에 저장된 근무시간.
 * 미차감 휴가원은 비고 앞에 [미차감]
 */
function usageSheet(wb: ExcelJS.Workbook, db: Db, year: number): void {
  const lines: UsageLine[] = [];
  const items = queryAll(
    db,
    `SELECT i.id, i.leave_type_id, i.start_at, i.end_at, i.minutes_by_date,
            r.employee_id, r.reason, r.handover_note, r.no_deduct, r.work_start, r.work_end,
            e.name AS employee_name, e.department, e.category, t.name AS type_name, t.display_name
       FROM leave_request_items i
       JOIN leave_requests r ON r.id = i.request_id
       JOIN employees e ON e.id = r.employee_id
       JOIN leave_types t ON t.id = i.leave_type_id
      WHERE r.status = 'active' AND e.deleted = 0 AND json_extract(i.minutes_by_year, ?) > 0`,
    [`$."${year}"`],
  );
  for (const r of items) {
    const startAt = String(r.start_at);
    const endAt = String(r.end_at);
    const handover = String(r.handover_note);
    const note = toBool(r.no_deduct) ? (handover ? `[미차감] ${handover}` : "[미차감]") : handover;
    for (const d of parseByDate(r.minutes_by_date)) {
      if (!d.date.startsWith(`${year}-`) || d.minutes <= 0) continue;
      lines.push({
        itemId: toNum(r.id),
        employeeId: toNum(r.employee_id),
        leaveTypeId: toNum(r.leave_type_id),
        name: String(r.type_name),
        displayName: String(r.display_name),
        department: String(r.department),
        category: String(r.category),
        employeeName: String(r.employee_name),
        date: d.date,
        start: d.date === startAt.slice(0, 10) ? startAt.slice(11, 16) : String(r.work_start),
        end: d.date === endAt.slice(0, 10) ? endAt.slice(11, 16) : String(r.work_end),
        reason: String(r.reason),
        minutes: d.minutes,
        dayMinutes: dayOfRow(r),
        note,
      });
    }
  }
  lines.sort(byKeys((l) => l.date, (l) => l.start, (l) => l.employeeName, (l) => l.itemId));
  const label = labelsByEmployee(lines);
  addSheet(
    wb,
    "휴가사용내역",
    cols(
      ["소속", 11],
      ["구분", 13],
      ["성명", 9.5],
      ["날짜", 11.125],
      ["시작시각", 13.25],
      ["종료시각", 13.25],
      ["휴가사유", 13.25],
      ["휴가종류", 13.25],
      ["사용시간", 13.25],
      ["비고(업무인계 및 기타사항)", 30.5],
    ),
    lines.map((l) => [
      l.department,
      l.category,
      l.employeeName,
      l.date,
      l.start,
      l.end,
      l.reason,
      label(l),
      fmt(l.minutes, l.dayMinutes),
      l.note,
    ]),
  );
}

interface GrantLine extends TypedLine {
  department: string;
  category: string;
  employeeName: string;
  date: string;
  amount: string;
  detail: string;
  work: string;
}

/**
 * 휴가부여내역: 부여일이 그 해인 부여 내역 + 그 해 기존 잔여 입력.
 * 시간외근무 적립은 신청서의 상세내용·근무내역, 직접 입력은 "직접부여"·부여 비고,
 * 기존 잔여는 기준일자·총 부여량·"기존 잔여"·기존 사용량과 입력 당시 잔여
 */
function grantsSheet(wb: ExcelJS.Workbook, db: Db, year: number): void {
  const grants = queryAll(
    db,
    `SELECT g.employee_id, g.leave_type_id, g.grant_date, g.minutes, g.note, g.source,
            o.category AS overtime_category, o.work_details,
            e.name AS employee_name, e.department, e.category, e.work_start, e.work_end,
            t.name AS type_name, t.display_name
       FROM leave_grants g
       JOIN employees e ON e.id = g.employee_id
       JOIN leave_types t ON t.id = g.leave_type_id
       LEFT JOIN overtime_requests o ON o.id = g.overtime_request_id
      WHERE e.deleted = 0 AND substr(g.grant_date, 1, 4) = ?`,
    [String(year)],
  ).map((r): GrantLine => {
    const overtime = r.source === "overtime";
    return {
      ...employeeOf(r),
      date: String(r.grant_date),
      amount: fmt(toNum(r.minutes), dayOfRow(r)),
      detail: overtime ? (CATEGORY_LABELS[String(r.overtime_category)] ?? String(r.overtime_category ?? "")) : "직접부여",
      work: overtime ? String(r.work_details ?? "") : String(r.note),
    };
  });
  const openings = queryAll(
    db,
    `SELECT o.employee_id, o.leave_type_id, o.base_date, o.total_granted_minutes, o.remaining_minutes, o.used_minutes,
            e.name AS employee_name, e.department, e.category, e.work_start, e.work_end,
            t.name AS type_name, t.display_name
       FROM opening_balances o
       JOIN employees e ON e.id = o.employee_id
       JOIN leave_types t ON t.id = o.leave_type_id
      WHERE e.deleted = 0 AND o.year = ?`,
    [year],
  ).map((r): GrantLine => {
    const day = dayOfRow(r);
    return {
      ...employeeOf(r),
      date: String(r.base_date),
      amount: fmt(toNum(r.total_granted_minutes), day),
      detail: "기존 잔여",
      work: `기존 사용 ${fmt(toNum(r.used_minutes), day)} / 입력 당시 잔여 ${fmt(toNum(r.remaining_minutes), day)}`,
    };
  });
  const lines = [...openings, ...grants].sort(byKeys((l) => l.date, (l) => l.employeeName));
  const label = labelsByEmployee(lines);
  addSheet(
    wb,
    "휴가부여내역",
    cols(
      ["소속", 11],
      ["구분", 13],
      ["성명", 9.5],
      ["부여일", 11.375],
      ["휴가종류", 11.25],
      ["부여량", 11.375],
      ["상세내용", 13.25],
      ["근무내역", 45.375, "left"],
    ),
    lines.map((l) => [l.department, l.category, l.employeeName, l.date, label(l), l.amount, l.detail, l.work]),
  );
}

/** 부여·기존 잔여 행의 직원·종류 칸 */
function employeeOf(r: Row): Omit<GrantLine, "date" | "amount" | "detail" | "work"> {
  return {
    employeeId: toNum(r.employee_id),
    leaveTypeId: toNum(r.leave_type_id),
    name: String(r.type_name),
    displayName: String(r.display_name),
    department: String(r.department),
    category: String(r.category),
    employeeName: String(r.employee_name),
  };
}

/**
 * 잔여내역 (잔여 현황 화면과 같은 열): 소속·구분·직원, 휴가 종류는 표시 이름으로 묶어 부여·사용·잔여
 * (묶은 종류의 기준이 서로 다르면 기간 칸도), 차감 안 하는 종류는 사용만. 적용되는 종류가 없으면 "-".
 * 직원 = 활성 직원 + 그 해 기록이 있는 비활성 직원, 종류 = 활성 종류.
 * 머리글 2줄(소속·구분·직원은 두 줄 병합, 종류 이름은 칸 병합), 소속~직원 열과 머리글 고정, 인쇄는 A4 가로·너비 한 장
 */
function remainingSheet(wb: ExcelJS.Workbook, db: Db, year: number, today: string): void {
  const types = listLeaveTypes(db);
  const scopeOf = (t: LeaveType) => balanceScopeText(t, year, today);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const rowScope = (b: BalanceRow) => {
    const t = typeById.get(b.leaveTypeId);
    return t ? scopeOf(t) : "";
  };
  const deducting = leaveTypeColumns(types.filter((t) => t.deducts), scopeOf);
  const usedOnly = leaveTypeColumns(types.filter((t) => !t.deducts), scopeOf);
  const ws = wb.addWorksheet("잔여내역", {
    views: [{ state: "frozen", xSplit: 3, ySplit: 2 }],
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
      printTitlesRow: "1:2",
    },
  });

  // 머리글
  const fixed: [string, number][] = [
    ["소속", 11],
    ["구분", 13],
    ["직원", 9.5],
  ];
  fixed.forEach(([text, width], i) => {
    ws.getCell(1, i + 1).value = text;
    ws.mergeCells(1, i + 1, 2, i + 1);
    ws.getColumn(i + 1).width = width;
  });
  const groups: [string, string[]][] = [
    ...deducting.map((c): [string, string[]] => [
      c.scope ? `${c.label}\n${c.scope}` : c.label,
      ["부여", "사용", "잔여", ...(c.scope ? [] : ["기간"])],
    ]),
    ...usedOnly.map((c): [string, string[]] => [`${c.label}\n차감 안 함`, ["사용"]]),
  ];
  let col = fixed.length + 1;
  for (const [title, subs] of groups) {
    ws.getCell(1, col).value = title;
    if (subs.length > 1) ws.mergeCells(1, col, 1, col + subs.length - 1);
    subs.forEach((text, i) => {
      ws.getCell(2, col + i).value = text;
      ws.getColumn(col + i).width = 10.625;
    });
    col += subs.length;
  }
  const colCount = col - 1;
  ws.getRow(1).height = 33;

  // 본문
  let rowNo = 3;
  for (const e of listReportEmployees(db, year)) {
    const f = (m: number) => fmt(m, dayMinutesOf(e));
    const byType = new Map(getEmployeeBalances(db, e.id, year, { today }).map((b) => [b.leaveTypeId, b]));
    // 같은 표시 이름의 종류가 둘 이상(소속·구분이 바뀐 직원)이면 관리 이름을 붙여 줄을 바꿈
    const lines = (list: BalanceRow[], value: (b: BalanceRow) => string) =>
      list.length === 1 ? value(list[0]!) : list.map((b) => `${b.name} ${value(b)}`).join("\n");
    const cells: Cell[] = [e.department, e.category, e.active ? e.name : `${e.name} (비활성)`];
    for (const c of deducting) {
      const shown = columnBalances(c, byType).filter((b) => b.remainingMinutes !== null);
      const width = c.scope ? 3 : 4;
      if (shown.length === 0) {
        cells.push(...Array<string>(width).fill("-"));
        continue;
      }
      cells.push(
        lines(shown, (b) => f(b.grantedMinutes)),
        lines(shown, (b) => f(b.usedMinutes)),
        lines(shown, (b) => f(b.remainingMinutes!)),
        ...(c.scope ? [] : [lines(shown, rowScope)]),
      );
    }
    for (const c of usedOnly) cells.push(f(columnBalances(c, byType).reduce((sum, b) => sum + b.usedMinutes, 0)));
    ws.getRow(rowNo++).values = cells;
  }

  for (let r = 1; r < rowNo; r++) {
    for (let c = 1; c <= colCount; c++) {
      const cell = ws.getCell(r, c);
      cell.border = ALL_BORDERS;
      if (r <= 2) {
        cell.font = HEADER_FONT;
        cell.fill = HEADER_FILL;
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      } else {
        cell.font = BODY_FONT;
        cell.alignment = { horizontal: "center", vertical: "top", wrapText: true };
      }
    }
  }
}

/** 휴가원 관리대장 엑셀 (year 의 기록. today: 부여 후 기간 소멸의 올해 잔여 기준) */
export async function buildLedgerWorkbook(db: Db, year: number, today: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "leave-flow";
  usageSheet(wb, db, year);
  grantsSheet(wb, db, year);
  remainingSheet(wb, db, year, today);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
