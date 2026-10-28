// 시간외근무 신청서 API 호출과 조회 훅
import { useQuery } from "@tanstack/react-query";
import {
  leaveTypeAppliesTo,
  type Employee,
  type OvertimeInput,
  type OvertimeKind,
  type OvertimePrintData,
  type OvertimeRequest,
  type OvertimeTarget,
} from "@leave-flow/shared";
import { api, qs } from "../../lib/api.ts";
import { qk, useLeaveTypes } from "../../lib/queries.ts";

export const overtimeApi = {
  create: (input: OvertimeInput) => api.post<OvertimeRequest>("/api/overtime", input),
  /** baseUpdatedAt: 수정을 시작할 때 본 신청서의 updatedAt (그 사이 다른 사람이 고쳤으면 409) */
  update: (id: number, input: OvertimeInput, baseUpdatedAt: string) =>
    api.put<OvertimeRequest>(`/api/overtime/${id}`, { ...input, baseUpdatedAt }),
  cancel: (id: number) => api.post<OvertimeRequest>(`/api/overtime/${id}/cancel`),
  restore: (id: number) => api.post<OvertimeRequest>(`/api/overtime/${id}/restore`),
  printData: (id: number) => api.get<OvertimePrintData>(`/api/overtime/${id}/print-data`),
  /** 출력 기록 (일반은 첫 출력 때 제출·적립) */
  print: (id: number) => api.post<OvertimePrintData>(`/api/overtime/${id}/print`),
};

export function useOvertimeList(params: { kind: OvertimeKind; year: number; status: "active" | "all" }) {
  return useQuery({
    queryKey: qk.overtimeList(params),
    queryFn: () => api.get<OvertimeRequest[]>(`/api/overtime${qs(params)}`),
  });
}

/** 신청서에서 대상자마다 고르는 적립 휴가 종류 */
export function useAccrualTypes() {
  const types = useLeaveTypes(true);
  const allTypes = types.data ?? [];
  /** 이 직원이 고를 수 있는 종류: 적용되는 활성 종류 + 수정 중이면 원래 고른 종류 (비활성이거나 적용 대상에서 빠졌어도) */
  const optionsFor = (e: Employee, keepId?: number) =>
    allTypes.filter((t) => t.id === keepId || (t.active && leaveTypeAppliesTo(t, e)));
  /** 대상자들의 적립 종류 이름 (겹치지 않게, 대상 순서): "대체휴가(직원)·대체휴가(요원)" */
  const namesOf = (targets: readonly OvertimeTarget[]) =>
    [...new Set(targets.map((t) => allTypes.find((x) => x.id === t.leaveTypeId)?.name).filter((n) => n !== undefined))].join("·");
  return { loading: types.isPending, optionsFor, namesOf };
}
