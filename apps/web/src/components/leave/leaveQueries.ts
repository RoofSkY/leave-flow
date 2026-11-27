// 휴가원·달력·부재자 조회 (키는 qk 기준)
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { mergeLeavePeriods } from "@leave-flow/shared";
import type { Absences, CalendarEvent, DocStatus, LeavePrintData, LeaveRequest, WorkSchedule } from "@leave-flow/shared";
import { api, qs } from "../../lib/api.ts";
import { qk } from "../../lib/queries.ts";

/** 취소된 일정도 함께 받아 화면에서 거름 (보기 전환 시 다시 부르지 않도록) */
export function useCalendarEvents(from: string, to: string) {
  return useQuery({
    queryKey: qk.calendarEvents(from, to),
    queryFn: () => api.get<CalendarEvent[]>(`/api/calendar/events${qs({ from, to, includeCancelled: true })}`),
    placeholderData: keepPreviousData,
  });
}

export type LeaveListStatus = DocStatus | "all";

interface LeaveListParams {
  /** 기본 active */
  status?: LeaveListStatus;
  /** 항목 기간이 [from, to] 와 겹치는 휴가원 */
  from?: string;
  to?: string;
}

/** 휴가원 목록 (첫 항목 시작 내림차순) */
export function useLeaveRequests(params: LeaveListParams) {
  const p = { status: params.status ?? "active", from: params.from, to: params.to };
  return useQuery({
    queryKey: qk.leaveRequests(p),
    queryFn: () => api.get<LeaveRequest[]>(`/api/leave-requests${qs(p)}`),
    placeholderData: keepPreviousData,
  });
}

/** 달력 필터 항목별 휴가원 (기간 제한 없이 최근 것부터). 한 번에 LEAVE_PAGE 개씩 더 불러옴 */
const LEAVE_PAGE = 10;

interface LeavePagedParams {
  employeeId?: number;
  /** 직원의 지금 소속·구분 */
  department?: string;
  category?: string;
  status: LeaveListStatus;
}

export function useLeaveRequestPages(params: LeavePagedParams) {
  return useInfiniteQuery({
    queryKey: qk.leaveRequests({ ...params, paged: true }),
    // 다음 쪽이 있는지 알도록 하나 더 받음
    queryFn: ({ pageParam }) =>
      api.get<LeaveRequest[]>(`/api/leave-requests${qs({ ...params, limit: LEAVE_PAGE + 1, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length > LEAVE_PAGE ? pages.length * LEAVE_PAGE : undefined),
    select: (data) => data.pages.flatMap((page) => page.slice(0, LEAVE_PAGE)),
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

/** 휴가원 기간 표시: 이어지는 항목은 한 구간으로 (종류 이름은 겹치지 않게 ", "로 이음) */
export function requestPeriods(r: Pick<LeaveRequest, "items"> & WorkSchedule) {
  return mergeLeavePeriods(r.items, r).map((p) => ({
    ...p,
    key: p.items[0]!.id,
    typeName: [...new Set(p.items.map((i) => i.leaveTypeDisplayName))].join(", "),
    minutes: p.items.reduce((n, i) => n + i.minutes, 0),
  }));
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
