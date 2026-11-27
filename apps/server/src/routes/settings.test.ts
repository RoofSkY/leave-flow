import { describe, expect, it } from "vitest";
import { queryAll } from "../db/index.ts";
import { createTestApp } from "../testing.ts";

describe("설정 API", () => {
  it("근무 시작·종료 기본값 중 하나라도 없으면 400, 기본값·변경 이력 그대로", async () => {
    const { app, db } = await createTestApp();
    for (const payload of [{}, { defaultWorkStart: "10:00" }, { defaultWorkEnd: "19:00" }]) {
      const res = await app.inject({ method: "PUT", url: "/api/settings", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({
      defaultWorkStart: "09:00",
      defaultWorkEnd: "18:00",
    });
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'settings'")).toEqual([]);
  });

  it("저장 + 변경 이력", async () => {
    const { app, db } = await createTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { defaultWorkStart: "10:00", defaultWorkEnd: "19:00" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ defaultWorkStart: "10:00", defaultWorkEnd: "19:00" });
    expect(queryAll(db, "SELECT summary FROM audit_logs WHERE entity = 'settings'")).toEqual([
      { summary: "설정 변경: 근무시간 기본값 10:00~19:00" },
    ]);
  });
});
