// 여러 화면이 함께 쓰는 서버 데이터 조회 (TanStack Query). 키는 qk 로만 만들 것.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { BalanceRow, Category, Department, Employee, Holiday, LeaveType, Settings } from "@leave-flow/shared";
import { api, qs } from "./api.ts";

export const qk = {
  employees: (includeInactive = false, includeDeleted = false) => ["employees", { includeInactive, includeDeleted }] as const,
  leaveTypes: (includeInactive = false) => ["leave-types", { includeInactive }] as const,
  settings: () => ["settings"] as const,
  departments: () => ["departments"] as const,
  categories: () => ["categories"] as const,
  balances: (employeeId: number, year: number) => ["balances", employeeId, year] as const,
  /** 공휴일 전체 (무효화용 앞부분 키) */
  holidaysAll: () => ["holidays"] as const,
  holidays: (from: string, to: string, includeInactive = false) =>
    ["holidays", from, to, { includeInactive }] as const,
  grants: (params: object = {}) => ["grants", params] as const,
  openingBalances: (params: object = {}) => ["opening-balances", params] as const,
  leaveRequests: (params: object = {}) => ["leave-requests", params] as const,
  leaveRequest: (id: number) => ["leave-requests", "detail", id] as const,
  calendarEvents: (from: string, to: string) => ["calendar-events", from, to] as const,
  absences: (date: string) => ["absences", date] as const,
  overtimeList: (params: object = {}) => ["overtime", params] as const,
  overtime: (id: number) => ["overtime", "detail", id] as const,
  usage: (year: number) => ["usage", year] as const,
  auditLogs: (params: object = {}) => ["audit-logs", params] as const,
  system: () => ["system"] as const,
  backups: () => ["backups"] as const,
};

/** includeDeleted: 영구 삭제된 직원도 (남은 기록을 거를 때만. 고르는 목록에는 쓰지 말 것) */
export function useEmployees(includeInactive = false, includeDeleted = false) {
  return useQuery({
    queryKey: qk.employees(includeInactive, includeDeleted),
    queryFn: () => api.get<Employee[]>(`/api/employees${qs({ includeInactive, includeDeleted })}`),
  });
}

export function useLeaveTypes(includeInactive = false) {
  return useQuery({
    queryKey: qk.leaveTypes(includeInactive),
    queryFn: () => api.get<LeaveType[]>(`/api/leave-types${qs({ includeInactive })}`),
  });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings(), queryFn: () => api.get<Settings>("/api/settings") });
}

/** 소속 목록 (표시 순서) */
export function useDepartments() {
  return useQuery({ queryKey: qk.departments(), queryFn: () => api.get<Department[]>("/api/departments") });
}

export function useCategories() {
  return useQuery({ queryKey: qk.categories(), queryFn: () => api.get<Category[]>("/api/categories") });
}

export function useBalances(employeeId: number | null | undefined, year: number) {
  return useQuery({
    queryKey: qk.balances(employeeId ?? 0, year),
    queryFn: () => api.get<BalanceRow[]>(`/api/balances${qs({ employeeId, year })}`),
    enabled: !!employeeId,
  });
}

export function useHolidays(from: string, to: string, includeInactive = false) {
  return useQuery({
    queryKey: qk.holidays(from, to, includeInactive),
    queryFn: () => api.get<Holiday[]>(`/api/holidays${qs({ from, to, includeInactive })}`),
  });
}

/**
 * 휴가·부여·잔여에 영향을 주는 변경 뒤 호출 (휴가원 저장·취소, 부여 변경, 시간외근무 적립, 공휴일 변경 등).
 * 관련된 화면 데이터를 모두 새로 불러옴.
 */
export function invalidateLeaveData(qc: QueryClient): Promise<void> {
  const keys = [
    "leave-requests",
    "calendar-events",
    "absences",
    "balances",
    "usage",
    "audit-logs",
    "grants",
    "opening-balances",
    "overtime",
    "leave-types",
  ];
  return Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] }))).then(() => undefined);
}
