// 시간외근무 화면·양식에서 함께 쓰는 표시 문구
import {
  formatDotDate,
  type OvertimeCategory,
  type OvertimeRequest,
  type OvertimeTarget,
} from "@leave-flow/shared";

export const CATEGORY_LABEL: Record<OvertimeCategory, string> = {
  official_event: "공식행사",
  special_work: "특별근무",
  special_leave: "특별휴가",
  award: "시상",
};

export const KIND_LABEL = {
  general: "일반 시간외근무",
  soldier: "사회복무요원 특별휴가",
  award: "사회복무요원 특별휴가(시상)",
} as const;

/** 요원·시상 발생 일수 */
export function targetDays(t: OvertimeTarget): number {
  return t.days ?? 0;
}

/** 일반: "홍길동, 김철수" / 요원·시상: "박요원 1일, 최요원 2일" */
export function targetSummary(req: OvertimeRequest): string {
  return req.kind === "general"
    ? req.targets.map((t) => t.employeeName).join(", ")
    : req.targets.map((t) => `${t.employeeName} ${targetDays(t)}일`).join(", ");
}

/** "2026-10-19" → "2026.10.19" (양식 제출일자) */
export function dotDate(date: string): string {
  return formatDotDate(date).replace(/\.$/, "");
}

/**
 * 받침에 맞는 조사: withJosa("대체휴가", "이", "가") → "대체휴가가".
 * 끝의 괄호는 건너뛰고 그 앞 글자로 판단: "대체휴가(직원)" → "대체휴가(직원)가"
 */
export function withJosa(word: string, withBatchim: string, withoutBatchim: string): string {
  const base = word.replace(/\s*\([^()]*\)$/, "");
  const code = base.charCodeAt(base.length - 1) - 0xac00;
  if (Number.isNaN(code) || code < 0 || code > 11171) return `${word}${withBatchim}(${withoutBatchim})`;
  return word + (code % 28 ? withBatchim : withoutBatchim);
}
