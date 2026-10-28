// launcher 의 상태(state.json) 전환 규칙과 작은 도우미. 의존성 없음 (전용 node.exe 로 바로 실행).
// launcher.mjs 와 테스트(scripts/launcher.test.mjs)에서 사용한다.
//
// state.json 예:
// {
//   "current": "0.2.0",          실행할 버전 (versions/0.2.0/server.mjs)
//   "previous": "0.1.0",         되돌릴 버전
//   "pending": null,             서버가 받아 둔 새 버전 (종료 코드 75 뒤 current 로)
//   "trial": false,              새 버전 시험 기동 중 (정상 확인 전)
//   "failedVersion": null,       정상 기동하지 않아 되돌린 버전 (자동 업데이트에서 건너뜀)
//   "lastUpdateError": null,     { version, at, message }
//   "updatedAt": "2026-10-19 12:00:00",
//   "preUpdateBackup": null      업데이트 직전 DB 백업 (되돌릴 때 복구)
// }
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 업데이트 적용 (서버가 pending 을 기록하고 종료) */
export const EXIT_UPDATE = 75;
/** 그냥 재시작 (백업 복구) */
export const EXIT_RESTART = 76;
/** 새 버전이 이 시간 안에 /api/health 에 새 버전으로 답해야 함 */
export const HEALTH_TIMEOUT_MS = 60_000;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
/** 이만큼 잘 돌다가 죽었으면 재시작 대기 시간을 처음부터 */
export const STABLE_MS = 10 * 60_000;
export const LOG_KEEP_DAYS = 30;
export const DEFAULT_PORT = 8080;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function isVersion(name) {
  return typeof name === "string" && VERSION_RE.test(name);
}

/** 앞의 v 는 무시, 시험판(-rc.1)은 정식판보다 낮음 (서버 updater.ts 와 같은 규칙) */
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v).trim().replace(/^v/i, "");
    const dash = s.indexOf("-");
    const core = dash < 0 ? s : s.slice(0, dash);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: dash < 0 ? null : s.slice(dash + 1) };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function emptyState(version) {
  return {
    current: version,
    previous: null,
    pending: null,
    trial: false,
    failedVersion: null,
    lastUpdateError: null,
    updatedAt: null,
    preUpdateBackup: null,
  };
}

/**
 * 읽은 state.json(없으면 null) + versions/ 에 설치된 버전 → 실행할 상태.
 * state.json 이 없거나 current 폴더가 없으면 이전 버전 또는 가장 높은 버전으로.
 * 반환: { state, changed } (설치된 버전이 없으면 null)
 */
export function resolveState(raw, installed) {
  const versions = installed.filter(isVersion).sort(compareVersions);
  if (versions.length === 0) return null;
  const highest = versions[versions.length - 1];
  if (!raw || typeof raw !== "object" || !isVersion(raw.current)) {
    return { state: emptyState(highest), changed: true };
  }
  let state = { ...emptyState(raw.current), ...raw };
  let changed = false;
  if (!versions.includes(state.current)) {
    const fallback = state.previous && versions.includes(state.previous) ? state.previous : highest;
    state = { ...state, current: fallback, previous: null, trial: false };
    changed = true;
  }
  if (state.previous && !versions.includes(state.previous)) {
    state = { ...state, previous: null };
    changed = true;
  }
  if (state.pending && (!versions.includes(state.pending) || state.pending === state.current)) {
    state = { ...state, pending: null };
    changed = true;
  }
  return { state, changed };
}

/** 종료 코드 75: pending 을 current 로 (이전 값은 previous) 바꾸고 시험 기동. 바꿀 것이 없으면 null */
export function beginSwitch(state) {
  if (!state.pending || state.pending === state.current) return null;
  return { ...state, previous: state.current, current: state.pending, pending: null, trial: true };
}

/** 시험 기동 성공. 그보다 낮거나 같은 실패 기록은 지움 */
export function commitSwitch(state, at) {
  const clearFailure = !!state.failedVersion && compareVersions(state.current, state.failedVersion) >= 0;
  return {
    ...state,
    trial: false,
    updatedAt: at,
    preUpdateBackup: null,
    ...(clearFailure ? { failedVersion: null, lastUpdateError: null } : {}),
  };
}

