import { Fragment, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AuditAction, AuditEntity, AuditLog, AuditLogPage as AuditLogPageData } from "@leave-flow/shared";
import { AuditDiff } from "../../components/admin-reports/AuditDiff.tsx";
import { ACTION_LABELS, ENTITY_LABELS } from "../../components/admin-reports/labels.ts";
import "../../components/admin-reports/admin-reports.css";
import { DateInput, EmployeeSelect } from "../../components/form/index.tsx";
import { Badge, Button, EmptyState, ErrorText, Field, PageHeader, Select, Spinner } from "../../components/ui/index.tsx";
import { api, qs } from "../../lib/api.ts";
import { formatTimestamp } from "../../lib/format.ts";
import { qk, useEmployees } from "../../lib/queries.ts";

const PAGE_SIZE = 50;

interface Filters {
  from: string;
  to: string;
  entity: AuditEntity | "";
  employeeId: number | null;
  action: AuditAction | "";
}

const EMPTY_FILTERS: Filters = { from: "", to: "", entity: "", employeeId: null, action: "" };

function actionTone(action: AuditAction): "danger" | "success" | "warning" | "accent" | undefined {
  switch (action) {
    case "create":
    case "accrue":
      return "success";
    case "cancel":
    case "delete":
    case "deactivate":
      return "danger";
    case "recalculate":
    case "restore_backup":
      return "warning";
    case "update":
      return "accent";
    default:
      return undefined;
  }
}

export function AuditLogPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const employees = useEmployees(true);

  const params = { ...filters, page, pageSize: PAGE_SIZE };
  const logs = useQuery({
    queryKey: qk.auditLogs(params),
    queryFn: () => api.get<AuditLogPageData>(`/api/audit-logs${qs(params)}`),
    placeholderData: keepPreviousData,
  });

  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
    setOpenId(null);
  };
  const goPage = (p: number) => {
    setPage(p);
    setOpenId(null);
  };
  const toggle = (log: AuditLog) => setOpenId((id) => (id === log.id ? null : log.id));

  const total = logs.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="stack">
      <PageHeader title="변경 이력" description="모든 추가·수정·취소·복구·삭제 기록입니다. 줄을 누르면 변경 전·후 값을 볼 수 있습니다." />

      <div className="audit-filters">
        <Field label="기간">
          <div className="audit-range">
            <DateInput value={filters.from} max={filters.to || undefined} onChange={(v) => update({ from: v })} ariaLabel="시작일" />
            <span className="muted">~</span>
            <DateInput value={filters.to} min={filters.from || undefined} onChange={(v) => update({ to: v })} ariaLabel="종료일" />
          </div>
        </Field>
        <Field label="대상">
          <Select value={filters.entity} onChange={(e) => update({ entity: e.target.value as Filters["entity"] })}>
            <option value="">전체</option>
            {Object.entries(ENTITY_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="직원">
          <EmployeeSelect
            employees={employees.data ?? []}
            value={filters.employeeId}
            placeholder="전체"
            onChange={(id) => update({ employeeId: id })}
          />
        </Field>
        <Field label="작업">
          <Select value={filters.action} onChange={(e) => update({ action: e.target.value as Filters["action"] })}>
            <option value="">전체</option>
            {Object.entries(ACTION_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </Field>
        <Button className="audit-filters-reset" disabled={!filtered} onClick={() => update(EMPTY_FILTERS)}>
          초기화
        </Button>
      </div>

      {logs.isPending ? (
        <Spinner />
      ) : logs.error ? (
        <ErrorText error={logs.error} />
      ) : logs.data.rows.length === 0 ? (
        <EmptyState title={filtered ? "조건에 맞는 변경 이력이 없습니다." : "변경 이력이 없습니다."} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table audit-table">
              <thead>
                <tr>
                  <th>일시</th>
                  <th>IP</th>
                  <th>대상</th>
                  <th>작업</th>
                  <th>내용</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.rows.map((log) => {
                  const open = openId === log.id;
                  return (
                    <Fragment key={log.id}>
                      <tr
                        className={["audit-row", open && "audit-row-open"].filter(Boolean).join(" ")}
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => toggle(log)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle(log);
                          }
                        }}
                      >
                        <td className="nowrap num">{formatTimestamp(log.at)}</td>
                        <td className="nowrap mono muted">{log.ip || "-"}</td>
                        <td className="nowrap">
                          {ENTITY_LABELS[log.entity] ?? log.entity}
                          {log.entityId !== null && <span className="faint"> #{log.entityId}</span>}
                        </td>
                        <td>
                          <Badge tone={actionTone(log.action)}>{ACTION_LABELS[log.action] ?? log.action}</Badge>
                        </td>
                        <td className="audit-summary">{log.summary}</td>
                      </tr>
                      {open && (
                        <tr className="audit-detail">
                          <td colSpan={5}>
                            <AuditDiff before={log.before} after={log.after} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="report-pager">
            <span className="muted">총 {total.toLocaleString("ko-KR")}건</span>
            <span className="spacer" />
            <Button size="sm" disabled={page <= 1 || logs.isFetching} onClick={() => goPage(page - 1)}>
              이전
            </Button>
            <span className="num muted">
              {page} / {pages}
            </span>
            <Button size="sm" disabled={page >= pages || logs.isFetching} onClick={() => goPage(page + 1)}>
              다음
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
