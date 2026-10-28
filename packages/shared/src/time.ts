// 날짜·시각은 시간대 없는 로컬 문자열로 다룬다.
//   날짜: "YYYY-MM-DD", 시각: "HH:MM", 일시: "YYYY-MM-DDTHH:MM"
// 서버와 브라우저가 같은 사무실 시간대(KST)이므로 Date의 시간대 변환을 피하기 위함.

/** 근무시간을 알 수 없을 때의 1일 (8시간) */
export const LEAVE_DAY_MINUTES = 480;
/** 휴가 입력 단위 (10분) */
export const LEAVE_STEP_MINUTES = 10;
/** 점심시간 12:00~13:00 (휴가 시간에서 제외) */
export const LUNCH = { start: 12 * 60, end: 13 * 60 } as const;

export const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 입력할 수 있는 날짜의 연도 범위 (오타로 0026년·9999년 같은 날짜가 들어가는 것을 막음) */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function isDateString(value: string): boolean {
  try {
    dateToDayNumber(value);
    return true;
  } catch {
    return false;
  }
}

export function isTimeString(value: string): boolean {
  return TIME_RE.test(value);
}

export function isDateTimeString(value: string): boolean {
  try {
    parseDateTime(value);
    return true;
  } catch {
    return false;
  }
}

export function parseTime(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new Error(`잘못된 시각: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → UTC 기준 일수 (요일·날짜 계산용) */
export function dateToDayNumber(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`잘못된 날짜: ${date}`);
  // Date.UTC 는 0~99년을 1900~1999년으로 바꾸므로 setUTCFullYear 사용
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    throw new Error(`잘못된 날짜: ${date}`);
  }
  return d.getTime() / MS_PER_DAY;
}

export function dayNumberToDate(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dayNumberToDate(dateToDayNumber(date) + days);
}

/** 0=일요일 … 6=토요일 */
export function weekdayOf(date: string): number {
  return new Date(dateToDayNumber(date) * MS_PER_DAY).getUTCDay();
}

/** 해당 날짜가 속한 주의 월요일 */
export function startOfWeekMonday(date: string): string {
  const wd = weekdayOf(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** 날짜·일시 문자열의 연도가 MIN_YEAR~MAX_YEAR 안인지 */
export function isInYearRange(value: string): boolean {
  const y = yearOf(value);
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

/** 연도 범위를 벗어났을 때 메시지 */
export const YEAR_RANGE_MESSAGE = `${MIN_YEAR}~${MAX_YEAR}년 사이의 날짜를 입력하세요.`;

export function parseDateTime(value: string): { date: string; minutes: number } {
  const m = DATETIME_RE.exec(value);
  if (!m) throw new Error(`잘못된 일시: ${value}`);
  const date = m[1]!;
  dateToDayNumber(date);
  return { date, minutes: parseTime(m[2]!) };
}

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** 로컬 시각 기준 오늘 날짜 "YYYY-MM-DD" */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 로컬 시각 기준 "YYYY-MM-DD HH:MM:SS" (기록용) */
export function localTimestamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localToday(now)} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** 출력 양식용 날짜 "2026.10.01." */
export function formatDotDate(date: string): string {
  return `${date.slice(0, 4)}.${date.slice(5, 7)}.${date.slice(8, 10)}.`;
}

/**
 * 출력 양식용 기간.
 * 같은 날: "2026.10.01. 10:00 ~ 19:00", 여러 날: "2026.10.01. 10:00 ~ 2026.10.03. 19:00"
 */
export function formatPeriod(startAt: string, endAt: string): string {
  const s = parseDateTime(startAt);
  const e = parseDateTime(endAt);
  const left = `${formatDotDate(s.date)} ${formatTime(s.minutes)}`;
  return s.date === e.date
    ? `${left} ~ ${formatTime(e.minutes)}`
    : `${left} ~ ${formatDotDate(e.date)} ${formatTime(e.minutes)}`;
}
