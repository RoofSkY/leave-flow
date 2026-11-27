import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, queryAll } from "../db/index.ts";
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
  type TestApp,
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

describe("NAS 백업 폴더 설정", () => {
  it("저장하면 config.json 에 쓰고 바로 적용, 변경 이력. 빈 값이면 끔", async () => {
    const { app, ctx, db } = await createTestApp();
    const home = ctx.config.homeDir;
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 8080 }));
    const nas = path.join(home, "nas", "leave-flow");

    const res = await app.inject({ method: "PUT", url: "/api/system/nas-backup-dir", payload: { nasBackupDir: ` ${nas} ` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nasBackupDir: nas });
    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({ port: 8080, nasBackupDir: nas });
    expect(existsSync(nas)).toBe(true);
    expect(readdirSync(nas)).toEqual([]);

    const backup = await app.inject({ method: "POST", url: "/api/backups", payload: {} });
    expect(readdirSync(nas)).toEqual([backup.json().name]);

    const off = await app.inject({ method: "PUT", url: "/api/system/nas-backup-dir", payload: { nasBackupDir: "" } });
    expect(off.json()).toEqual({ nasBackupDir: null });
    expect(ctx.config.nasBackupDir).toBeNull();
    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).nasBackupDir).toBeNull();

    const logs = queryAll(db, "SELECT summary FROM audit_logs WHERE entity = 'settings' ORDER BY id");
    expect(logs).toEqual([{ summary: `설정 변경: NAS 백업 폴더 ${nas}` }, { summary: "설정 변경: NAS 백업 끔" }]);
  });

  it("형식이 틀리거나 쓸 수 없는 폴더는 저장하지 않음", async () => {
    const { app, ctx } = await createTestApp();
    const bad = await app.inject({ method: "PUT", url: "/api/system/nas-backup-dir", payload: { nasBackupDir: "nas/backup" } });
    expect(bad.statusCode).toBe(400);

    // 파일 아래에는 폴더를 만들 수 없음
    const file = path.join(ctx.config.homeDir, "file.txt");
    writeFileSync(file, "");
    const res = await app.inject({ method: "PUT", url: "/api/system/nas-backup-dir", payload: { nasBackupDir: path.join(file, "sub") } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("NAS 백업 폴더에 쓸 수 없습니다");
    expect(ctx.config.nasBackupDir).toBeNull();
    expect(existsSync(path.join(ctx.config.homeDir, "config.json"))).toBe(false);
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

describe("휴가원 관리대장 엑셀", () => {
  /** 시트의 줄들 (머리글 포함, 칸은 보이는 글자) */
  const sheetRows = (ws: ExcelJS.Worksheet) =>
    Array.from({ length: ws.rowCount }, (_, r) =>
      Array.from({ length: ws.columnCount }, (_, c) => ws.getRow(r + 1).getCell(c + 1).text),
    );
  const load = async (payload: unknown) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(payload as ExcelJS.Buffer);
    return wb;
  };
  const leave = (app: TestApp["app"], employeeId: number, items: object[], extra: object = {}) =>
    app.inject({
      method: "POST",
      url: "/api/leave-requests",
      payload: { employeeId, items, reason: "개인 사유", emergencyContact: "010-1234-5678", handoverNote: "", ...extra },
    });

  it("3개 시트(A열 소속, B열 구분): 날짜마다 1줄인 사용내역, 부여·기존 잔여·적립 부여내역, 잔여내역 표", async () => {
    const { app, db } = await createTestApp();
    const hong = insertEmployee(db, { name: "홍길동", department: "아동사업부", category: "직원" });
    const annual = insertLeaveType(db, { name: "연차(직원)", sortOrder: 1 });
    execute(db, "UPDATE leave_types SET display_name = '연차' WHERE id = ?", [annual]);
    const comp = insertLeaveType(db, { name: "대체휴가(직원)", balanceMode: "cumulative", sortOrder: 2 });
    execute(db, "UPDATE leave_types SET display_name = '대체휴가' WHERE id = ?", [comp]);
    const sick = insertLeaveType(db, { name: "병가", sortOrder: 3 });
    insertLeaveType(db, { name: "공가", deducts: false, sortOrder: 4 });
    insertHoliday(db, { date: "2026-10-15", name: "휴무일", kind: "center" });

    // 기존 잔여: 15일 중 10일 남음 (기존 사용 5일)
    const opening = await app.inject({
      method: "PUT",
      url: "/api/opening-balances",
      payload: {
        employeeId: hong,
        leaveTypeId: annual,
        year: 2026,
        baseDate: "2026-03-01",
        totalGrantedMinutes: 15 * 480,
        remainingMinutes: 10 * 480,
      },
    });
    expect(opening.statusCode).toBeLessThan(300);
    insertGrant(db, { employeeId: hong, leaveTypeId: comp, grantDate: "2026-02-01", minutes: 180, note: "연초 이월" });
    // 일반 시간외근무: 첫 출력 때 적립 (부여일 = 제출일 = 오늘)
    const overtime = await app.inject({
      method: "POST",
      url: "/api/overtime",
      payload: {
        kind: "general",
        targets: [{ employeeId: hong, leaveTypeId: comp }],
        workStartAt: "2026-10-10T10:00",
        workEndAt: "2026-10-10T19:00",
        minutes: 150,
        cumulativeNote: "",
        category: "special_work",
        workDetails: "행사 준비",
      },
    });
    expect(overtime.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/overtime/${overtime.json().id}/print` })).statusCode).toBe(200);

    // 화~금 (목요일은 휴무일) / 해를 넘는 휴가 / 미차감 / 취소
    const multi = await leave(app, hong, [{ leaveTypeId: annual, startAt: "2026-10-13T13:00", endAt: "2026-10-16T15:00" }], {
      handoverNote: "인계 메모",
    });
    expect(multi.statusCode).toBe(201);
    const crossYear = await leave(app, hong, [{ leaveTypeId: sick, startAt: "2025-12-31T10:00", endAt: "2026-01-02T19:00" }]);
    expect(crossYear.statusCode).toBe(201);
    const noDeduct = await leave(app, hong, [{ leaveTypeId: comp, startAt: "2026-10-20T10:00", endAt: "2026-10-20T12:00" }], {
      noDeduct: true,
    });
    expect(noDeduct.statusCode).toBe(201);
    const cancelled = await leave(app, hong, [{ leaveTypeId: annual, startAt: "2026-10-21T10:00", endAt: "2026-10-21T12:00" }]);
    const cancel = await app.inject({ method: "POST", url: `/api/leave-requests/${cancelled.json().request.id}/cancel` });
    expect(cancel.statusCode).toBe(200);

    // 영구 삭제된 직원의 기록은 넣지 않음
    const gone = insertEmployee(db, { name: "김삭제" });
    insertGrant(db, { employeeId: gone, leaveTypeId: comp, grantDate: "2026-05-01", minutes: 60 });
    execute(db, "UPDATE employees SET deleted = 1, active = 0 WHERE id = ?", [gone]);

    const res = await app.inject({ method: "GET", url: "/api/export.xlsx?year=2026" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="leave-flow-2026.xlsx"; filename*=UTF-8''${encodeURIComponent("2026 휴가원 관리대장.xlsx")}`,
    );
    const wb = await load(res.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["휴가사용내역", "휴가부여내역", "잔여내역"]);
    // 양식: 머리글 굵게·회색 바탕·가운데, 본문 가운데(근무내역만 왼쪽), 모든 칸 테두리, 첫 줄 고정·필터
    const thin = { style: "thin" };
    for (const name of ["휴가사용내역", "휴가부여내역"]) {
      const ws = wb.getWorksheet(name)!;
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
      expect(ws.getCell("A1")).toMatchObject({
        font: { name: "맑은 고딕", size: 11, bold: true },
        fill: { pattern: "solid", fgColor: { argb: "FFF2F2F0" } },
        alignment: { horizontal: "center", vertical: "middle" },
        border: { top: thin, left: thin, bottom: thin, right: thin },
      });
      expect(ws.getCell("A2")).toMatchObject({ font: { name: "맑은 고딕", size: 11 }, alignment: { horizontal: "center" } });
      expect(ws.getCell(2, ws.columnCount).border).toMatchObject({ top: thin, left: thin, bottom: thin, right: thin });
    }
    const used = wb.getWorksheet("휴가사용내역")!;
    expect(used.columns.map((c) => c.width)).toEqual([11, 13, 9.5, 11.125, 13.25, 13.25, 13.25, 13.25, 13.25, 30.5]);
    expect(used.getCell("J2").alignment).toMatchObject({ horizontal: "center" });
    const granted = wb.getWorksheet("휴가부여내역")!;
    expect(granted.columns.map((c) => c.width)).toEqual([11, 13, 9.5, 11.375, 11.25, 11.375, 13.25, 45.375]);
    expect(granted.getCell("H1").alignment).toEqual({ vertical: "middle" });
    expect(granted.getCell("H2").alignment?.horizontal).toBeUndefined();

    const person = ["아동사업부", "직원", "홍길동"];
    expect(sheetRows(wb.getWorksheet("휴가사용내역")!)).toEqual([
      ["소속", "구분", "성명", "날짜", "시작시각", "종료시각", "휴가사유", "휴가종류", "사용시간", "비고(업무인계 및 기타사항)"],
      [...person, "2026-01-01", "10:00", "19:00", "개인 사유", "병가", "1일", ""],
      [...person, "2026-01-02", "10:00", "19:00", "개인 사유", "병가", "1일", ""],
      [...person, "2026-10-13", "13:00", "19:00", "개인 사유", "연차", "6시간", "인계 메모"],
      [...person, "2026-10-14", "10:00", "19:00", "개인 사유", "연차", "1일", "인계 메모"],
      [...person, "2026-10-16", "10:00", "15:00", "개인 사유", "연차", "4시간", "인계 메모"],
      [...person, "2026-10-20", "10:00", "12:00", "개인 사유", "대체휴가", "2시간", "[미차감]"],
    ]);
    expect(sheetRows(wb.getWorksheet("휴가부여내역")!)).toEqual([
      ["소속", "구분", "성명", "부여일", "휴가종류", "부여량", "상세내용", "근무내역"],
      [...person, "2026-02-01", "대체휴가", "3시간", "직접부여", "연초 이월"],
      [...person, "2026-03-01", "연차", "15일", "기존 잔여", "기존 사용 5일 / 입력 당시 잔여 10일"],
      [...person, "2026-10-19", "대체휴가", "2시간 30분", "특별근무", "행사 준비"],
    ]);
    // 잔여내역: 소속·구분·직원, 종류는 표시 이름 + 기준, 차감 종류는 부여·사용·잔여, 차감 안 하는 종류는 사용만
    // 연차: 15일 - (기존 사용 5일 + 6시간 + 1일 + 4시간), 대체휴가: 미차감 휴가원은 사용에 안 듦
    const remaining = wb.getWorksheet("잔여내역")!;
    const annualHead = "연차\n2026년";
    const compHead = "대체휴가\n누적";
    const sickHead = "병가\n2026년";
    expect(sheetRows(remaining)).toEqual([
      ["소속", "구분", "직원", annualHead, annualHead, annualHead, compHead, compHead, compHead, sickHead, sickHead, sickHead, "공가\n차감 안 함"],
      ["소속", "구분", "직원", "부여", "사용", "잔여", "부여", "사용", "잔여", "부여", "사용", "잔여", "사용"],
      [...person, "15일", "7일 2시간", "7일 6시간", "5시간 30분", "0일", "5시간 30분", "0일", "2일", "-2일", "0일"],
    ]);
    expect(remaining.getCell("A2").master.address).toBe("A1");
    expect(remaining.getCell("C2").master.address).toBe("C1");
    expect(remaining.getCell("F1").master.address).toBe("D1");
    expect(remaining.getCell("M1").isMerged).toBe(false);
    expect(remaining.views[0]).toMatchObject({ state: "frozen", xSplit: 3, ySplit: 2 });
    expect(remaining.pageSetup).toMatchObject({
      paperSize: 9,
      orientation: "landscape",
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:2",
    });
    expect(remaining.getRow(1).height).toBe(33);
    expect(remaining.columns.map((c) => c.width)).toEqual([11, 13, 9.5, ...Array(10).fill(10.625)]);
    expect(remaining.getCell("D1")).toMatchObject({
      font: { name: "맑은 고딕", size: 11, bold: true },
      alignment: { horizontal: "center", vertical: "middle", wrapText: true },
    });
    expect(remaining.getCell("D3")).toMatchObject({
      font: { name: "맑은 고딕", size: 11 },
      alignment: { horizontal: "center", vertical: "top", wrapText: true },
      border: { top: thin, left: thin, bottom: thin, right: thin },
    });

    // 다른 연도: 그 해 날짜만
    const prev = await load((await app.inject({ method: "GET", url: "/api/export.xlsx?year=2025" })).rawPayload);
    expect(sheetRows(prev.getWorksheet("휴가사용내역")!).slice(1)).toEqual([
      [...person, "2025-12-31", "10:00", "19:00", "개인 사유", "병가", "1일", ""],
    ]);
    expect(sheetRows(prev.getWorksheet("휴가부여내역")!).slice(1)).toEqual([]);
  });

  it("연도를 안 주면 올해, 잘못된 연도는 400", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/export.xlsx" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("leave-flow-2026.xlsx");
    expect((await app.inject({ method: "GET", url: "/api/export.xlsx?year=abc" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/export.xlsx?year=1999" })).statusCode).toBe(400);
  });

  it("한 직원에게 표시 이름이 같은 종류가 둘 이상 나오면 그 시트에서는 관리 이름", async () => {
    const { app, db } = await createTestApp();
    const hong = insertEmployee(db, { name: "홍길동" });
    const staff = insertLeaveType(db, { name: "연차(직원)" });
    const teacher = insertLeaveType(db, { name: "연차(강사)", active: false });
    execute(db, "UPDATE leave_types SET display_name = '연차'");
    insertGrant(db, { employeeId: hong, leaveTypeId: staff, grantDate: "2026-01-01", minutes: 480 });
    insertGrant(db, { employeeId: hong, leaveTypeId: teacher, grantDate: "2026-01-02", minutes: 480 });
    const kim = insertEmployee(db, { name: "김철수" });
    insertGrant(db, { employeeId: kim, leaveTypeId: staff, grantDate: "2026-01-03", minutes: 480 });

    const wb = await load((await app.inject({ method: "GET", url: "/api/export.xlsx?year=2026" })).rawPayload);
    expect(sheetRows(wb.getWorksheet("휴가부여내역")!).map((r) => [r[2], r[4]])).toEqual([
      ["성명", "휴가종류"],
      ["홍길동", "연차(직원)"],
      ["홍길동", "연차(강사)"],
      ["김철수", "연차"],
    ]);
  });

  it("잔여내역: 표시 이름이 같은 종류는 한 열, 기준이 다르면 기간 칸, 적용되지 않으면 -", async () => {
    const { app, db } = await createTestApp();
    const staff = insertLeaveType(db, { name: "연차(직원)", sortOrder: 1 });
    const agent = insertLeaveType(db, { name: "연차(요원)", balanceMode: "cumulative", sortOrder: 2 });
    const special = insertLeaveType(db, { name: "특별휴가(요원)", balanceMode: "cumulative", sortOrder: 3 });
    execute(db, "UPDATE leave_types SET display_name = '연차' WHERE id IN (?, ?)", [staff, agent]);
    execute(db, "UPDATE leave_types SET display_name = '특별휴가' WHERE id = ?", [special]);
    execute(db, `UPDATE leave_types SET target_categories = '["직원"]' WHERE id = ?`, [staff]);
    execute(db, `UPDATE leave_types SET target_categories = '["사회복무요원"]' WHERE id IN (?, ?)`, [agent, special]);
    const hong = insertEmployee(db, { name: "홍길동", category: "직원" });
    const kim = insertEmployee(db, { name: "김요원", category: "사회복무요원" });
    // 요원에서 직원으로 구분이 바뀐 직원: 예전 연차(요원) 부여가 남아 있음
    const lee = insertEmployee(db, { name: "이변경", category: "직원" });
    insertGrant(db, { employeeId: hong, leaveTypeId: staff, grantDate: "2026-01-01", minutes: 15 * 480 });
    insertGrant(db, { employeeId: kim, leaveTypeId: agent, grantDate: "2026-01-01", minutes: 5 * 480 });
    insertGrant(db, { employeeId: lee, leaveTypeId: staff, grantDate: "2026-01-01", minutes: 15 * 480 });
    insertGrant(db, { employeeId: lee, leaveTypeId: agent, grantDate: "2025-06-01", minutes: 2 * 480 });

    const wb = await load((await app.inject({ method: "GET", url: "/api/export.xlsx?year=2026" })).rawPayload);
    const two = (a: string, b: string) => `연차(직원) ${a}\n연차(요원) ${b}`;
    expect(sheetRows(wb.getWorksheet("잔여내역")!)).toEqual([
      ["소속", "구분", "직원", "연차", "연차", "연차", "연차", "특별휴가\n누적", "특별휴가\n누적", "특별휴가\n누적"],
      ["소속", "구분", "직원", "부여", "사용", "잔여", "기간", "부여", "사용", "잔여"],
      ["아동사업부", "사회복무요원", "김요원", "5일", "0일", "5일", "누적", "0일", "0일", "0일"],
      ["아동사업부", "직원", "이변경", two("15일", "2일"), two("0일", "0일"), two("15일", "2일"), two("2026년", "누적"), "-", "-", "-"],
      ["아동사업부", "직원", "홍길동", "15일", "0일", "15일", "2026년", "-", "-", "-"],
    ]);
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

describe("DB 파일로 복구 (화면에서 고른 파일)", () => {
  const upload = (app: Awaited<ReturnType<typeof createTestApp>>["app"], body: Buffer, name = "my.db") =>
    app.inject({
      method: "POST",
      url: `/api/backups/upload?name=${encodeURIComponent(name)}`,
      headers: { "content-type": "application/octet-stream" },
      payload: body,
    });

  it("고른 DB 파일로 복구 대기 파일을 만들고 지금 DB를 백업한 뒤 종료 코드 76", async () => {
    const t = await createTestApp();
    insertEmployee(t.db, { name: "가져올 직원" });
    const backup = await t.app.inject({ method: "POST", url: "/api/backups" });
    const file = readFileSync(path.join(t.ctx.config.backupDir, backup.json().name));
    insertEmployee(t.db, { name: "지금 직원" });

    const res = await upload(t.app, file, "옛날.db");
    expect(res.statusCode).toBe(200);
    expect(t.exitCodes).toEqual([76]);
    expect(readdirSync(t.ctx.config.backupDir).filter((n) => n.includes("pre-restore"))).toHaveLength(1);
    const pending = new DatabaseSync(path.join(t.ctx.config.dataDir, PENDING_RESTORE_NAME));
    expect(queryAll(pending, "SELECT name FROM employees").map((r) => r.name)).toEqual(["가져올 직원"]);
    expect(queryAll(pending, "SELECT summary FROM audit_logs WHERE action = 'restore_backup'")).toEqual([
      { summary: "DB 파일로 복구: 옛날.db" },
    ]);
    pending.close();
  });

  it("DB 파일이 아니거나 비었거나 더 새 버전 DB면 400, 아무것도 남기지 않음", async () => {
    const t = await createTestApp();
    const bad = await upload(t.app, Buffer.from("not a database"));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("올바른 leave-flow 백업 파일이 아닙니다.");
    expect((await upload(t.app, Buffer.alloc(0))).statusCode).toBe(400);

    const backup = await t.app.inject({ method: "POST", url: "/api/backups" });
    const newer = path.join(t.ctx.config.backupDir, backup.json().name);
    const db = new DatabaseSync(newer);
    db.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', '2030-01-01 00:00:00')");
    db.close();
    const res = await upload(t.app, readFileSync(newer));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("이 프로그램보다 새 버전에서 만든 DB 파일입니다. 프로그램을 먼저 업데이트하세요.");

    expect(existsSync(path.join(t.ctx.config.dataDir, PENDING_RESTORE_NAME))).toBe(false);
    expect(readdirSync(t.ctx.config.backupDir).filter((n) => n.includes("pre-restore"))).toEqual([]);
    expect(t.exitCodes).toEqual([]);
  });

  it("파일 내용 형식은 이 경로에서만 받음", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/backups",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(415);
  });
});
