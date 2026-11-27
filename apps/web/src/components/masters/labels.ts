// 기준정보 화면 표시용 문구
import {
  WEEKDAY_LABELS,
  type BalanceMode,
  type LeaveType,
  type LeaveTypeTarget,
} from "@leave-flow/shared";

/** 월요일부터 (0=일 … 6=토) */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** 근무 요일 표시: 4일 이상 연속이면 "월~금", 아니면 "월·화·수" */
export function formatWorkDays(days: readonly number[]): string {
  const sorted = WEEKDAY_ORDER.filter((d) => days.includes(d));
  if (sorted.length === 0) return "-";
  const idx = sorted.map((d) => WEEKDAY_ORDER.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  if (contiguous && sorted.length >= 4) {
    return `${WEEKDAY_LABELS[sorted[0]!]}~${WEEKDAY_LABELS[sorted[sorted.length - 1]!]}`;
  }
  return sorted.map((d) => WEEKDAY_LABELS[d]).join("·");
}

export const BALANCE_MODE_LABELS: Record<BalanceMode, { name: string; desc: string }> = {
  yearly: { name: "연도별", desc: "해마다 새로 시작" },
  cumulative: { name: "누적", desc: "해를 넘겨 쌓임" },
  expire_date: { name: "정한 날짜에 소멸", desc: "매년 소멸일이 지나면 남은 양이 사라짐" },
  grant_period: { name: "부여 후 기간", desc: "부여마다 정한 기간이 지나면 남은 양이 사라짐" },
  used_up: { name: "소진", desc: "해를 넘겨 쌓이고, 남은 양이 없으면 휴가원에서 숨길 수 있음" },
};

/** 적용 대상 한 줄: "아동사업부의 직원", "사회복무요원 + 홍길동", "아동사업부·가족사업부 + 홍길동 외 3명" (고른 것이 없으면 "") */
export function targetRuleText(target: LeaveTypeTarget, employeeName: (id: number) => string): string {
  const { departments, categories } = target;
  const names = target.employeeIds.map(employeeName);
  const people = names.length <= 2 ? names.join(", ") : `${names[0]} 외 ${names.length - 1}명`;
  // 소속과 구분을 함께 고르면 둘 다 맞아야 함
  const rule =
    departments.length && categories.length
      ? `${departments.join("·")}의 ${categories.join("·")}`
      : [...departments, ...categories].join("·");
  return [rule, people].filter(Boolean).join(" + ");
}

type BalanceRule = Pick<LeaveType, "balanceMode" | "expireMonth" | "expireDay" | "validMonths">;

/** 잔여 방식 설명: "해마다 새로 시작", "매년 2월 28일 소멸", "부여 후 12개월 동안 사용" */
export function balanceRuleText(t: BalanceRule & Pick<LeaveType, "hideWhenEmpty">): string {
  if (t.balanceMode === "expire_date") return `매년 ${t.expireMonth}월 ${t.expireDay}일 소멸`;
  if (t.balanceMode === "grant_period") return `부여 후 ${t.validMonths}개월 동안 사용`;
  if (t.balanceMode === "used_up") {
    return t.hideWhenEmpty ? "해를 넘겨 쌓이고, 남은 양이 없으면 휴가원에서 숨김" : "해를 넘겨 쌓임";
  }
  return BALANCE_MODE_LABELS[t.balanceMode].desc;
}
