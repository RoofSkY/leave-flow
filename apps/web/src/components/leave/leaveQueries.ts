// 휴가원·달력·부재자 조회 (키는 qk 기준)
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Absences, CalendarEvent, DocStatus, LeavePrintData, LeaveRequest, WorkSchedule } from "@leave-flow/shared";
import { api, qs } from "../../lib/api.ts";
import { qk } from "../../lib/queries.ts";

/** 달력 일정 + 휴가원에 저장된 신청(수정) 시점 근무 일정 (주 보기에서 날마다 나눌 때 사용) */
export type ScheduledCalendarEvent = CalendarEvent & WorkSchedule;

/** 취소된 일정도 함께 받아 화면에서 거름 (보기 전환 시 다시 부르지 않도록) */
export function useCalendarEvents(from: string, to: string) {
  return useQuery({
    queryKey: qk.calendarEvents(from, to),
    queryFn: () =>
      api.get<ScheduledCalendarEvent[]>(`/api/calendar/events${qs({ from, to, includeCancelled: true })}`),
    placeholderData: keepPreviousData,
  });
}

export type LeaveListStatus = DocStatus | "all";

export interface LeaveListParams {
  employeeId?: number | null;
  /** 기본 active */
  status?: LeaveListStatus;
  /** 항목 기간이 [from, to] 와 겹치는 휴가원 */
  from?: string;
  to?: string;
}

/** 휴가원 목록 (첫 항목 시작 내림차순) */
export function useLeaveRequests(params: LeaveListParams) {
  const p = { employeeId: params.employeeId ?? null, status: params.status ?? "active", from: params.from, to: params.to };
  return useQuery({
    queryKey: qk.leaveRequests(p),
    queryFn: () => api.get<LeaveRequest[]>(`/api/leave-requests${qs(p)}`),
    placeholderData: keepPreviousData,
  });
}

export function useAbsences(date: string) {
  return useQuery({
    queryKey: qk.absences(date),
    queryFn: () => api.get<Absences>(`/api/absences${qs({ date })}`),
  });
}

export function useLeaveRequest(id: number) {
  return useQuery({
    queryKey: qk.leaveRequest(id),
    queryFn: () => api.get<LeaveRequest>(`/api/leave-requests/${id}`),
  });
}

/** 출력 미리보기 데이터 (휴가원 상세 키 아래에 두어 invalidateLeaveData 로 함께 갱신) */
export const leavePrintKey = (id: number) => [...qk.leaveRequest(id), "print-data"] as const;

export function useLeavePrintData(id: number) {
  return useQuery({
    queryKey: leavePrintKey(id),
    queryFn: () => api.get<LeavePrintData>(`/api/leave-requests/${id}/print-data`),
    enabled: Number.isInteger(id) && id > 0,
    retry: false,
  });
}

/** 출력 양식 업무인계 칸에서 대략 차지하는 줄 수 (한 줄 약 40자) */
export function estimateHandoverLines(text: string): number {
  if (!text.trim()) return 0;
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 40)), 0);
}

/** "#RRGGBB" → 옅은 배경색 */
export function tint(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(79, 124, 255, ${alpha})`;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}

/** 짧은 기간 표시: 같은 날 "10:00~19:00" (withDate면 "10/1 10:00~19:00"), 여러 날 "10/1 14:00 ~ 10/3 12:00" */
export function shortRange(startAt: string, endAt: string, withDate = false): string {
  const md = (dt: string) => `${Number(dt.slice(5, 7))}/${Number(dt.slice(8, 10))}`;
  const time = (dt: string) => dt.slice(11, 16);
  if (startAt.slice(0, 10) === endAt.slice(0, 10)) {
    return `${withDate ? `${md(startAt)} ` : ""}${time(startAt)}~${time(endAt)}`;
  }
  return `${md(startAt)} ${time(startAt)} ~ ${md(endAt)} ${time(endAt)}`;
}
