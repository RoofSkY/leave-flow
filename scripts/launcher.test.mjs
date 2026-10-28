import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  STABLE_MS,
  beginSwitch,
  commitSwitch,
  compareVersions,
  emptyState,
  exitAction,
  expiredLogs,
  healthUrl,
  isHealthy,
  localDate,
  logFileName,
  nextBackoff,
  readJson,
  resolveState,
  rollbackSwitch,
  serverSettings,
  versionsToPrune,
  writeJsonAtomic,
} from "../launcher/state.mjs";

const launcherDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../launcher");
const homes = [];
const tmpHome = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "leave-flow-launcher-"));
  homes.push(home);
  return home;
};

// 테스트마다 만든 임시 설치 폴더 정리 (실패 원인은 runLauncher 가 오류 메시지에 로그를 붙여 둠)
afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 잠겨 있으면 남겨 둠
    }
  }
});

/** 다른 프로세스가 파일을 ms 동안 열어 둠 (서버·백신이 state.json 을 읽는 상황). 열린 뒤 resolve */
async function holdOpen(file, ms) {
  const script =
    "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('ready');setTimeout(()=>fs.closeSync(fd),Number(process.argv[2]))";
  const child = spawn(process.execPath, ["-e", script, file, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return { done };
}

describe("launcher 상태 전환", () => {
  it("state.json 이 없으면 가장 높은 설치 버전으로 만듦", () => {
    expect(resolveState(null, ["0.1.0", "0.10.0", "0.9.0", "tmp", "0.2.0.partial"])).toEqual({
      state: emptyState("0.10.0"),
      changed: true,
    });
    expect(resolveState(null, [])).toBeNull();
  });

  it("current 폴더가 없으면 previous, 그것도 없으면 가장 높은 버전", () => {
    const raw = { ...emptyState("0.3.0"), previous: "0.2.0" };
    expect(resolveState(raw, ["0.1.0", "0.2.0"])?.state).toMatchObject({ current: "0.2.0", previous: null });
    expect(resolveState(raw, ["0.1.0"])?.state.current).toBe("0.1.0");
    const ok = resolveState({ ...emptyState("0.1.0"), pending: "0.2.0" }, ["0.1.0", "0.2.0"]);
    expect(ok).toEqual({ state: { ...emptyState("0.1.0"), pending: "0.2.0" }, changed: false });
    // 폴더가 없는 pending 은 지움
    expect(resolveState({ ...emptyState("0.1.0"), pending: "0.2.0" }, ["0.1.0"])?.state.pending).toBeNull();
  });

  it("업데이트: pending → current 시험 기동 → 확정", () => {
    const start = { ...emptyState("0.1.0"), pending: "0.2.0", preUpdateBackup: "b.db" };
    const trial = beginSwitch(start);
    expect(trial).toMatchObject({ current: "0.2.0", previous: "0.1.0", pending: null, trial: true });
    const done = commitSwitch(trial, "2026-10-19 12:00:00");
    expect(done).toMatchObject({ current: "0.2.0", previous: "0.1.0", trial: false, updatedAt: "2026-10-19 12:00:00" });
    expect(done.preUpdateBackup).toBeNull();
    expect(beginSwitch(emptyState("0.1.0"))).toBeNull();
  });

  it("되돌림: previous 로, 실패 버전 기록 → 더 높은 버전이 성공하면 실패 기록 지움", () => {
    const trial = beginSwitch({ ...emptyState("0.1.0"), pending: "0.2.0" });
    const back = rollbackSwitch(trial, "응답 없음", "2026-10-19 12:01:00");
    expect(back).toMatchObject({
      current: "0.1.0",
      previous: null,
      trial: false,
      failedVersion: "0.2.0",
      lastUpdateError: { version: "0.2.0", at: "2026-10-19 12:01:00", message: "응답 없음" },
    });
    const later = commitSwitch(beginSwitch({ ...back, pending: "0.2.1" }), "x");
    expect(later).toMatchObject({ current: "0.2.1", failedVersion: null, lastUpdateError: null });
    // 되돌릴 버전이 없으면 시험만 끝냄
    expect(rollbackSwitch({ ...emptyState("0.1.0"), trial: true }, "x", "y")).toMatchObject({
      current: "0.1.0",
      trial: false,
    });
  });

  it("종료 코드와 재시작 대기", () => {
    expect([0, 75, 76, 1, 137].map(exitAction)).toEqual(["stop", "update", "restart", "crash", "crash"]);
    expect(nextBackoff(0, 0)).toBe(2_000);
    expect(nextBackoff(2_000, 1_000)).toBe(4_000);
    expect(nextBackoff(32_000, 1_000)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(BACKOFF_MAX_MS, 1_000)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(BACKOFF_MAX_MS, STABLE_MS)).toBe(2_000);
  });

  it("버전 비교·health·정리 대상", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(isHealthy({ ok: true, version: "0.2.0" }, "0.2.0")).toBe(true);
    expect(isHealthy({ ok: true, version: "0.1.0" }, "0.2.0")).toBe(false);
    expect(isHealthy(null, "0.2.0")).toBe(false);
    const state = { ...emptyState("0.3.0"), previous: "0.2.0" };
    expect(versionsToPrune(["0.1.0", "0.2.0", "0.3.0", "0.4.0.partial", "notes"], state)).toEqual([
      "0.1.0",
      "0.4.0.partial",
    ]);
  });

  it("로그 파일 이름과 30일 보관", () => {
    expect(logFileName("2026-10-19")).toBe("server-20261019.log");
    expect(
      expiredLogs(["server-20260918.log", "server-20260919.log", "server-20261019.log", "other.log"], "2026-10-19"),
    ).toEqual(["server-20260918.log"]);
  });

  it("state.json 읽고 쓰기, 주소·포트·데이터 폴더", () => {
    const home = tmpHome();
    const file = path.join(home, "state.json");
    expect(readJson(file)).toBeNull();
    writeJsonAtomic(file, emptyState("0.1.0"));
    expect(readJson(file)).toEqual(emptyState("0.1.0"));
    writeFileSync(path.join(home, "config.json"), `﻿${JSON.stringify({ port: 8123, dataDir: "db" })}`);
    expect(serverSettings(home, {})).toEqual({ host: "0.0.0.0", port: 8123, dataDir: path.join(home, "db") });
    expect(serverSettings(home, { LEAVE_FLOW_PORT: "8200" }).port).toBe(8200);
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ host: " 192.168.100.23 ", port: 8123 }));
    expect(serverSettings(home, {}).host).toBe("192.168.100.23");
    expect(serverSettings(home, { LEAVE_FLOW_HOST: "::" }).host).toBe("::");
  });

  it("상태 확인 주소: 모든 주소에서 받으면 127.0.0.1, 특정 주소면 그 주소", () => {
    for (const host of ["0.0.0.0", "", "::", "[::]", undefined]) {
      expect(healthUrl({ host, port: 8080 }), String(host)).toBe("http://127.0.0.1:8080/api/health");
    }
    expect(healthUrl({ host: "192.168.100.23", port: 8080 })).toBe("http://192.168.100.23:8080/api/health");
    expect(healthUrl({ host: "localhost", port: 8090 })).toBe("http://localhost:8090/api/health");
    expect(healthUrl({ host: "fe80::1", port: 8080 })).toBe("http://[fe80::1]:8080/api/health");
    expect(healthUrl({ host: "[::1]", port: 8080 })).toBe("http://[::1]:8080/api/health");
  });

  it("다른 프로세스가 state.json 을 잠깐 열고 있어도 저장 (Windows 에서는 바꿔 끼우기가 잠깐 실패함)", async () => {
    const home = tmpHome();
    const file = path.join(home, "state.json");
    writeJsonAtomic(file, emptyState("0.1.0"));
    const holder = await holdOpen(file, 400);
    writeJsonAtomic(file, { ...emptyState("0.1.0"), pending: "0.2.0" });
    await holder.done;
    expect(readJson(file)?.pending).toBe("0.2.0");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

/* ---------- 실제 launcher 실행 (가짜 서버) ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** behavior: healthy = health 응답 / update-once = 처음 한 번 pending 기록 후 75 / crash = 바로 종료 1 */
function fakeServer(version, behavior) {
  return `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const home = process.env.LEAVE_FLOW_HOME;
const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
const trigger = path.join(home, "trigger-update");
if (${JSON.stringify(behavior)} === "crash") process.exit(1);
if (${JSON.stringify(behavior)} === "update-once" && fs.existsSync(trigger)) {
  fs.rmSync(trigger);
  const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  state.pending = "0.2.0";
  state.preUpdateBackup = path.join(home, "backups", "pre-update.db");
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(state));
  process.exit(75);
}
http
  .createServer((req, res) => res.end(JSON.stringify({ ok: true, version: ${JSON.stringify(version)} })))
  .listen(config.port, config.host ?? "127.0.0.1", () => console.log("fake server ${version}"));
`;
}

async function setupHome(newBehavior, config = {}) {
  const home = tmpHome();
  const port = await freePort();
  for (const f of ["launcher.mjs", "state.mjs"]) copyFileSync(path.join(launcherDir, f), path.join(home, f));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ port, ...config }));
  for (const [v, behavior] of [
    ["0.1.0", "update-once"],
    ["0.2.0", newBehavior],
  ]) {
    mkdirSync(path.join(home, "versions", v), { recursive: true });
    writeFileSync(path.join(home, "versions", v, "server.mjs"), fakeServer(v, behavior));
  }
  writeJsonAtomic(path.join(home, "state.json"), emptyState("0.1.0"));
  mkdirSync(path.join(home, "backups"));
  writeFileSync(path.join(home, "backups", "pre-update.db"), "업데이트 전 DB");
  writeFileSync(path.join(home, "trigger-update"), "");
  return { home, port };
}

