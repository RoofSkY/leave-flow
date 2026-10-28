import type { FastifyRequest } from "fastify";
import { isDateString } from "@leave-flow/shared";
import type { z } from "zod";
import { badRequest } from "./errors.ts";

/** 입력 검사. 실패하면 첫 번째 오류 메시지로 400 */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw badRequest(first?.message ?? "입력값이 올바르지 않습니다.", r.error.issues);
}

/** URL 경로의 :id */
export function parseId(params: unknown): number {
  const raw = (params as Record<string, unknown> | undefined)?.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("잘못된 ID입니다.");
  return id;
}

/** 쿼리스트링 정수 (없으면 undefined) */
export function queryInt(query: unknown, key: string): number | undefined {
  const raw = (query as Record<string, unknown> | undefined)?.[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw badRequest(`${key} 값이 올바르지 않습니다.`);
  return n;
}

export function queryStr(query: unknown, key: string): string | undefined {
  const raw = (query as Record<string, unknown> | undefined)?.[key];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** 쿼리스트링 날짜 (없으면 undefined, 형식이 틀리면 400) */
export function dateQuery(query: unknown, key: string): string | undefined {
  const v = queryStr(query, key);
  if (v !== undefined && !isDateString(v)) throw badRequest("날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)");
  return v;
}

export function queryBool(query: unknown, key: string): boolean {
  const raw = queryStr(query, key);
  return raw === "1" || raw === "true";
}

/** 접속 PC의 IP (변경 이력 기록용) */
export function clientIp(req: FastifyRequest): string {
  return (req.ip ?? "").replace(/^::ffff:/, "");
}
