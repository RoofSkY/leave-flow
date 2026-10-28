import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryAll } from "../db/index.ts";
import { PENDING_RESTORE_NAME } from "../services/backup.ts";
import { SYSTEM_KEYS, getValue } from "../services/settings.ts";
import { readLauncherState, runAutoUpdate, writeLauncherState } from "../services/updater.ts";
import {
  createTestApp,
  insertEmployee,
  insertGrant,
  insertHoliday,
  insertLeaveType,
  testConfig,
} from "../testing.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("시스템 정보", () => {
  it("버전·백업·업데이트 상태", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/system/info" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: "0.0.0-test",
      updateRepo: null,
      autoUpdate: false,
      lastBackupAt: null,
      lastBackupError: null,
      latestVersion: null,
      nasBackupDir: null,
      backupTime: "12:30",
      backupKeepDays: 30,
      updateFailure: null,
    });
    expect(typeof res.json().bootId).toBe("string");
  });
});

describe("백업 API", () => {
  it("지금 백업 → 201, 목록에 로컬·NAS, 변경 이력", async () => {
    const nas = path.join(testConfig().homeDir, "nas");
    const { app, db } = await createTestApp({ config: { nasBackupDir: nas } });
    const res = await app.inject({ method: "POST", url: "/api/backups", payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "leave-flow-20261019-090000-manual.db", location: "local" });

    const list = await app.inject({ method: "GET", url: "/api/backups" });
    expect(list.json().map((b: { location: string }) => b.location)).toEqual(["local", "nas"]);

    const logs = queryAll(db, "SELECT entity, action, summary FROM audit_logs");
    expect(logs).toEqual([
      { entity: "system", action: "backup", summary: "수동 백업: leave-flow-20261019-090000-manual.db" },
    ]);
    const info = await app.inject({ method: "GET", url: "/api/system/info" });
    expect(info.json().lastBackupAt).toBe("2026-10-19 09:00:00");
  });

  it("백업 폴더가 없으면 빈 목록", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/backups" });
    expect(res.json()).toEqual([]);
  });
});

