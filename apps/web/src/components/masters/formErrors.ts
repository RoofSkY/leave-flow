// 입력 검사 결과를 항목별 오류 메시지로 (화면·서버가 같은 shared 스키마 사용)
import type { z } from "zod";
import { ApiRequestError } from "../../lib/api.ts";

export type FieldErrors = Partial<Record<string, string>>;

interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

function issuesToFieldErrors(issues: readonly Issue[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = String(i.path[0] ?? "");
    if (key && !out[key]) out[key] = i.message;
  }
  return out;
}

/** 저장 전에 화면에서 먼저 검사. 실패하면 항목별 메시지 */
export function checkInput<S extends z.ZodType>(
  schema: S,
  data: unknown,
): { ok: true; data: z.output<S> } | { ok: false; errors: FieldErrors } {
  const r = schema.safeParse(data);
  return r.success ? { ok: true, data: r.data } : { ok: false, errors: issuesToFieldErrors(r.error.issues) };
}

/** 서버 입력 오류(400)의 details → 항목별 메시지 */
export function apiFieldErrors(err: unknown): FieldErrors {
  if (err instanceof ApiRequestError && Array.isArray(err.details)) {
    return issuesToFieldErrors(err.details as Issue[]);
  }
  return {};
}
