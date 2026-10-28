// leave-flow launcher — Windows 서비스(NSSM) 또는 작업 스케줄러가 실행하는 프로그램.
// versions/<current>/server.mjs 를 띄우고 감시한다. 의존성 없음 (설치 폴더의 node\node.exe 로 실행).
//
// 서버 종료 코드
//   75  업데이트: state.json 의 pending 을 current 로 바꿔 새 버전을 시험 기동.
//       60초 안에 /api/health 가 새 버전으로 답하지 않으면 이전 버전으로 되돌리고(업데이트 전 DB 백업도 복구)
//       실패한 버전을 기록해 자동으로 다시 시도하지 않음.
//   76  재시작 (백업 복구)
//   0   정상 종료 → launcher 도 종료
//   그 밖  2초 → 60초까지 늘려 가며 재시작 (10분 이상 잘 돌았으면 다시 2초)
//
// 로그: logs/server-YYYYMMDD.log (30일 보관)
// 새 버전이 정상 기동하면 그 버전의 launcher.mjs·state.mjs 로 이 파일들을 바꿔 둔다 (다음 서비스 시작부터 적용).
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  HEALTH_TIMEOUT_MS,
  beginSwitch,
  commitSwitch,
  exitAction,
  expiredLogs,
  healthUrl,
  isHealthy,
  localDate,
  localTimestamp,
  logFileName,
  nextBackoff,
  readJson,
  resolveState,
  rollbackSwitch,
  serverSettings,
  versionsToPrune,
  writeJsonAtomic,
} from "./state.mjs";

const home = path.dirname(fileURLToPath(import.meta.url));
const versionsDir = path.join(home, "versions");
const logsDir = path.join(home, "logs");
const stateFile = path.join(home, "state.json");
/** state.json 저장에 실패했을 때 서버 실행 중 다시 저장해 보는 간격 */
const STATE_RETRY_MS = 10_000;

/* ---------- 로그 ---------- */

let logDay = null;
let logStream = null;

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function writeLog(chunk) {
  const today = localDate();
  if (today !== logDay) {
    logStream?.end();
    mkdirSync(logsDir, { recursive: true });
    logStream = createWriteStream(path.join(logsDir, logFileName(today)), { flags: "a" });
    logDay = today;
    for (const name of expiredLogs(listDir(logsDir), today)) rmSync(path.join(logsDir, name), { force: true });
  }
  logStream.write(chunk);
}

function log(message) {
  const line = `[${localTimestamp()}] [launcher] ${message}\n`;
  process.stdout.write(line);
  writeLog(line);
}

/* ---------- 상태 ---------- */

function installedVersions() {
  return listDir(versionsDir).filter((v) => existsSync(path.join(versionsDir, v, "server.mjs")));
}

/** 마지막 저장이 실패해 state.json 이 메모리의 상태보다 오래됨 (다음 반복에서 다시 저장) */
let stateDirty = false;

/** state.json 저장. 실패해도 launcher 를 끝내지 않고 서버를 계속 감시함 */
function safeSave(state) {
  try {
    writeJsonAtomic(stateFile, state);
    stateDirty = false;
  } catch (err) {
    stateDirty = true;
    log(`상태 파일을 저장하지 못했습니다: ${err?.message ?? err}`);
  }
}

function loadState() {
  const resolved = resolveState(readJson(stateFile), installedVersions());
  if (!resolved) return null;
  if (resolved.changed) safeSave(resolved.state);
  return resolved.state;
}

/** state.json 을 다시 읽음. 저장하지 못한 변경이 남아 있으면 파일이 오래됐으므로 메모리의 상태를 그대로 씀 */
function reloadState(state) {
  if (stateDirty) return state;
  return loadState() ?? state;
}

/** 서버가 실행 중일 때 저장하지 못한 상태를 다시 저장. 그사이 서버가 기록한 새 버전(pending)은 살림 */
function flushWhileRunning(state) {
  const disk = readJson(stateFile);
  const serverPending = disk?.pending && disk.pending !== state.current && !state.pending;
  safeSave(serverPending ? { ...state, pending: disk.pending, preUpdateBackup: disk.preUpdateBackup ?? null } : state);
}

