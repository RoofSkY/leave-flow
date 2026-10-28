import type { Category, Employee } from "@leave-flow/shared";
import { describe, expect, it } from "vitest";
import { queryAll } from "../db/index.ts";
import { createTestApp, insertCategory, insertEmployee, insertLeaveType, type TestApp } from "../testing.ts";

const inject = (t: TestApp, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  t.app.inject({ method, url, payload });

const employeeBody = (category: string) => ({
  name: "홍길동",
  department: "",
  color: "#4f7cff",
  workDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  emergencyContact: "",
  approvalRoles: ["담당", "센터장"],
  category,
});

describe("구분 API", () => {
  it("추가·목록(표시 순서)·이름 중복 409·이력", async () => {
    const t = await createTestApp();
    const add = (name: string, sortOrder: number, socialServiceAgent = false) =>
      inject(t, "POST", "/api/categories", { name, sortOrder, socialServiceAgent });
    expect((await add("계약직", 2)).statusCode).toBe(201);
    const agent = await add(" 사회복무요원 ", 1, true);
    expect(agent.json<Category>()).toMatchObject({ name: "사회복무요원", socialServiceAgent: true, employeeCount: 0 });
    expect((await add("계약직", 3)).statusCode).toBe(409);
    const list = (await inject(t, "GET", "/api/categories")).json<Category[]>();
    expect(list.map((c) => c.name)).toEqual(["사회복무요원", "계약직"]);
    expect(queryAll(t.db, "SELECT summary FROM audit_logs WHERE entity = 'category'")).toHaveLength(2);
  });

  it("직원 구분은 비우거나 목록에 있어야 함, 특별휴가 대상 여부는 구분에서 계산", async () => {
    const t = await createTestApp();
    const id = insertCategory(t.db, "사회복무요원", true);
    expect((await inject(t, "POST", "/api/employees", employeeBody("없는구분"))).statusCode).toBe(400);
    const e = (await inject(t, "POST", "/api/employees", employeeBody("사회복무요원"))).json<Employee>();
    expect(e).toMatchObject({ category: "사회복무요원", isSocialServiceAgent: true });
    // 구분에서 특별휴가 대상을 끄면 그 구분 직원 모두 대상이 아님
    await inject(t, "PUT", `/api/categories/${id}`, { name: "사회복무요원", sortOrder: 0, socialServiceAgent: false });
    expect((await inject(t, "GET", "/api/employees")).json<Employee[]>()[0]!.isSocialServiceAgent).toBe(false);
  });

  it("이름을 바꾸면 직원·휴가 종류 적용 대상도 함께, 쓰이는 구분은 삭제 불가", async () => {
    const t = await createTestApp();
    const id = insertCategory(t.db, "계약직");
    const emp = insertEmployee(t.db, { name: "김계약", category: "계약직" });
    const type = insertLeaveType(t.db, { name: "특별휴가" });
    const typeBody = (categories: string[]) => ({
      name: "특별휴가",
      deducts: true,
      balanceMode: "yearly",
      sortOrder: 0,
      target: { categories },
    });
    await inject(t, "PUT", `/api/leave-types/${type}`, typeBody(["계약직"]));

    const renamed = await inject(t, "PUT", `/api/categories/${id}`, { name: "기간제", sortOrder: 0, socialServiceAgent: false });
    expect(renamed.json<Category>()).toMatchObject({ name: "기간제", employeeCount: 1 });
    expect((await inject(t, "GET", "/api/employees")).json<Employee[]>()[0]!.category).toBe("기간제");
    const types = (await inject(t, "GET", "/api/leave-types")).json<{ target: { categories: string[] } }[]>();
    expect(types[0]!.target.categories).toEqual(["기간제"]);
    const balances = (await inject(t, "GET", `/api/balances?employeeId=${emp}&year=2026`)).json<{ name: string }[]>();
    expect(balances.map((b) => b.name)).toEqual(["특별휴가"]);

    const del1 = await inject(t, "DELETE", `/api/categories/${id}`);
    expect(del1.statusCode).toBe(409);
    expect(del1.json().error).toContain("직원이 1명");
    await inject(t, "PUT", `/api/employees/${emp}`, employeeBody(""));
    const del2 = await inject(t, "DELETE", `/api/categories/${id}`);
    expect(del2.statusCode).toBe(409);
    expect(del2.json().error).toContain("적용 대상으로 쓰는 휴가 종류(특별휴가)");
    await inject(t, "PUT", `/api/leave-types/${type}`, { ...typeBody([]), target: null });
    expect((await inject(t, "DELETE", `/api/categories/${id}`)).statusCode).toBe(204);
    expect((await inject(t, "DELETE", `/api/categories/${id}`)).statusCode).toBe(404);
  });
});
