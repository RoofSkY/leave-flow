// 도입할 때 한 번 쓰는 도구: 예전 엑셀 휴가 관리대장(아동센터·사회복무요원)의 내역을 프로그램으로 옮긴다.
//
// 1) 검토 표 만들기 (서버 필요 없음)
//    node scripts/import-ledger.mjs review --center "<아동센터.xlsx>" --agent "<사회복무요원.xlsx>" --out 검토.xlsx
// 2) 검토 표를 엑셀로 열어 종류·날짜·시각을 확인하고 고친 뒤, "확인 필요" 칸을 지워 저장
// 3) 점검 (저장하지 않음)
//    node scripts/import-ledger.mjs check 검토.xlsx --server http://출결PC주소:8080
// 4) 불러오기 (점검을 통과해야 진행, 시작 전에 서버에서 백업을 만듦)
//    node scripts/import-ledger.mjs import 검토.xlsx --server http://출결PC주소:8080
//
// 직원·휴가 종류는 프로그램에 먼저 등록돼 있어야 한다 (성명, 휴가 종류의 보이는 이름으로 찾음).
import ExcelJS from "exceljs";
import { dailyWorkMinutes, dayMinutesOf, formatLeaveMinutes, leaveTypeAppliesTo, leaveTypeLabel } from "@leave-flow/shared";

const LEAVE_SHEET = "휴가";
const GRANT_SHEET = "부여";
const LEAVE_COLUMNS = ["휴가원", "성명", "종류", "시작일", "시작 시각", "종료일", "종료 시각", "휴가사유", "확인 필요", "엑셀 사용량", "출처", "엑셀 비고"];
const GRANT_COLUMNS = ["성명", "종류", "부여일", "일", "시간", "비고", "확인 필요", "출처"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) options[rest[i].slice(2)] = rest[++i];
    else positional.push(rest[i]);
  }
  return { command, options, positional };
}

// ---------- 엑셀 값 읽기 ----------

const pad = (n) => String(n).padStart(2, "0");

/** 병합된 칸은 첫 칸의 값. continued = 위 칸과 병합된 칸 */
function cellOf(ws, row, col) {
  const cell = ws.getRow(row).getCell(col);
  const continued = cell.isMerged && cell.master.address !== cell.address;
  return { value: continued ? cell.master.value : cell.value, continued };
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "object" && "richText" in value) return value.richText.map((t) => t.text).join("").trim();
  if (typeof value === "object" && "result" in value) return textOf(value.result);
  return String(value).trim();
}