/** 서버 종료를 기다림. 그동안 state.json 을 저장하지 못한 채라면 STATE_RETRY_MS 마다 다시 저장 */
async function waitForExit(run, state) {
  for (;;) {
    const code = await Promise.race([run.exited, sleep(STATE_RETRY_MS, null, { ref: false })]);
    if (code !== null) return code;
    if (stateDirty && !stopping) flushWhileRunning(state);
  }
}

/* ---------- 서버 프로세스 ---------- */

let child = null;
let stopping = false;

function startServer(version) {
  const entry = path.join(versionsDir, version, "server.mjs");
  log(`서버 시작: ${version}`);
  // detached 없이 실행 → launcher 가 강제 종료돼도 Windows 가 자식 프로세스를 함께 정리
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--enable-source-maps", entry], {
    cwd: home,
    env: { ...process.env, LEAVE_FLOW_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  proc.stdout.on("data", writeLog);
  proc.stderr.on("data", writeLog);
  const exited = new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    proc.on("error", (err) => {
      log(`서버를 실행하지 못했습니다: ${err.message}`);
      resolve(1);
    });
  });
  child = proc;
  return { proc, exited };
}

async function stopServer(run) {
  run.proc.kill();
  const done = await Promise.race([run.exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!done) {
    run.proc.kill("SIGKILL");
    await run.exited;
  }
}

/** 새 버전 시험: HEALTH_TIMEOUT_MS 안에 /api/health 가 그 버전으로 답하면 null, 아니면 실패 이유 */
async function trialCheck(version, run) {
  // config.json 의 host 를 특정 주소로 정했으면 127.0.0.1 로는 응답하지 않으므로 그 주소로 확인
  const url = healthUrl(serverSettings(home));
  let exitCode = null;
  run.exited.then((code) => (exitCode = code));
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    if (exitCode !== null) return `서버가 바로 종료되었습니다 (종료 코드 ${exitCode})`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok && isHealthy(await res.json(), version)) return null;
    } catch {
      // 아직 시작 중
    }
    await sleep(1_000);
  }
  return stopping ? null : `${HEALTH_TIMEOUT_MS / 1000}초 안에 정상 응답이 없었습니다`;
}

/** 되돌릴 때 업데이트 직전 DB 백업을 복구 대기 파일로 (이전 버전 서버가 시작하면서 바꿔 끼움) */
function restoreDbBeforeUpdate(backupFile) {
  if (!backupFile || !existsSync(backupFile)) return;
  const { dataDir } = serverSettings(home);
  const pending = path.join(dataDir, "restore-pending.db");
  try {
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(backupFile, `${pending}.partial`);
    renameSync(`${pending}.partial`, pending);
    log(`업데이트 전 DB 백업으로 되돌립니다: ${path.basename(backupFile)}`);
  } catch (err) {
    log(`업데이트 전 DB 백업을 복구하지 못했습니다: ${err.message}`);
  }
}

/** 정상 기동한 새 버전의 launcher 파일로 바꿔 둠 (다음 서비스 시작부터 적용) */
function adoptLauncherFiles(version) {
  for (const name of ["state.mjs", "launcher.mjs"]) {
    const src = path.join(versionsDir, version, name);
    const dst = path.join(home, name);
    if (!existsSync(src)) continue;
    const next = readFileSync(src);
    if (existsSync(dst) && readFileSync(dst).equals(next)) continue;
    try {
      writeFileSync(`${dst}.new`, next);
      renameSync(`${dst}.new`, dst);
      log(`${name} 파일을 새 버전으로 바꿨습니다. 다음 서비스 시작부터 적용됩니다.`);
    } catch (err) {
      log(`${name} 파일을 바꾸지 못했습니다: ${err.message}`);
    }
  }
}

function pruneVersions(state) {
  for (const name of versionsToPrune(listDir(versionsDir), state)) {
    try {
      rmSync(path.join(versionsDir, name), { recursive: true, force: true });
      log(`오래된 버전 폴더 삭제: ${name}`);
    } catch {
      // 다음에 다시 시도
    }
  }
}

