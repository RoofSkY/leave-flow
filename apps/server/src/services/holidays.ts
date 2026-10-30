import Holidays from "date-holidays";
import { addDays, yearOf, type RecalcChange } from "@leave-flow/shared";
import type { AppContext } from "../context.ts";
import { execute, transaction, type Db } from "../db/index.ts";
import { writeAudit } from "./audit.ts";
import { recalcFutureRequests } from "./recalc.ts";

const MS_PER_DAY = 86_400_000;
/** 새해가 범위에 들어오도록 주기적으로 다시 확인 */
const RECHECK_MS = 6 * 60 * 60 * 1000;

const korea = new Holidays("KR");

interface PublicHolidayDay {
  date: string;
  name: string;
}

/**
 * date-holidays(KR)의 법정공휴일(type = public)을 날짜별로 펼친 목록.
 * - start/end 는 한국 자정 기준 Date 라 서버 시간대에 따라 날짜가 달라질 수 있으므로,
 *   한국 시각 문자열인 `date`를 시작일로 쓰고 일수만 start~end(끝 미포함)로 계산한다.
 * - 라이브러리 버그: `설날`(korean 01-0-01 P3D)은 당일~다음다음날로 하루 밀려 있음 → 전날·당일·다음날로 보정.
 *   추석과 대체공휴일은 라이브러리 값 그대로 사용.
 */
export function koreanPublicHolidays(year: number): PublicHolidayDay[] {
  const out: PublicHolidayDay[] = [];
  for (const h of korea.getHolidays(year)) {
    if (h.type !== "public") continue;
    const first = h.date.slice(0, 10);
    if (h.name === "설날" && !h.substitute) {
      for (const d of [-1, 0, 1]) out.push({ date: addDays(first, d), name: h.name });
      continue;
    }
    const days = Math.max(1, Math.round((h.end.getTime() - h.start.getTime()) / MS_PER_DAY));
    for (let i = 0; i < days; i++) out.push({ date: addDays(first, i), name: h.name });
  }
  return out;
}

/**
 * date-holidays(KR)로 years 범위의 법정공휴일을 holidays 테이블에 source='auto', kind='public' 로 등록.
 * 이미 있는 (date, kind, name)은 건드리지 않음 (관리자가 지운 자동 등록분 active=0 은 되살리지 않음).
 * 반환: 새로 등록한 날 목록.
 */
export function insertAutoHolidays(db: Db, years: readonly number[], at: string): PublicHolidayDay[] {
  return transaction(db, () => {
    const added: PublicHolidayDay[] = [];
    for (const year of years) {
      for (const h of koreanPublicHolidays(year)) {
        // 이미 있는 (날짜, 구분, 이름)은 그대로 둠 — 관리자가 지운 자동 등록분(active = 0)도 되살리지 않음
        const r = execute(
          db,
          `INSERT INTO holidays (date, name, kind, source, active, created_at)
           VALUES (?, ?, 'public', 'auto', 1, ?)
           ON CONFLICT (date, kind, name) DO NOTHING`,
          [h.date, h.name, at],
        );
        if (r.changes > 0) added.push(h);
      }
    }
    return added;
  });
}

/** 자동 등록 범위: 올해 기준 config.holidayYearsBefore ~ holidayYearsAfter */
function holidaySyncYears(ctx: AppContext): number[] {
  const year = yearOf(ctx.today());
  const years: number[] = [];
  for (let y = year - ctx.config.holidayYearsBefore; y <= year + ctx.config.holidayYearsAfter; y++) years.push(y);
  return years;
}

/**
 * 법정공휴일 자동 등록 + (새로 등록된 것이 있으면) 변경 이력 기록과 아직 지나지 않은 휴가원 재계산.
 * 서버 시작·주기 확인과 관리 화면의 "다시 불러오기"가 함께 사용.
 */
export function runHolidaySync(ctx: AppContext, ip: string): { added: number; recalculated: RecalcChange[] } {
  const years = holidaySyncYears(ctx);
  return transaction(ctx.db, () => {
    const added = insertAutoHolidays(ctx.db, years, ctx.now());
    if (added.length === 0) return { added: 0, recalculated: [] };
    writeAudit(
      ctx.db,
      ip,
      {
        entity: "holiday",
        action: "create",
        summary: `법정공휴일 자동 등록 ${added.length}건 (${years[0]}~${years[years.length - 1]}년)`,
        after: { years, holidays: added.map((h) => `${h.date} ${h.name}`) },
      },
      ctx.now(),
    );
    const recalculated = recalcFutureRequests(ctx.db, ctx.today(), ip, "법정공휴일 자동 등록", ctx.now());
    return { added: added.length, recalculated };
  });
}

/** 서버 시작 시 + 6시간마다 자동 등록. 반환: 타이머를 정리하는 함수 */
export function startHolidaySync(ctx: AppContext): () => void {
  const run = () => {
    try {
      runHolidaySync(ctx, "system");
    } catch (err) {
      console.error("법정공휴일 자동 등록에 실패했습니다.", err);
    }
  };
  run();
  const timer = setInterval(run, RECHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
