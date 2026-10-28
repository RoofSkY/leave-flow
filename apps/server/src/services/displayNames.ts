// 표시 이름이 같은 휴가 종류(예: 연차(직원)·연차(강사) → "연차")는 한 직원에게 하나만 적용되어야 한다.
import { leaveTypeAppliesTo, leaveTypeLabel, type LeaveType } from "@leave-flow/shared";
import type { Db } from "../db/index.ts";
import { conflict } from "../lib/errors.ts";
import { listEmployees, listLeaveTypes } from "./queries.ts";

/**
 * 활성 직원에게 보이는 이름이 같은 활성 휴가 종류가 둘 이상 적용되면 409.
 * 휴가 종류·직원을 저장한 뒤 같은 트랜잭션 안에서 부름 (409 면 저장도 취소됨).
 * 소속·구분 이름 변경은 직원과 적용 대상이 함께 바뀌고, 쓰이는 소속·구분은 삭제할 수 없어 따로 부를 필요 없음.
 */
export function assertNoDisplayNameOverlap(db: Db): void {
  const groups = new Map<string, LeaveType[]>();
  for (const t of listLeaveTypes(db)) {
    const label = leaveTypeLabel(t);
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  const shared = [...groups].filter(([, types]) => types.length > 1);
  if (shared.length === 0) return;

  const problems: string[] = [];
  for (const e of listEmployees(db)) {
    for (const [label, types] of shared) {
      const hits = types.filter((t) => leaveTypeAppliesTo(t, e));
      if (hits.length > 1) problems.push(`${e.name}: '${label}' ${hits.length}개 - ${hits.map((t) => t.name).join(", ")}`);
    }
  }
  if (problems.length === 0) return;
  const more = problems.length > 3 ? ` 외 ${problems.length - 3}건` : "";
  throw conflict(
    `표시 이름이 같은 휴가 종류가 한 직원에게 둘 이상 적용됩니다. 적용 대상이 겹치지 않게 하세요. (${problems.slice(0, 3).join(" / ")}${more})`,
  );
}
