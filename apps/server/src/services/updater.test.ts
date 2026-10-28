import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.ts";
import { queryAll } from "../db/index.ts";
import { createTestApp, testConfig } from "../testing.ts";
import { SYSTEM_KEYS, getValue } from "./settings.ts";
import {
  checkForUpdate,
  compareVersions,
  extractRelease,
  parseSha256,
  readLauncherState,
  recordUpdateOutcome,
  runScheduledUpdateCheck,
  safeEntryPath,
  startUpdateScheduler,
  updateCheckPeriodMs,
  writeLauncherState,
} from "./updater.ts";

/** 다른 프로세스가 파일을 ms 동안 열어 둠 (launcher·백신이 state.json 을 읽는 상황). 열린 뒤 resolve */
async function holdOpen(file: string, ms: number): Promise<{ done: Promise<void> }> {
  const script = "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('ready');setTimeout(()=>fs.closeSync(fd),Number(process.argv[2]))";
  const child = spawn(process.execPath, ["-e", script, file, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return { done };
}

describe("버전 비교", () => {
  it("숫자 단위로 비교하고 앞의 v 는 무시", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
    expect(compareVersions("0.1.0", "0.0.0-test")).toBe(1);
  });
});

describe("sha256 파일", () => {
  it("'<hex>  <이름>' 과 hex 만 있는 형식 모두", () => {
    const hex = "a".repeat(64);
    expect(parseSha256(`${hex}  leave-flow-0.2.0.zip\n`)).toBe(hex);
    expect(parseSha256(hex.toUpperCase())).toBe(hex);
    expect(parseSha256("없음")).toBeNull();
  });
});

describe("압축 해제 경로 검사", () => {
  it("상대 경로만 허용", () => {
    expect(safeEntryPath("web/index.html")).toBe("web/index.html");
    expect(safeEntryPath("./server.mjs")).toBe("server.mjs");
    expect(safeEntryPath("web\\assets\\a.js")).toBe("web/assets/a.js");
    for (const bad of ["/etc/passwd", "\\x", "C:/Windows/x", "c:x", "../x", "web/../../x", "a/b:stream", ""]) {
      expect(safeEntryPath(bad), bad).toBeNull();
    }
  });

  it("잘못된 경로가 하나라도 있으면 아무것도 쓰지 않음", () => {
    const home = testConfig().homeDir;
    const target = path.join(home, "versions", "0.2.0");
    const zip = zipSync({ "server.mjs": strToU8("x"), "../evil.txt": strToU8("x") });
    expect(() => extractRelease(zip, target)).toThrow(/올바르지 않은 경로/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(home, "versions", "evil.txt"))).toBe(false);
    expect(existsSync(path.join(home, "evil.txt"))).toBe(false);
  });

  it("server.mjs 가 없으면 실패, 있으면 폴더째 풀기", () => {
    const home = testConfig().homeDir;
    const target = path.join(home, "versions", "0.2.0");
    expect(() => extractRelease(zipSync({ "web/index.html": strToU8("x") }), target)).toThrow(/server\.mjs/);
    extractRelease(zipSync({ "server.mjs": strToU8("서버"), web: { "index.html": strToU8("화면") } }), target);
    expect(readFileSync(path.join(target, "server.mjs"), "utf8")).toBe("서버");
    expect(readFileSync(path.join(target, "web", "index.html"), "utf8")).toBe("화면");
    expect(existsSync(`${target}.partial`)).toBe(false);
  });
});

describe("state.json", () => {
  it("없으면 null, 쓴 값을 그대로 읽고, 원자적으로 씀", () => {
    const home = testConfig().homeDir;
    expect(readLauncherState(home)).toBeNull();
    writeLauncherState(home, { current: "0.1.0", previous: null, pending: "0.2.0" });
    expect(readLauncherState(home)).toEqual({ current: "0.1.0", previous: null, pending: "0.2.0" });
    expect(existsSync(path.join(home, "state.json.tmp"))).toBe(false);
  });

  it("다른 프로세스가 state.json 을 잠깐 열고 있어도 저장 (Windows 에서는 바꿔 끼우기가 잠깐 실패함)", async () => {
    const home = testConfig().homeDir;
    writeLauncherState(home, { current: "0.1.0", previous: null, pending: null });
    const holder = await holdOpen(path.join(home, "state.json"), 400);
    writeLauncherState(home, { current: "0.1.0", previous: null, pending: "0.2.0" });
    await holder.done;
    expect(readLauncherState(home)?.pending).toBe("0.2.0");
    expect(existsSync(path.join(home, "state.json.tmp"))).toBe(false);
  });
});