describe("백업 복구", () => {
  async function setup() {
    const t = await createTestApp();
    insertEmployee(t.db, { name: "백업 전 직원" });
    const backup = await t.app.inject({ method: "POST", url: "/api/backups" });
    insertEmployee(t.db, { name: "백업 뒤 직원" });
    return { ...t, name: backup.json().name as string };
  }

  it("잘못된 이름·위치·없는 파일", async () => {
    const { app, exitCodes } = await setup();
    const post = (payload: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/backups/restore", payload });
    expect((await post({ name: "../leave-flow.db", location: "local" })).statusCode).toBe(400);
    expect((await post({ name: "..\\..\\data\\leave-flow-20261019-090000.db", location: "local" })).statusCode).toBe(
      400,
    );
    expect((await post({ name: "leave-flow-20261019-090000-manual.db", location: "cloud" })).statusCode).toBe(400);
    const nas = await post({ name: "leave-flow-20261019-090000-manual.db", location: "nas" });
    expect(nas.statusCode).toBe(400);
    expect(nas.json().error).toBe("NAS 백업 폴더가 설정되어 있지 않습니다.");
    const missing = await post({ name: "leave-flow-20200101-000000-daily.db", location: "local" });
    expect(missing.statusCode).toBe(404);
    expect(exitCodes).toEqual([]);
  });

  it("DB 파일이 아니면 400, 복구 대기 파일을 남기지 않음", async () => {
    const { app, ctx, exitCodes } = await setup();
    writeFileSync(path.join(ctx.config.backupDir, "leave-flow-20261018-123000-daily.db"), "not a database");
    const res = await app.inject({
      method: "POST",
      url: "/api/backups/restore",
      payload: { name: "leave-flow-20261018-123000-daily.db", location: "local" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("올바른 leave-flow 백업 파일이 아닙니다.");
    expect(existsSync(path.join(ctx.config.dataDir, PENDING_RESTORE_NAME))).toBe(false);
    expect(exitCodes).toEqual([]);
  });

  it("복구: 지금 DB를 백업하고 복구 대기 파일을 만든 뒤 종료 코드 76", async () => {
    const { app, ctx, db, exitCodes, name } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/backups/restore", payload: { name, location: "local" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain("재시작");
    expect(exitCodes).toEqual([76]);

    // 복구 직전 상태 백업
    const preRestore = readdirSync(ctx.config.backupDir).filter((n) => n.includes("pre-restore"));
    expect(preRestore).toHaveLength(1);
    const pre = new DatabaseSync(path.join(ctx.config.backupDir, preRestore[0]!));
    expect(queryAll(pre, "SELECT name FROM employees ORDER BY id").map((r) => r.name)).toEqual([
      "백업 전 직원",
      "백업 뒤 직원",
    ]);
    pre.close();

    // 복구 대기 파일 = 고른 백업 + 복구 기록
    const pending = new DatabaseSync(path.join(ctx.config.dataDir, PENDING_RESTORE_NAME));
    expect(queryAll(pending, "SELECT name FROM employees").map((r) => r.name)).toEqual(["백업 전 직원"]);
    expect(queryAll(pending, "SELECT action FROM audit_logs WHERE action = 'restore_backup'")).toHaveLength(1);
    // 백업·업데이트 기록은 복구로 되돌아가지 않음 (복구 직전 백업 일시가 그대로)
    expect(queryAll(pending, "SELECT value FROM settings WHERE key = ?", [SYSTEM_KEYS.lastBackupAt])).toEqual([
      { value: JSON.stringify("2026-10-19 09:00:00") },
    ]);
    pending.close();

    expect(queryAll(db, "SELECT summary FROM audit_logs WHERE action = 'restore_backup'")).toEqual([
      { summary: `백업 복구: ${name} (로컬)` },
    ]);
  });
});

describe("엑셀 내려받기", () => {
  it("한국어 시트·열 이름, 첫 줄 굵게·고정", async () => {
    const { app, db } = await createTestApp();
    const emp = insertEmployee(db, { name: "홍길동", workDays: [1, 2, 3] });
    const comp = insertLeaveType(db, { name: "대체휴가", balanceMode: "cumulative" });
    insertGrant(db, { employeeId: emp, leaveTypeId: comp, grantDate: "2026-03-01", minutes: 150, note: "메모" });
    insertHoliday(db, { date: "2026-10-09", name: "한글날" });

    const res = await app.inject({ method: "GET", url: "/api/export.xlsx" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="leave-flow-20261019.xlsx"; filename*=UTF-8''leave-flow-20261019.xlsx`,
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "직원",
      "휴가 종류",
      "부여 내역",
      "기존 잔여량",
      "휴가원",
      "휴가원 항목",
      "시간외근무 신청서",
      "공휴일·휴무일",
      "사용 현황 요약",
      "변경 이력",
    ]);
    const employees = wb.getWorksheet("직원")!;
    expect(employees.getRow(1).font?.bold).toBe(true);
    expect(employees.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(employees.getRow(2).getCell(5).value).toBe("월·화·수");
    expect(employees.getRow(2).getCell(9).value).toBe("담당·센터장");
    expect(employees.getRow(1).getCell(10).value).toBe("구분");
    expect(employees.getRow(2).getCell(11).value).toBe("예"); // 활성

    const grants = wb.getWorksheet("부여 내역")!;
    expect(grants.getRow(1).getCell(7).value).toBe("부여량");
    expect(grants.getRow(2).getCell(6).value).toBe(150);
    expect(grants.getRow(2).getCell(7).value).toBe("2시간 30분");
    expect(grants.getRow(2).getCell(9).value).toBe("직접 입력");

    const usage = wb.getWorksheet("사용 현황 요약")!;
    expect(usage.getRow(2).values).toEqual(
      expect.arrayContaining(["홍길동", "대체휴가", "누적(2026년까지)", "2시간 30분", "0일"]),
    );
    expect(wb.getWorksheet("공휴일·휴무일")!.getRow(2).getCell(3).value).toBe("금");
  });

  it("화면 표 그대로: 제목·부제목, 머리글 병합(colSpan·rowSpan), 본문, A4 가로 인쇄", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/export/table.xlsx",
      payload: {
        title: "2026년 잔여 현황",
        subtitle: "출력 2026.10.19.",
        head: [
          [{ text: "직원", rowSpan: 2 }, { text: "소속", rowSpan: 2 }, { text: "연차\n2026년", colSpan: 3 }, { text: "공가" }],
          [{ text: "잔여" }, { text: "부여" }, { text: "사용" }, { text: "사용" }],
        ],
        body: [["홍길동", "아동사업부", "3일", "15일", "12일", "1일"]],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="table.xlsx"; filename*=UTF-8''${encodeURIComponent("2026년 잔여 현황.xlsx")}`,
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet("2026년 잔여 현황")!;
    expect(ws.getCell("A1").value).toBe("2026년 잔여 현황");
    expect(ws.getCell("A2").value).toBe("출력 2026.10.19.");
    // 머리글: 직원·소속은 두 줄 병합, 연차는 세 칸 병합, 둘째 줄은 비어 있는 칸부터
    const text = (row: number) => [1, 2, 3, 4, 5, 6].map((col) => ws.getCell(row, col).master.value);
    expect(text(3)).toEqual(["직원", "소속", "연차\n2026년", "연차\n2026년", "연차\n2026년", "공가"]);
    expect(text(4)).toEqual(["직원", "소속", "잔여", "부여", "사용", "사용"]);
    expect(ws.getCell("A4").master.address).toBe("A3");
    expect(ws.getCell("E3").master.address).toBe("C3");
    expect(text(5)).toEqual(["홍길동", "아동사업부", "3일", "15일", "12일", "1일"]);
    expect(ws.pageSetup).toMatchObject({ orientation: "landscape", paperSize: 9, fitToWidth: 1, fitToHeight: 0 });
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 4 });

    const bad = await app.inject({ method: "POST", url: "/api/export/table.xlsx", payload: { title: "", subtitle: "", head: [], body: [] } });
    expect(bad.statusCode).toBe(400);
  });
});

/* ---------- 업데이트 ---------- */

const REPO = "office/leave-flow";

function release(version: string, files: Record<string, string> = {}) {
  const zip = zipSync({
    "server.mjs": strToU8(`// ${version}`),
    "launcher.mjs": strToU8("// launcher"),
    "web/index.html": strToU8("<html></html>"),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  });
  const sha = createHash("sha256").update(zip).digest("hex");
  return { zip, sha };
}

/** GitHub API·자산 다운로드 흉내 */
function mockGitHub(version: string | null, opts: { sha?: string; files?: Record<string, string> } = {}) {
  const r = version ? release(version, opts.files) : null;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === `https://api.github.com/repos/${REPO}/releases/latest`) {
      if (!version) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
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
    }
    if (r && url === `https://dl.test/leave-flow-${version}.zip`) return new Response(r.zip);
    if (r && url.endsWith(".sha256")) {
      return new Response(`${opts.sha ?? r.sha}  leave-flow-${version}.zip\n`);
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

async function updateApp() {
  const t = await createTestApp({ config: { updateRepo: REPO } });
  writeLauncherState(t.ctx.config.homeDir, { current: t.ctx.version, previous: null, pending: null });
  return t;
}

describe("업데이트 확인", () => {
  it("저장소가 없거나 개발 실행이면 409", async () => {
    const { app, ctx } = await createTestApp();
    const res = await app.inject({ method: "POST", url: "/api/system/update/check" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("updateRepo");

    ctx.config.updateRepo = REPO;
    ctx.version = "dev";
    const dev = await app.inject({ method: "POST", url: "/api/system/update/apply" });
    expect(dev.statusCode).toBe(409);
    expect(dev.json().error).toContain("개발 실행");
  });

  it("새 버전이 있으면 updateAvailable, 확인 일시·최신 버전 기록", async () => {
    const { app, db } = await updateApp();
    const { calls } = mockGitHub("0.2.0");
    const res = await app.inject({ method: "POST", url: "/api/system/update/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      currentVersion: "0.0.0-test",
      latestVersion: "0.2.0",
      updateAvailable: true,
    });
    expect(calls).toEqual([`https://api.github.com/repos/${REPO}/releases/latest`]);
    expect(getValue(db, SYSTEM_KEYS.latestVersion, null)).toBe("0.2.0");
    expect(getValue(db, SYSTEM_KEYS.lastUpdateCheckAt, null)).toBe("2026-10-19 09:00:00");
  });

  it("같은 버전·릴리스 없음·연결 실패", async () => {
    const { app, ctx } = await updateApp();
    mockGitHub(ctx.version);
    let res = await app.inject({ method: "POST", url: "/api/system/update/check" });
    expect(res.json()).toMatchObject({ updateAvailable: false, message: `최신 버전(${ctx.version})을 사용 중입니다.` });

    mockGitHub(null);
    res = await app.inject({ method: "POST", url: "/api/system/update/check" });
    expect(res.json()).toMatchObject({ updateAvailable: false, latestVersion: null, message: "아직 배포된 버전이 없습니다." });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    res = await app.inject({ method: "POST", url: "/api/system/update/check" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("인터넷 연결");
  });
});

describe("업데이트 적용", () => {
  it("내려받기 → SHA-256 확인 → DB 백업 → 풀기 → pending 기록 → 종료 코드 75", async () => {
    const { app, ctx, db, exitCodes } = await updateApp();
    mockGitHub("0.2.0");
    const res = await app.inject({ method: "POST", url: "/api/system/update/apply" });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain("0.2.0");
    expect(exitCodes).toEqual([75]);

    const home = ctx.config.homeDir;
    expect(readFileSync(path.join(home, "versions", "0.2.0", "server.mjs"), "utf8")).toBe("// 0.2.0");
    expect(existsSync(path.join(home, "versions", "0.2.0", "web", "index.html"))).toBe(true);
    expect(existsSync(path.join(home, "updates", "leave-flow-0.2.0.zip"))).toBe(true);
    const state = readLauncherState(home)!;
    expect(state).toMatchObject({ current: ctx.version, pending: "0.2.0" });
    const backups = readdirSync(ctx.config.backupDir);
    expect(backups).toEqual(["leave-flow-20261019-090000-pre-update.db"]);
    expect(state.preUpdateBackup).toBe(path.join(ctx.config.backupDir, backups[0]!));
    expect(queryAll(db, "SELECT action, summary FROM audit_logs")).toEqual([
      { action: "update_app", summary: "프로그램 업데이트 시작: 0.0.0-test → 0.2.0" },
    ]);

    // 종료 전에 다시 누르면 거절
    const again = await app.inject({ method: "POST", url: "/api/system/update/apply" });
    expect(again.statusCode).toBe(409);
    expect(exitCodes).toEqual([75]);
  });

  it("SHA-256이 다르면 502, 아무것도 바꾸지 않음", async () => {
    const { app, ctx, db, exitCodes } = await updateApp();
    mockGitHub("0.2.0", { sha: "0".repeat(64) });
    const res = await app.inject({ method: "POST", url: "/api/system/update/apply" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("SHA-256");
    expect(exitCodes).toEqual([]);
    expect(existsSync(path.join(ctx.config.homeDir, "versions", "0.2.0"))).toBe(false);
    expect(readLauncherState(ctx.config.homeDir)?.pending).toBeNull();
    expect(queryAll(db, "SELECT * FROM audit_logs")).toEqual([]);

    // 잠금이 풀려 다시 시도할 수 있음
    mockGitHub("0.2.0");
    expect((await app.inject({ method: "POST", url: "/api/system/update/apply" })).statusCode).toBe(200);
  });

  it("zip 안에 경로 탈출이 있으면 거절", async () => {
    const { app, ctx, exitCodes } = await updateApp();
    mockGitHub("0.2.0", { files: { "../../evil.txt": "x" } });
    const res = await app.inject({ method: "POST", url: "/api/system/update/apply" });
    expect(res.statusCode).toBe(502);
    expect(exitCodes).toEqual([]);
    expect(existsSync(path.join(ctx.config.homeDir, "versions", "0.2.0"))).toBe(false);
    expect(readLauncherState(ctx.config.homeDir)?.pending).toBeNull();
  });

  it("이미 최신이면 409, state.json 이 없으면 409", async () => {
    const t = await updateApp();
    mockGitHub(t.ctx.version);
    expect((await t.app.inject({ method: "POST", url: "/api/system/update/apply" })).statusCode).toBe(409);

    const bare = await createTestApp({ config: { updateRepo: REPO } });
    mockGitHub("0.2.0");
    const res = await bare.app.inject({ method: "POST", url: "/api/system/update/apply" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("state.json");
  });

  it("자동 업데이트는 실패했던 버전을 건너뜀", async () => {
    const { ctx, exitCodes } = await updateApp();
    mockGitHub("0.2.0");
    writeLauncherState(ctx.config.homeDir, {
      current: ctx.version,
      previous: null,
      pending: null,
      failedVersion: "0.2.0",
    });
    expect(await runAutoUpdate(ctx, (c) => exitCodes.push(c))).toBe("skipped");
    expect(exitCodes).toEqual([]);

    mockGitHub("0.2.1");
    expect(await runAutoUpdate(ctx, (c) => exitCodes.push(c))).toBe("applied");
    expect(exitCodes).toEqual([75]);
    expect(readLauncherState(ctx.config.homeDir)?.pending).toBe("0.2.1");
  });
});
