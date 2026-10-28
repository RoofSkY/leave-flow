import { describe, expect, it } from "vitest";
import { queryAll } from "../db/index.ts";
import { createTestApp } from "../testing.ts";

describe("설정 API", () => {
  it("바꿀 항목이 없으면 400, 기본값·변경 이력 그대로", async () => {
    const { app, db } = await createTestApp();
    const res = await app.inject({ method: "PUT", url: "/api/settings", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("바꿀 설정이 없습니다.");
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({
      defaultWorkStart: "09:00",
      defaultWorkEnd: "18:00",
    });
    expect(queryAll(db, "SELECT * FROM audit_logs WHERE entity = 'settings'")).toEqual([]);
  });
});