/* ---------- 확인 예약 ---------- */

const REPO = "office/leave-flow";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** GitHub 최신 릴리스 응답 흉내 (gate 가 있으면 그때까지 응답을 미룸). 반환: 요청한 주소 */
function stubGitHub(version: string, gate?: Promise<void>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (gate) await gate;
      if (url !== LATEST_URL) return new Response("", { status: 404 });
      return Response.json({
        tag_name: `v${version}`,
        assets: [
          { name: `leave-flow-${version}.zip`, browser_download_url: `https://dl.test/leave-flow-${version}.zip` },
          {
            name: `leave-flow-${version}.zip.sha256`,
            browser_download_url: `https://dl.test/leave-flow-${version}.zip.sha256`,
          },
        ],
      });
    }),
  );
  return calls;
}

async function scheduledApp(config: Partial<Config>) {
  const t = await createTestApp({ config: { updateRepo: REPO, ...config } });
  writeLauncherState(t.ctx.config.homeDir, { current: t.ctx.version, previous: null, pending: null });
  return t;
}

describe("업데이트 확인 예약", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

  it("autoUpdate 가 꺼져 있어도 2분 뒤와 updateCheckHours 마다 확인만 함 (설치하지 않음)", async () => {
    const { ctx, db, exitCodes } = await scheduledApp({ autoUpdate: false, updateCheckHours: 6 });
    const calls = stubGitHub("0.2.0");
    fakeTimers();
    const stop = startUpdateScheduler(ctx, (c) => exitCodes.push(c));
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([LATEST_URL]);
      expect(getValue(db, SYSTEM_KEYS.latestVersion, null)).toBe("0.2.0");
      expect(getValue(db, SYSTEM_KEYS.lastUpdateCheckAt, null)).toBe("2026-10-19 09:00:00");

      await vi.advanceTimersByTimeAsync(6 * 3_600_000);
      expect(calls).toEqual([LATEST_URL, LATEST_URL]);
      // 내려받거나 적용하지 않음
      expect(exitCodes).toEqual([]);
      expect(existsSync(path.join(ctx.config.homeDir, "versions", "0.2.0"))).toBe(false);
      expect(readLauncherState(ctx.config.homeDir)?.pending).toBeNull();
    } finally {
      stop();
    }
  });

  it("updateCheckHours 가 너무 크거나 숫자가 아니어도 확인 주기는 1시간~24일", () => {
    const hour = 3_600_000;
    expect(updateCheckPeriodMs(6)).toBe(6 * hour);
    expect(updateCheckPeriodMs("12")).toBe(12 * hour);
    expect(updateCheckPeriodMs(0.01)).toBe(hour);
    expect(updateCheckPeriodMs(720)).toBe(576 * hour);
    for (const bad of [Number.NaN, "abc", null, undefined, 0, -3, Number.POSITIVE_INFINITY, true]) {
      expect(updateCheckPeriodMs(bad), String(bad)).toBe(6 * hour);
    }
    for (const hours of [720, 1e12, Number.NaN, "abc"]) {
      const ms = updateCheckPeriodMs(hours);
      expect(ms).toBeGreaterThanOrEqual(hour);
      expect(ms).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it("updateCheckHours 가 720 이거나 숫자가 아니어도 확인을 몰아서 하지 않음", async () => {
    for (const hours of [720, Number.NaN, "abc" as unknown as number]) {
      const { ctx, exitCodes } = await scheduledApp({ autoUpdate: false, updateCheckHours: hours });
      const calls = stubGitHub(ctx.version);
      fakeTimers();
      const stop = startUpdateScheduler(ctx, (c) => exitCodes.push(c));
      try {
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 30 * 60_000);
        expect(calls, String(hours)).toEqual([LATEST_URL]);
      } finally {
        stop();
        vi.useRealTimers();
      }
    }
  });

  it("건너뛰는 버전 안내: 시험 기동 실패와 낮은 버전으로 다시 설치를 구분", async () => {
    const { ctx } = await scheduledApp({ autoUpdate: true });
    stubGitHub("0.2.0");
    const home = ctx.config.homeDir;
    // install.ps1 로 낮은 버전을 설치 → failedVersion 만 있음
    writeLauncherState(home, { current: ctx.version, previous: null, pending: null, failedVersion: "0.2.0" });
    expect((await checkForUpdate(ctx)).message).toContain("낮은 버전으로 다시 설치");
    expect(await runScheduledUpdateCheck(ctx, () => {})).toBe("skipped");

    writeLauncherState(home, {
      current: ctx.version,
      previous: null,
      pending: null,
      failedVersion: "0.2.0",
      lastUpdateError: { version: "0.2.0", at: "2026-10-19 08:00:00", message: "응답 없음" },
    });
    expect((await checkForUpdate(ctx)).message).toContain("바꾸다 실패");
  });

  it("이전 확인이 끝나지 않았으면 새 확인을 시작하지 않음", async () => {
    const { ctx } = await scheduledApp({ autoUpdate: false });
    let open!: () => void;
    const calls = stubGitHub("0.2.0", new Promise<void>((resolve) => (open = resolve)));
    const first = runScheduledUpdateCheck(ctx, () => {});
    expect(await runScheduledUpdateCheck(ctx, () => {})).toBe("busy");
    open();
    expect(await first).toBe("checked");
    expect(calls).toEqual([LATEST_URL]);
    expect(await runScheduledUpdateCheck(ctx, () => {})).toBe("checked");
  });
});