/** 날짜 칸 → YYYY-MM-DD. "10월 13일"처럼 글자로 적힌 날은 fallbackYear 로 */
function dateOf(value, fallbackYear) {
  if (value instanceof Date) return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  if (typeof value === "number" && value > 1) return dateOf(new Date(Math.round((value - 25569) * 86400000)), fallbackYear);
  const text = textOf(value);
  let m = /^(\d{4})[-.\/]\s*(\d{1,2})[-.\/]\s*(\d{1,2})\.?$/.exec(text);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/.exec(text);
  if (m && fallbackYear) return `${fallbackYear}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

/** 시각 칸 → HH:MM, 비었거나 "-" 면 "" (그 직원의 근무시간을 씀) */
function timeOf(value) {
  if (value instanceof Date) {
    const minutes = Math.round((value.getUTCHours() * 60 + value.getUTCMinutes() + value.getUTCSeconds() / 60));
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  if (typeof value === "number" && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60);
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(textOf(value));
  return m ? `${pad(m[1])}:${m[2]}` : "";
}

/** "1d 2h 30m" → { days, minutes(일 제외) }. 비었거나 형식이 다르면 null */
function amountOf(value) {
  const text = textOf(value).replace(/\s+/g, "");
  if (!text) return null;
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return { days: Number(m[1] ?? 0), minutes: Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) };
}

/**
 * 대장은 10:00~19:00 근무의 반차를 10:00~14:30 / 14:30~19:00(각 4시간)으로 적었지만,
 * 프로그램은 점심을 빼고 계산하므로 반차 경계가 15:00. 같은 4시간이 되게 프로그램 반차 시각으로 바꿈
 */
function withProgramHalfDay(row) {
  const half = (row.start === "10:00" && row.end === "14:30") || (row.start === "14:30" && row.end === "19:00");
  if (!half) return row;
  return {
    ...row,
    start: row.start === "14:30" ? "15:00" : row.start,
    end: row.end === "14:30" ? "15:00" : row.end,
    halfDayFrom: `${row.start}~${row.end}`,
  };
}
const halfDayNote = (row) => (row.halfDayFrom ? ` (반차 ${row.halfDayFrom} → 프로그램 반차 시각)` : "");

const isPositive = (a) => a !== null && (a.days > 0 || a.minutes > 0);
const amountText = (a) => (a ? [a.days && `${a.days}d`, a.minutes >= 60 && `${Math.floor(a.minutes / 60)}h`, a.minutes % 60 && `${a.minutes % 60}m`].filter(Boolean).join(" ") || "0" : "");

// ---------- 비고에서 휴가 종류 찾기 ----------

const TYPE_KEYWORDS = [
  [/생일|특별/, "특별휴가"],
  [/토요/, "토요근무"],
  [/대체/, "대체휴가"],
  [/공가|건강검진/, "공가"],
  [/경조|부친상|모친상|빙부|빙모|조부|조모/, "경조휴가"],
  [/병가/, "병가"],
];

/** 글에 나온 휴가 종류들 (연가 외). 없고 "개인일정"·"연가"만 있으면 연가 */
function typesIn(text) {
  const found = new Set(TYPE_KEYWORDS.filter(([re]) => re.test(text)).map(([, type]) => type));
  if (found.size === 0 && /개인일정|연가/.test(text)) found.add("연가");
  return [...found];
}

/**
 * "05-12: 생일휴가 사용 / 05-20, 05-21: 토요근무 사용" → 날짜별 글, 날짜 없는 글.
 * 날짜는 MM-DD · M/D 모두 (연도는 year).
 */
function parseNote(note, year) {
  const byDate = new Map();
  const undated = [];
  for (const segment of note.split(/\n|\s\/\s/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^((?:\d{1,2}[-/]\d{1,2})(?:\s*,\s*\d{1,2}[-/]\d{1,2})*)\s*:?\s*(.*)$/.exec(segment);
    if (!m) {
      undated.push(segment);
      continue;
    }
    for (const d of m[1].split(",")) {
      const [mm, dd] = d.trim().split(/[-/]/);
      byDate.set(`${year}-${pad(mm)}-${pad(dd)}`, m[2]);
    }
  }
  return { byDate, undated };
}

/**
 * 행마다의 사용 시간(분)을 종류별 늘어난 양 [종류, 분][]에 정확히 나눠 맞추는 방법이 하나뿐이면 행별 종류, 아니면 null
 */
function assignByAmounts(minutes, deltas) {
  let found = null;
  let count = 0;
  const pick = [];
  const walk = (i, left) => {
    if (count > 1) return;
    if (i === minutes.length) {
      if (left.every(([, m]) => m === 0)) [found, count] = [[...pick], count + 1];
      return;
    }
    left.forEach(([type, m], k) => {
      if (m < minutes[i]) return;
      pick[i] = type;
      walk(i + 1, left.map((x, j) => (j === k ? [type, m - minutes[i]] : x)));
    });
  };
  walk(0, deltas);
  return count === 1 ? found : null;
}

// ---------- 아동센터 관리대장 ----------
// 열: B 성명, C 날짜, D 내용, E 시작, F 종료, G 사용 시간(휴가원 합계, 병합), H·I·J 누적 사용 연가·대체휴가·토요근무,
//     N 특별휴가(생일휴가 등), O 공가, P 경조휴가, Q 비고. 여러 날짜 휴가원은 D·G·H… 칸이 병합됨.

function readCenter(ws, label) {
  const groups = [];
  let year = null;
  for (let r = 2; r <= ws.rowCount; r++) {
    const name = textOf(cellOf(ws, r, 2).value);
    const dateCell = cellOf(ws, r, 3);
    if (!name && dateCell.value == null) continue;
    const date = dateOf(dateCell.value, year);
    if (date) year = date.slice(0, 4);
    const continued = [4, 7, 8].some((c) => cellOf(ws, r, c).continued);
    const row = {
      excelRow: r,
      date,
      dateText: textOf(dateCell.value),
      start: timeOf(cellOf(ws, r, 5).value),
      end: timeOf(cellOf(ws, r, 6).value),
      special: textOf(ws.getRow(r).getCell(14).value),
    };
    if (continued && groups.length > 0) {
      groups.at(-1).rows.push(row);
      continue;
    }
    groups.push({
      source: label,
      name,
      reason: textOf(cellOf(ws, r, 4).value),
      total: textOf(cellOf(ws, r, 7).value),
      cumulative: { 연가: amountOf(cellOf(ws, r, 8).value), 대체휴가: amountOf(cellOf(ws, r, 9).value), 토요근무: amountOf(cellOf(ws, r, 10).value) },
      publicLeave: amountOf(cellOf(ws, r, 15).value),
      familyLeave: amountOf(cellOf(ws, r, 16).value),
      note: textOf(cellOf(ws, r, 17).value),
      rows: [row],
    });
  }

  // 직원의 1일 = 행 하나의 가장 긴 사용 시간 (대장의 "1d"는 그 직원의 하루 근무시간)
  const rowMinutes = (row, day) => (row.start && row.end ? dailyWorkMinutes({ workStart: row.start, workEnd: row.end }) : day);
  const dayOf = new Map();
  for (const g of groups) {
    for (const row of g.rows) dayOf.set(g.name, Math.max(dayOf.get(g.name) ?? 0, rowMinutes(row, 0)));
  }

  // 누적 칸의 변화(같은 직원의 바로 앞 휴가원과 비교, 파일에 적은 순서)로 종류 추정.
  // 여러 종류가 늘었으면 행마다의 사용 시간으로 나눠 맞춰 봄 (맞는 방법이 하나뿐일 때만 사용)
  const previous = new Map();
  for (const g of groups) {
    const day = dayOf.get(g.name) || 480;
    const toMinutes = (a) => (a ? a.days * day + a.minutes : 0);
    const before = previous.get(g.name) ?? { 연가: null, 대체휴가: null, 토요근무: null };
    const deltas = Object.keys(g.cumulative)
      .map((k) => [k, toMinutes(g.cumulative[k]) - toMinutes(before[k])])
      .filter(([, m]) => m > 0);
    g.increased = deltas.map(([k]) => k);
    if (isPositive(g.publicLeave)) deltas.push(["공가", toMinutes(g.publicLeave)]);
    if (isPositive(g.familyLeave)) deltas.push(["경조휴가", toMinutes(g.familyLeave)]);
    g.assigned = deltas.length >= 2 ? assignByAmounts(g.rows.map((r) => rowMinutes(r, day)), deltas) : null;
    previous.set(g.name, g.cumulative);
  }

  const leaves = [];
  for (const g of groups) {
    const groupYear = (g.rows.find((r) => r.date)?.date ?? "2026").slice(0, 4);
    const { byDate, undated } = parseNote(g.note, groupYear);
    const undatedTypes = typesIn(undated.join(" ")).filter((t) => t !== "연가");
    const flagsOfGroup = [];
    const rowDates = new Set(g.rows.map((r) => r.date));
    const missing = [...byDate.keys()].filter((d) => !rowDates.has(d));
    if (missing.length > 0) flagsOfGroup.push(`비고의 날짜(${missing.map((d) => d.slice(5)).join(", ")})가 행에 없음`);

    let firstStart = "";
    let firstEnd = "";
    g.rows.forEach((row, i) => {
      const flags = i === 0 ? [...flagsOfGroup] : [];
      if (!row.date) flags.push(`날짜를 읽지 못함(${row.dateText || "빈 칸"})`);
      if (i === 0) [firstStart, firstEnd] = [row.start, row.end];

      let type = null;
      const dated = row.date ? byDate.get(row.date) : undefined;
      if (dated !== undefined) {
        const types = typesIn(dated);
        if (types.length === 1) type = types[0];
        else flags.push(`비고에 종류가 여럿(${dated})`);
      }
      if (!type && row.special) type = "특별휴가";
      if (!type && undatedTypes.length === 1) type = undatedTypes[0];
      if (!type && undatedTypes.length > 1) flags.push(`비고에 종류가 여럿(${undated.join(" ")})`);
      if (!type && g.assigned) type = g.assigned[i];
      if (!type && isPositive(g.familyLeave)) type = "경조휴가";
      if (!type && isPositive(g.publicLeave)) {
        type = "공가";
        if (g.rows.length > 1) flags.push(`공가 ${amountText(g.publicLeave)}가 어느 날짜인지 확인`);
      }
      if (!type && byDate.size > 0 && dated === undefined) flags.push("비고에 이 날짜가 없음");
      if (!type) {
        if (g.increased.length === 1) type = g.increased[0];
        else {
          type = "연가";
          flags.push(g.increased.length === 0 ? "누적 칸 변화가 없어 종류를 알 수 없음(연가로 둠)" : `누적 칸에서 ${g.increased.join("·")}가 함께 늘어남`);
        }
      }

      leaves.push({
        first: i === 0,
        name: g.name,
        type,
        startDate: row.date ?? "",
        startTime: row.start || firstStart,
        endDate: row.date ?? "",
        endTime: row.end || firstEnd,
        reason: g.reason || "개인일정",
        flags,
        total: i === 0 ? g.total : "",
        source: `${g.source} ${row.excelRow}행`,
        note: i === 0 ? g.note : "",
      });
    });
  }
  return { leaves, grants: [] };
}

// ---------- 사회복무요원 관리대장 ----------
// 5행부터. 열: B 성명, C 신청일, D 휴가일자, E 내용, F 시작, G 종료, 금회사용 H 연가 · K 병가 · O 대체휴가 · S 특별휴가,
//     금회발생 N 대체휴가 · R 특별휴가(휴가일자가 없는 행), V 비고. 여러 날짜 휴가원은 E 칸부터 병합됨.

const AGENT_USE_COLUMNS = { 연가: 8, 병가: 11, 대체휴가: 15, 특별휴가: 19 };

function readAgent(ws, label) {
  const groups = [];
  const grants = [];
  for (let r = 5; r <= ws.rowCount; r++) {
    const name = textOf(ws.getRow(r).getCell(2).value);
    if (!name) continue;
    const applied = dateOf(ws.getRow(r).getCell(3).value);
    const dateCell = ws.getRow(r).getCell(4).value;
    const note = textOf(cellOf(ws, r, 22).value);

    if (dateCell == null) {
      const sources = [[18, "특별휴가", "월 1회 특별휴가 부여"], [14, "대체휴가", "시간외근무 발생"]];
      if (/부여/.test(note) && !sources.some(([col]) => isPositive(amountOf(ws.getRow(r).getCell(col).value)))) {
        // 비고에는 부여라고 적혀 있는데 발생 칸이 빈 행
        grants.push({ name, type: "특별휴가", date: applied ?? "", days: 0, hours: 0, note, flags: ["발생 칸이 비어 있음 — 양을 적거나 행을 지우세요"], source: `${label} ${r}행` });
      }
      for (const [col, type, defaultNote] of sources) {
        const amount = amountOf(ws.getRow(r).getCell(col).value);
        if (!isPositive(amount)) continue;
        grants.push({
          name,
          type,
          date: applied ?? "",
          days: amount.days,
          hours: amount.minutes / 60,
          note: note || defaultNote,
          flags: applied ? [] : ["신청일(부여일)을 읽지 못함"],
          source: `${label} ${r}행`,
        });
      }
      continue;
    }

    const row = {
      excelRow: r,
      applied,
      date: dateOf(dateCell),
      start: timeOf(cellOf(ws, r, 6).value),
      end: timeOf(cellOf(ws, r, 7).value),
    };
    if (cellOf(ws, r, 5).continued && groups.length > 0) {
      groups.at(-1).rows.push(row);
      continue;
    }
    const used = Object.entries(AGENT_USE_COLUMNS)
      .map(([type, col]) => [type, amountOf(cellOf(ws, r, col).value)])
      .filter(([, a]) => isPositive(a));
    groups.push({ name, reason: textOf(cellOf(ws, r, 5).value), used, note, rows: [row] });
  }

  const leaves = [];
  for (const g of groups) {
    const year = (g.rows[0].date ?? "2026").slice(0, 4);
    const { byDate } = parseNote(g.note, year);
    const seen = new Set();
    g.rows.forEach((row, i) => {
      const flags = [];
      if (!row.date) flags.push("휴가일자를 읽지 못함");
      if (seen.has(row.date)) flags.push(`같은 휴가일자가 여러 행(신청일 ${row.applied?.slice(5) ?? "?"}) — 실제 날짜 확인`);
      seen.add(row.date);

      let type = null;
      if (g.used.length === 1) type = g.used[0][0];
      else {
        const types = byDate.has(row.date) ? typesIn(byDate.get(row.date)) : [];
        if (types.length === 1) type = types[0];
        else flags.push(g.used.length === 0 ? "금회사용 칸이 비어 종류를 알 수 없음" : `금회사용이 여러 종류(${g.used.map(([t]) => t).join("·")}) — 날짜별 종류 확인`);
      }

      leaves.push({
        first: i === 0,
        name: g.name,
        type: type ?? g.used[0]?.[0] ?? "연가",
        startDate: row.date ?? "",
        startTime: row.start || g.rows[0].start,
        endDate: row.date ?? "",
        endTime: row.end || g.rows[0].end,
        reason: g.reason || "개인일정",
        flags,
        total: i === 0 ? g.used.map(([t, a]) => `${t} ${amountText(a)}`).join(", ") : "",
        source: `${label} ${row.excelRow}행 (신청일 ${row.applied ?? "?"})`,
        note: i === 0 ? g.note : "",
      });
    });
  }
  return { leaves, grants };
}

// ---------- 검토 표 ----------

async function review(options) {
  if (!options.out || (!options.center && !options.agent)) {
    fail('사용: node scripts/import-ledger.mjs review --center "<아동센터.xlsx>" --agent "<사회복무요원.xlsx>" --out 검토.xlsx');
  }
  const leaves = [];
  const grants = [];
  for (const [path, reader, label] of [
    [options.center, readCenter, "아동센터"],
    [options.agent, readAgent, "사회복무요원"],
  ]) {
    if (!path) continue;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const result = reader(wb.worksheets[0], label);
    // 같은 번호 = 한 휴가원 (두 파일에 이어서 매김)
    let number = leaves.at(-1)?.number ?? 0;
    for (const l of result.leaves) leaves.push({ ...l, number: l.first ? ++number : number });
    grants.push(...result.grants);
  }

  const wb = new ExcelJS.Workbook();
  const guide = wb.addWorksheet("안내");
  [
    "엑셀 관리대장에서 읽은 내역입니다. 프로그램에 넣기 전에 확인하고 고쳐 주세요.",
    "",
    "· '휴가' 시트: 한 행 = 휴가 항목 하나. '휴가원' 번호가 같은 행은 휴가원 하나로 들어갑니다.",
    "· 종류는 프로그램의 휴가 종류 이름(보이는 이름)으로 적습니다. 예: 연가, 대체휴가, 토요근무, 특별휴가, 공가, 경조휴가, 병가",
    "· 시각을 비우면 그 직원의 근무시간 전체로 봅니다. 여러 날을 한 항목으로 하려면 종료일을 바꾸세요.",
    "· '확인 필요' 칸은 자동으로 확실히 정하지 못한 행입니다. 확인·수정한 뒤 그 칸을 지우세요. 남아 있으면 불러오지 않습니다.",
    "· 넣지 않을 행은 행 전체를 삭제하세요.",
    "· '엑셀 사용량'은 원래 관리대장의 값으로, 점검(check) 때 프로그램이 계산한 사용 시간과 비교합니다.",
    "· '부여' 시트: 사회복무요원 월 특별휴가 부여·시간외근무 발생. 부여 내역으로 들어갑니다.",
    "",
    "다 고쳤으면 저장하고: node scripts/import-ledger.mjs check <이 파일> --server http://출결PC주소:8080",
  ].forEach((line) => guide.addRow([line]));
  guide.getColumn(1).width = 120;

  const addSheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(columns).font = { bold: true };
    for (const values of rows) {
      const row = ws.addRow(values);
      // 날짜·시각이 엑셀에서 다른 값으로 바뀌지 않게 글자로
      row.eachCell((cell) => (cell.numFmt = "@"));
      if (values[columns.indexOf("확인 필요")]) {
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      }
    }
    ws.columns.forEach((col, i) => (col.width = Math.min(60, Math.max(8, ...[columns[i], ...rows.map((r) => String(r[i] ?? ""))].map((v) => v.length * 1.6)))));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  };
  addSheet(
    LEAVE_SHEET,
    LEAVE_COLUMNS,
    leaves.map((l) => [l.number, l.name, l.type, l.startDate, l.startTime, l.endDate, l.endTime, l.reason, l.flags.join("; "), l.total, l.source, l.note]),
  );
  addSheet(
    GRANT_SHEET,
    GRANT_COLUMNS,
    grants.map((g) => [g.name, g.type, g.date, g.days, g.hours, g.note, g.flags.join("; "), g.source]),
  );
  await wb.xlsx.writeFile(options.out);

  const flagged = leaves.filter((l) => l.flags.length > 0).length + grants.filter((g) => g.flags.length > 0).length;
  console.log(`검토 표를 만들었습니다: ${options.out}`);
  console.log(`  휴가원 ${leaves.at(-1)?.number ?? 0}건(항목 ${leaves.length}개), 부여 ${grants.length}건, 확인 필요 ${flagged}행`);
}

/** 검토 표 읽기. 머리글 이름으로 열을 찾으므로 열 순서를 바꿔도 됨 */
async function readReview(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const read = (sheetName, columns) => {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) fail(`검토 표에 '${sheetName}' 시트가 없습니다.`);
    const index = new Map();
    ws.getRow(1).eachCell((cell, col) => index.set(textOf(cell.value), col));
    for (const c of columns) if (!index.has(c)) fail(`'${sheetName}' 시트에 '${c}' 열이 없습니다.`);
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const get = (c) => ws.getRow(r).getCell(index.get(c)).value;
      if (!textOf(get("성명"))) continue;
      rows.push({ excelRow: r, get });
    }
    return rows;
  };
  const leaves = read(LEAVE_SHEET, LEAVE_COLUMNS).map(({ excelRow, get }) => ({
    excelRow,
    number: textOf(get("휴가원")),
    name: textOf(get("성명")),
    type: textOf(get("종류")),
    startDate: dateOf(get("시작일")),
    startTime: timeOf(get("시작 시각")),
    endDate: dateOf(get("종료일")) ?? dateOf(get("시작일")),
    endTime: timeOf(get("종료 시각")),
    reason: textOf(get("휴가사유")),
    flag: textOf(get("확인 필요")),
    total: textOf(get("엑셀 사용량")),
  }));
  const grants = read(GRANT_SHEET, GRANT_COLUMNS).map(({ excelRow, get }) => ({
    excelRow,
    name: textOf(get("성명")),
    type: textOf(get("종류")),
    date: dateOf(get("부여일")),
    days: Number(textOf(get("일")) || 0),
    hours: Number(textOf(get("시간")) || 0),
    note: textOf(get("비고")),
    flag: textOf(get("확인 필요")),
  }));
  return { leaves, grants };
}

// ---------- 서버 ----------

async function api(server, method, path, body) {
  const res = await fetch(new URL(path, server), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${method} ${path} → ${res.status}`);
  return data;
}