/* ---------- 실행 ---------- */

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} 신호를 받아 서버와 함께 종료합니다.`);
  child?.kill();
  setTimeout(() => process.exit(0), 10_000).unref();
}

for (const sig of process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => shutdown(sig));
}
// launcher 가 어떤 이유로든 끝나면 서버도 함께 끝냄
process.on("exit", () => {
  if (child && child.exitCode === null) child.kill();
});

async function main() {
  let state = loadState();
  if (!state) {
    log(`${versionsDir} 에 설치된 버전이 없습니다. install.ps1 로 다시 설치하세요.`);
    return 1;
  }
  log(`launcher 시작 (설치 폴더: ${home}, 버전: ${state.current})`);
  let backoff = 0;

  while (!stopping) {
    // 지난번에 state.json 을 저장하지 못했으면 서버를 띄우기 전에 다시 저장
    if (stateDirty) safeSave(state);
    const startedAt = Date.now();
    const run = startServer(state.current);

    if (state.trial) {
      const failure = await trialCheck(state.current, run);
      if (stopping) break;
      if (failure === null) {
        state = commitSwitch(state, localTimestamp());
        safeSave(state);
        log(`새 버전 ${state.current} 정상 기동을 확인했습니다.`);
        adoptLauncherFiles(state.current);
        pruneVersions(state);
      } else {
        log(`새 버전 ${state.current}이(가) 정상 기동하지 않아 ${state.previous ?? "이전 버전"}(으)로 되돌립니다: ${failure}`);
        await stopServer(run);
        const backupFile = state.preUpdateBackup;
        const rolledBack = state.previous !== null;
        state = rollbackSwitch(state, failure, localTimestamp());
        safeSave(state);
        if (rolledBack) restoreDbBeforeUpdate(backupFile);
        continue;
      }
    }

    const code = await waitForExit(run, state);
    child = null;
    if (stopping) break;

    switch (exitAction(code)) {
      case "stop":
        log("서버가 정상 종료되어 launcher 도 종료합니다.");
        if (stateDirty) safeSave(state);
        return 0;
      case "update": {
        // 서버가 state.json 에 pending 을 기록하고 종료함
        const next = beginSwitch(loadState() ?? state);
        if (next) {
          state = next;
          safeSave(state);
          log(`업데이트: ${state.previous} → ${state.current}`);
        } else {
          state = reloadState(state);
          log("적용할 새 버전이 없어 그대로 다시 시작합니다.");
        }
        backoff = 0;
        break;
      }
      case "restart":
        log("재시작 요청을 받았습니다 (백업 복구).");
        state = reloadState(state);
        backoff = 0;
        break;
      default:
        backoff = nextBackoff(backoff, Date.now() - startedAt);
        log(`서버가 비정상 종료되었습니다 (종료 코드 ${code}). ${backoff / 1000}초 뒤 다시 시작합니다.`);
        await sleep(backoff);
        state = reloadState(state);
    }
  }
  if (stateDirty) safeSave(state);
  return 0;
}

main().then(
  (code) => {
    logStream?.end();
    process.exitCode = code;
    if (child && child.exitCode === null) child.kill();
    // 남은 타이머가 없으면 바로 끝남
    setTimeout(() => process.exit(code), 1_000).unref();
  },
  (err) => {
    // 로그 스트림은 비동기라서 바로 끝내면 마지막 줄(종료 이유)이 파일에 남지 않음
    // → 남은 로그를 마저 쓴 뒤 이 줄을 파일에 직접 덧붙이고 종료 (2초 안에 못 끝내면 그냥 덧붙이고 종료)
    const line = `[${localTimestamp()}] [launcher] launcher 오류: ${err?.stack ?? err}\n`;
    process.stdout.write(line);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        mkdirSync(logsDir, { recursive: true });
        appendFileSync(path.join(logsDir, logFileName(localDate())), line);
      } catch {
        // 기록하지 못해도 종료
      }
      process.exit(1);
    };
    setTimeout(finish, 2_000);
    if (logStream) logStream.end(finish);
    else finish();
  },
);