async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("시간 초과");
    await sleep(200);
  }
}

async function health(port, host = "127.0.0.1") {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return await res.json();
  } catch {
    return null;
  }
}

function readLog(home) {
  try {
    return readFileSync(path.join(home, "logs", logFileName(localDate())), "utf8");
  } catch {
    return "";
  }
}

async function runLauncher(home, check) {
  const proc = spawn(process.execPath, [path.join(home, "launcher.mjs")], { stdio: "ignore" });
  let exitCode = null;
  const exited = new Promise((resolve) => proc.on("exit", (code) => resolve((exitCode = code))));
  try {
    await check();
    // launcher 가 도중에 죽지 않았어야 함
    expect(exitCode).toBeNull();
  } catch (err) {
    // 임시 설치 폴더는 지우므로 원인을 알 수 있게 launcher 로그를 붙여 둠
    if (err instanceof Error) err.message += `\n--- launcher 종료 코드: ${exitCode}, 로그 ---\n${readLog(home)}`;
    throw err;
  } finally {
    proc.kill();
    await exited;
  }
}

/** state.json 을 계속 읽는 다른 프로세스 (서버의 시스템 정보 조회·백신·검색 색인 흉내) */
function startReader(file) {
  const script =
    "const fs=require('fs');const f=process.argv[1];setInterval(()=>{for(let i=0;i<5;i++){try{fs.readFileSync(f)}catch{}}},1)";
  const proc = spawn(process.execPath, ["-e", script, file], { stdio: "ignore" });
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  return async () => {
    proc.kill();
    await exited;
  };
}

