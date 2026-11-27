// 구글 캘린더 '대한민국의 휴일' 공개 ICS에서 공휴일을 가져와 자동 등록. 서버를 켤 때 한 번만 실행.
// 이미 그 날짜에 공휴일 행이 있으면(지운 자동 등록분 포함, 이름이 달라도) 건너뛰고, 구글에서 사라진 날은 지우지 않음.
import { addDays, formatDotDate, isDateString, type Holiday } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { execute, queryAll, queryOne, transaction } from "../db/index.ts";
import { writeAudit } from "./audit.ts";
import { holidayFromRow } from "./queries.ts";
import { recalcFutureRequests } from "./recalc.ts";

const GOOGLE_HOLIDAY_ICS_URL =
  "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";
const FETCH_TIMEOUT_MS = 10_000;
/** holidayInput 의 이름 최대 길이 */
const NAME_MAX = 50;

interface IcsHoliday {
  date: string;
  name: string;
}

const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** "20260101" (뒤에 시각이 붙어도 됨) → "2026-01-01". 틀리면 null */
function icsDate(value: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? "");
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  return date && isDateString(date) ? date : null;
}

/**
 * ICS 글에서 설명 첫 줄이 "공휴일"인 일정만 꺼냄 (기념일·취소된 일정 제외).
 * 여러 날 일정은 하루씩 나누고(DTEND 는 그날 제외), 같은 날 여러 개면 이름을 "·"로 이어 하나로. 날짜순.
 */
export function parseGoogleHolidayIcs(text: string): IcsHoliday[] {
  // 공백·탭으로 시작하는 줄은 앞 줄에 이어짐 (RFC 5545)
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const byDate = new Map<string, string[]>();
  let ev: Record<string, string> | null = null;

  const addEvent = (e: Record<string, string>) => {
    if ((e.STATUS ?? "").toUpperCase() === "CANCELLED") return;
    if (unescapeText(e.DESCRIPTION ?? "").split("\n")[0]!.trim() !== "공휴일") return;
    const name = unescapeText(e.SUMMARY ?? "").trim().slice(0, NAME_MAX);
    const start = icsDate(e.DTSTART);
    if (!name || !start) return;
    const endDate = icsDate(e.DTEND);
    const end = endDate && endDate > start ? endDate : addDays(start, 1);
    for (let d = start; d < end; d = addDays(d, 1)) {
      const names = byDate.get(d) ?? [];
      if (!names.includes(name)) names.push(name);
      byDate.set(d, names);
    }
  };

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      ev = {};
    } else if (line === "END:VEVENT") {
      if (ev) addEvent(ev);
      ev = null;
    } else if (ev) {
      const colon = line.indexOf(":");
      if (colon > 0) ev[line.slice(0, colon).split(";")[0]!.toUpperCase()] = line.slice(colon + 1);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, names]) => ({ date, name: names.join("·").slice(0, NAME_MAX) }));
}

/**
 * 올해 1월 1일 이후 공휴일 중, 그 날짜에 공휴일 행이 하나도 없는 날만 자동 등록분으로 추가.
 * 추가한 것이 있으면 아직 지나지 않은 휴가원을 한 번 다시 계산. 추가한 공휴일을 돌려줌.
 */
export function importGoogleHolidays(ctx: AppContext, list: IcsHoliday[]): Holiday[] {
  const { db } = ctx;
  const from = `${ctx.today().slice(0, 4)}-01-01`;
  return transaction(db, () => {
    const taken = new Set(
      queryAll(db, "SELECT DISTINCT date FROM holidays WHERE kind = 'public' AND date >= ?", [from]).map((r) =>
        String(r.date),
      ),
    );
    const added: Holiday[] = [];
    for (const h of list) {
      if (h.date < from || taken.has(h.date)) continue;
      const id = execute(
        db,
        "INSERT INTO holidays (date, name, kind, source, active, created_at) VALUES (?, ?, 'public', 'auto', 1, ?)",
        [h.date, h.name, ctx.now()],
      ).lastInsertRowid;
      const holiday = holidayFromRow(queryOne(db, "SELECT * FROM holidays WHERE id = ?", [id])!);
      writeAudit(
        db,
        "",
        {
          entity: "holiday",
          entityId: id,
          action: "create",
          summary: `공휴일 ${formatDotDate(h.date)} ${h.name} 추가 (구글 캘린더)`,
          after: holiday,
        },
        ctx.now(),
      );
      taken.add(h.date);
      added.push(holiday);
    }
    if (added.length > 0) {
      recalcFutureRequests(db, ctx.today(), "", `구글 캘린더 공휴일 ${added.length}건 추가`, ctx.now());
    }
    return added;
  });
}

/** 서버 시작 때 한 번: 받아서 읽고 추가. 실패해도 서버는 그대로 (기록만 남김) */
export async function importGoogleHolidaysOnStart(ctx: AppContext): Promise<void> {
  try {
    const res = await fetch(GOOGLE_HOLIDAY_ICS_URL, {
      headers: { "User-Agent": `leave-flow/${ctx.version}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`구글 응답 ${res.status}`);
    const list = parseGoogleHolidayIcs(await res.text());
    if (list.length === 0) throw new Error("받은 파일에서 공휴일을 하나도 읽지 못했습니다.");
    const added = importGoogleHolidays(ctx, list);
    console.log(
      `[holiday] 구글 캘린더 공휴일 ${list.length}건 확인, ${added.length}건 추가` +
        (added.length ? `: ${added.map((h) => `${h.date} ${h.name}`).join(", ")}` : ""),
    );
  } catch (err) {
    console.error(`[holiday] 구글 캘린더 공휴일 가져오기 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}
