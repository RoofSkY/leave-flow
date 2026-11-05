# 사용 현황·변경 이력 (`routes/usage.ts`, `routes/auditLogs.ts`)

- GET `/api/usage?year=` → `UsageReport` (활성 직원 + 그 해 기록이 있는 비활성 직원, 활성 휴가 종류)
- GET `/api/audit-logs?from=&to=&entity=&employeeId=&action=&page=1&pageSize=50` → `AuditLogPage` (최근순). `employeeId`는 대상이 여러 명인 시간외근무 신청서 이력(employee_id 없음)도 현재 대상 또는 변경 전·후 `targets`에 그 직원이 있으면 찾음

공통 규칙은 [API](index.md)를 보세요.