/**
 * 검토 표를 서버 기준으로 점검. 오류(errors)가 하나라도 있으면 불러오지 않음.
 * 엑셀 사용량과 계산이 다른 것은 알림(notices)만.
 */
async function check(path, server) {
  const review = await readReview(path);
  const [employees, leaveTypes] = await Promise.all([api(server, "GET", "/api/employees"), api(server, "GET", "/api/leave-types")]);
  const errors = [];
  const notices = [];

  const employeeOf = (name, where) => {
    const found = employees.filter((e) => e.name === name);
    if (found.length !== 1) errors.push(`${where}: ${found.length === 0 ? "프로그램에 없는(또는 비활성인) 직원" : "같은 이름의 직원이 여럿"} '${name}'`);
    return found.length === 1 ? found[0] : null;
  };
  const typeOf = (label, employee, where) => {
    const found = leaveTypes.filter((t) => leaveTypeLabel(t) === label && leaveTypeAppliesTo(t, employee));
    if (found.length !== 1) errors.push(`${where}: ${employee.name}에게 적용되는 '${label}' 휴가 종류가 ${found.length === 0 ? "없음" : "여럿"}`);
    return found.length === 1 ? found[0] : null;
  };

  // 휴가원: 번호별로 묶기 (표의 순서 유지)
  const byNumber = new Map();
  for (const l of review.leaves) {
    const where = `휴가 ${l.excelRow}행`;
    if (l.flag) errors.push(`${where}: 확인 필요 — ${l.flag}`);
    if (!l.number) errors.push(`${where}: 휴가원 번호가 비어 있음`);
    if (!l.startDate) errors.push(`${where}: 시작일을 읽을 수 없음`);
    if (!byNumber.has(l.number)) byNumber.set(l.number, []);
    byNumber.get(l.number).push(l);
  }

  const requests = [];
  for (const [number, rows] of byNumber) {
    const where = `휴가원 ${number}번(${rows.map((r) => r.excelRow).join("·")}행)`;
    const names = new Set(rows.map((r) => r.name));
    if (names.size > 1) {
      errors.push(`${where}: 한 휴가원에 직원이 여럿 (${[...names].join(", ")})`);
      continue;
    }
    if (rows.length > 20) errors.push(`${where}: 항목은 20개까지`);
    const employee = employeeOf(rows[0].name, where);
    if (!employee) continue;
    const items = [];
    for (const r of rows) {
      const type = typeOf(r.type, employee, `휴가 ${r.excelRow}행`);
      if (!type || !r.startDate) continue;
      items.push({
        leaveTypeId: type.id,
        startAt: `${r.startDate}T${r.startTime || employee.workStart}`,
        endAt: `${r.endDate}T${r.endTime || employee.workEnd}`,
      });
    }
    if (items.length !== rows.length) continue;
    items.sort((a, b) => a.startAt.localeCompare(b.startAt));

    const preview = await api(server, "POST", "/api/leave-requests/preview", { employeeId: employee.id, items });
    preview.items.forEach((p, i) => p.error && errors.push(`${where}: ${items[i].startAt.replace("T", " ")} — ${p.error}`));
    const existing = preview.warnings.filter((w) => w.code === "overlap_existing");
    if (existing.length > 0) errors.push(`${where}: 이미 프로그램에 있는 휴가원과 겹침 (이미 넣은 것이면 이 행들을 지우세요) — ${existing.map((w) => w.message).join(" / ")}`);
    const overlapItems = preview.warnings.filter((w) => w.code === "overlap_items").length;
    if (overlapItems > 0) errors.push(`${where}: 항목끼리 시간이 겹침 ${overlapItems}곳 (같은 날짜가 여러 행인지 확인)`);

    // 엑셀 사용량과 비교 ("1d 2h" 또는 "연가 4d, 병가 1d")
    const day = dayMinutesOf(employee);
    const label = (id) => leaveTypeLabel(leaveTypes.find((t) => t.id === id));
    const excel = rows[0].total;
    if (excel) {
      const computed = new Map(preview.totalsByType.map((t) => [label(t.leaveTypeId), t.minutes]));
      const parts = excel.split(",").map((s) => s.trim());
      const expected = parts.every((p) => /^\S+\s+\d/.test(p) && !/^\d/.test(p))
        ? parts.map((p) => [p.split(/\s+/)[0], amountOf(p.slice(p.indexOf(" ") + 1))])
        : [[null, amountOf(excel)]];
      for (const [type, amount] of expected) {
        if (!amount) continue;
        const want = amount.days * day + amount.minutes;
        const got = type === null ? [...computed.values()].reduce((a, b) => a + b, 0) : (computed.get(type) ?? 0);
        if (want !== got) {
          notices.push(`${where} ${employee.name}: 엑셀 ${type ? `${type} ${amountText(amount)}` : excel} ≠ 계산 ${formatLeaveMinutes(got, day)}`);
        }
      }
    }
    requests.push({ where, employee, items, reason: rows[0].reason || "개인일정", firstStart: items[0].startAt });
  }

  // 부여
  const grants = [];
  for (const g of review.grants) {
    const where = `부여 ${g.excelRow}행`;
    if (g.flag) errors.push(`${where}: 확인 필요 — ${g.flag}`);
    if (!g.date) errors.push(`${where}: 부여일을 읽을 수 없음`);
    const employee = employeeOf(g.name, where);
    if (!employee) continue;
    const type = typeOf(g.type, employee, where);
    if (!type || !g.date) continue;
    const minutes = g.days * dayMinutesOf(employee) + Math.round(g.hours * 60);
    const existing = await api(server, "GET", `/api/grants?employeeId=${employee.id}&leaveTypeId=${type.id}`);
    if (existing.some((e) => e.grantDate === g.date && e.minutes === minutes)) {
      errors.push(`${where}: 같은 부여가 이미 프로그램에 있음 (이미 넣은 것이면 이 행을 지우세요)`);
    }
    grants.push({ where, employee, body: { employeeId: employee.id, leaveTypeId: type.id, grantDate: g.date, days: g.days, hours: g.hours, note: g.note } });
  }

  console.log(`휴가원 ${requests.length}건(항목 ${requests.reduce((n, r) => n + r.items.length, 0)}개), 부여 ${grants.length}건을 읽었습니다.`);
  if (notices.length > 0) {
    console.log(`\n[알림] 엑셀 사용량과 프로그램 계산이 다른 휴가원 ${notices.length}건 (시각·날짜를 확인하세요. 그대로 두어도 불러올 수 있음)`);
    notices.forEach((n) => console.log(`  - ${n}`));
  }
  if (errors.length > 0) {
    console.log(`\n[오류] ${errors.length}건 — 고치기 전에는 불러오지 않습니다.`);
    errors.forEach((e) => console.log(`  - ${e}`));
  } else {
    console.log("\n오류 없음.");
  }
  return { ok: errors.length === 0, requests, grants };
}