/** 시험 기동 실패: previous 로 되돌리고 실패 기록 (같은 버전을 자동으로 다시 시도하지 않게) */
export function rollbackSwitch(state, message, at) {
  if (!state.previous) return { ...state, trial: false };
  return {
    ...state,
    current: state.previous,
    previous: null,
    pending: null,
    trial: false,
    failedVersion: state.current,
    lastUpdateError: { version: state.current, at, message },
    preUpdateBackup: null,
  };
}

/** 서버 종료 코드 → 할 일: stop(launcher 도 종료) / update / restart / crash(잠시 뒤 재시작) */
export function exitAction(code) {
  if (code === 0) return "stop";
  if (code === EXIT_UPDATE) return "update";
  if (code === EXIT_RESTART) return "restart";
  return "crash";
}

/** 비정상 종료 뒤 기다릴 시간: 2초부터 두 배씩 60초까지, 10분 이상 잘 돌았으면 다시 2초 */
export function nextBackoff(prevMs, uptimeMs) {
  if (!prevMs || uptimeMs >= STABLE_MS) return BACKOFF_MIN_MS;
  return Math.min(prevMs * 2, BACKOFF_MAX_MS);
}

/** /api/health 응답이 그 버전의 정상 응답인지 */
export function isHealthy(body, version) {
  return !!body && body.ok === true && body.version === version;
}

/** 지울 버전 폴더: current·previous·pending 이 아닌 버전과 풀다 만 폴더(.partial) */
export function versionsToPrune(names, state) {
  const keep = new Set([state.current, state.previous, state.pending].filter(Boolean));
  return names.filter((n) => (isVersion(n) && !keep.has(n)) || /\.partial$/.test(n));
}

/* ---------- 날짜·로그 ---------- */

const pad = (n) => String(n).padStart(2, "0");

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTimestamp(d = new Date()) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "YYYY-MM-DD" ± days */
export function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** logs/server-YYYYMMDD.log */
export function logFileName(date) {
  return `server-${date.replaceAll("-", "")}.log`;
}

/** 보관 기간이 지난 로그 파일 이름 */
export function expiredLogs(names, today) {
  const cutoff = shiftDate(today, -LOG_KEEP_DAYS).replaceAll("-", "");
  return names.filter((n) => {
    const m = /^server-(\d{8})\.log$/.exec(n);
    return !!m && m[1] < cutoff;
  });
}

/* ---------- 파일 ---------- */

/** JSON 파일 읽기 (없거나 깨졌으면 null, BOM 무시) */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Windows 에서 다른 프로세스(서버·백신·검색 색인)가 대상 파일을 잠깐 열고 있으면 나는 오류 */
const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 30;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * renameSync + 잠깐 열린 파일이면 다시 시도 (모두 약 5초).
 * Windows 는 다른 프로세스가 읽는 중인 파일 위로 바꿔 끼우지 못하고 EPERM 을 냄.
 */
export function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (i >= RENAME_RETRIES || !SHARING_ERRORS.has(err?.code)) throw err;
      sleepSync(Math.min(25 * (i + 1), 200));
    }
  }
}

/** 임시 파일에 쓴 뒤 바꿔 끼움 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameWithRetry(tmp, file);
}

/** 서버 주소·포트·데이터 폴더 (서버 config.ts 와 같은 규칙: 환경 변수 > config.json > 기본값) */
export function serverSettings(home, env = process.env) {
  const config = readJson(path.join(home, "config.json")) ?? {};
  const host = String(env.LEAVE_FLOW_HOST ?? config.host ?? "0.0.0.0").trim();
  const port = Number(env.LEAVE_FLOW_PORT ?? config.port ?? DEFAULT_PORT);
  const dataDir = path.resolve(home, env.LEAVE_FLOW_DATA_DIR ?? config.dataDir ?? "data");
  return { host, port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT, dataDir };
}

/** 서버 상태 확인 주소. 모든 주소에서 받으면(0.0.0.0, ::) 127.0.0.1, IPv6 주소는 [ ] 로 감쌈 */
export function healthUrl({ host, port }) {
  let h = String(host ?? "").trim();
  if (["", "0.0.0.0", "::", "[::]"].includes(h)) h = "127.0.0.1";
  else if (h.includes(":") && !h.startsWith("[")) h = `[${h}]`;
  return `http://${h}:${port}/api/health`;
}