describe("launcher 실행", () => {
  it("종료 코드 75 → 새 버전 시험 기동 → 정상이면 확정", { timeout: 40_000 }, async () => {
    const { home, port } = await setupHome("healthy");
    await runLauncher(home, async () => {
      const state = await waitFor(() => {
        const s = readJson(path.join(home, "state.json"));
        return s?.current === "0.2.0" && s.trial === false && s.updatedAt ? s : null;
      });
      expect(state).toMatchObject({ previous: "0.1.0", pending: null, failedVersion: null });
      expect(await health(port)).toEqual({ ok: true, version: "0.2.0" });
    });
    const log = readLog(home);
    expect(log).toContain("업데이트: 0.1.0 → 0.2.0");
    expect(log).toContain("fake server 0.2.0");
    // launcher 를 끄면 서버도 함께 꺼짐
    await sleep(500);
    expect(await health(port)).toBeNull();
  });

  it("새 버전이 바로 죽으면 이전 버전으로 되돌리고 업데이트 전 DB 백업 복구", { timeout: 40_000 }, async () => {
    const { home, port } = await setupHome("crash");
    await runLauncher(home, async () => {
      const state = await waitFor(() => {
        const s = readJson(path.join(home, "state.json"));
        return s?.failedVersion === "0.2.0" ? s : null;
      });
      expect(state).toMatchObject({ current: "0.1.0", previous: null, trial: false });
      expect(state.lastUpdateError.version).toBe("0.2.0");
      expect(readFileSync(path.join(home, "data", "restore-pending.db"), "utf8")).toBe("업데이트 전 DB");
      // 이전 버전이 다시 떠서 응답
      expect(await waitFor(async () => (await health(port))?.version === "0.1.0" || null)).toBe(true);
    });
    expect(existsSync(path.join(home, "versions", "0.2.0"))).toBe(true);
  });

  it("다른 프로세스가 state.json 을 계속 읽고 있어도 launcher 가 죽지 않고 확정", { timeout: 40_000 }, async () => {
    const { home, port } = await setupHome("healthy");
    const stopReader = startReader(path.join(home, "state.json"));
    try {
      await runLauncher(home, async () => {
        const state = await waitFor(() => {
          const s = readJson(path.join(home, "state.json"));
          return s?.current === "0.2.0" && s.trial === false && s.updatedAt ? s : null;
        });
        expect(state).toMatchObject({ previous: "0.1.0", pending: null, failedVersion: null });
        expect(await health(port)).toEqual({ ok: true, version: "0.2.0" });
      });
    } finally {
      await stopReader();
    }
    expect(readLog(home)).not.toContain("launcher 오류");
  });

  it("config.json 의 host 를 특정 주소로 정해도 그 주소로 상태를 확인해 확정", { timeout: 40_000 }, async () => {
    // 127.0.0.2 에서만 받는 서버 → 127.0.0.1 로 확인하면 60초 뒤 되돌림
    const host = "127.0.0.2";
    const { home, port } = await setupHome("healthy", { host });
    await runLauncher(home, async () => {
      const state = await waitFor(() => {
        const s = readJson(path.join(home, "state.json"));
        return s?.trial === false && s.updatedAt ? s : null;
      });
      expect(state).toMatchObject({ current: "0.2.0", previous: "0.1.0", failedVersion: null });
      expect(await health(port, host)).toEqual({ ok: true, version: "0.2.0" });
    });
  });
});