async function importAll(path, server) {
  const result = await check(path, server);
  if (!result.ok) process.exit(1);

  const backup = await api(server, "POST", "/api/backups");
  console.log(`\n불러오기 전 백업: ${backup.name}`);

  const done = { grants: 0, requests: 0 };
  try {
    for (const g of [...result.grants].sort((a, b) => a.body.grantDate.localeCompare(b.body.grantDate))) {
      await api(server, "POST", "/api/grants", g.body);
      done.grants++;
    }
    for (const r of [...result.requests].sort((a, b) => a.firstStart.localeCompare(b.firstStart))) {
      await api(server, "POST", "/api/leave-requests", {
        employeeId: r.employee.id,
        items: r.items,
        reason: r.reason,
        emergencyContact: r.employee.emergencyContact || "-",
        handoverNote: "",
      }).catch((e) => {
        throw new Error(`${r.where}: ${e.message}`);
      });
      done.requests++;
    }
  } catch (e) {
    console.error(`\n중간에 멈췄습니다: ${e.message}`);
    console.error(`  이미 넣은 것: 부여 ${done.grants}건, 휴가원 ${done.requests}건. 위 백업으로 되돌리거나, check 로 남은 것을 확인하세요.`);
    process.exit(1);
  }
  console.log(`\n불러왔습니다: 부여 ${done.grants}건, 휴가원 ${done.requests}건`);
  console.log("잔여 현황에서 엑셀 관리대장의 마지막 잔여와 맞는지 확인하세요 (예전 연도에서 넘어온 양은 '기존 잔여량'으로 넣어야 맞음).");
}

const { command, options, positional } = parseArgs(process.argv.slice(2));
if (command === "review") await review(options);
else if (command === "check" || command === "import") {
  if (!positional[0] || !options.server) fail(`사용: node scripts/import-ledger.mjs ${command} 검토.xlsx --server http://출결PC주소:8080`);
  if (command === "check") process.exit((await check(positional[0], options.server)).ok ? 0 : 1);
  await importAll(positional[0], options.server);
} else {
  fail("사용: node scripts/import-ledger.mjs review | check | import  (자세한 사용법은 파일 맨 위 주석)");
}