describe("업데이트 결과 기록", () => {
  it("새 버전으로 바뀌었으면 최근 업데이트 일시를 버전마다 한 번 기록", async () => {
    const { ctx, db } = await createTestApp();
    const home = ctx.config.homeDir;
    // 시험 기동 중에는 기록하지 않음
    writeLauncherState(home, { current: ctx.version, previous: "0.0.0-old", pending: null, trial: true });
    recordUpdateOutcome(ctx);
    expect(getValue(db, SYSTEM_KEYS.lastUpdatedAt, null)).toBeNull();

    writeLauncherState(home, {
      current: ctx.version,
      previous: "0.0.0-old",
      pending: null,
      trial: false,
      updatedAt: "2026-10-19 08:30:00",
    });
    recordUpdateOutcome(ctx);
    recordUpdateOutcome(ctx);
    expect(getValue(db, SYSTEM_KEYS.lastUpdatedAt, null)).toBe("2026-10-19 08:30:00");
    const logs = queryAll<{ summary: string }>(db, "SELECT summary FROM audit_logs WHERE action = 'update_app'");
    expect(logs.map((l) => l.summary)).toEqual([`프로그램 업데이트 완료: 0.0.0-old → ${ctx.version}`]);
  });

  it("되돌린 기록은 변경 이력에 한 번만", async () => {
    const { ctx, db } = await createTestApp();
    writeLauncherState(ctx.config.homeDir, {
      current: ctx.version,
      previous: null,
      pending: null,
      failedVersion: "9.9.9",
      lastUpdateError: { version: "9.9.9", at: "2026-10-19 08:00:00", message: "60초 안에 응답 없음" },
    });
    recordUpdateOutcome(ctx);
    recordUpdateOutcome(ctx);
    const logs = queryAll<{ summary: string }>(db, "SELECT summary FROM audit_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.summary).toContain("업데이트 실패로 이전 버전으로 되돌림: 9.9.9");
    expect(getValue(db, SYSTEM_KEYS.lastUpdatedAt, null)).toBeNull();
  });
});
