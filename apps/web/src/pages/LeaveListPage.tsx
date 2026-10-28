import { useQueryClient } from "@tanstack/react-query";
import { addDays, dayMinutesOf, formatLeaveMinutes, formatPeriod, needsReprint, type LeaveRequest } from "@leave-flow/shared";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { LeaveDetailModal } from "../components/leave/LeaveDetailModal.tsx";
import { LeaveEditor, type EditorTarget } from "../components/leave/LeaveEditor.tsx";
import { useLeaveRequests, type LeaveListStatus } from "../components/leave/leaveQueries.ts";
import {
  EmployeeFilter,
  filterFromParams,
  useEmployeeFilterMatch,
  withFilterParams,
} from "../components/form/EmployeeFilter.tsx";
import {
  Badge,
  Button,
  ColorDot,
  EmptyState,
  ErrorText,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui/index.tsx";
import { currentYear, formatDateKo, formatTimestamp } from "../lib/format.ts";
import { qk } from "../lib/queries.ts";
import "../components/leave/leave.css";

const STATUS_OPTIONS: [LeaveListStatus, string][] = [
  ["active", "신청"],
  ["cancelled", "취소됨"],
  ["all", "전체"],
];

type PrintFilter = "" | "none" | "reprint";
const PRINT_OPTIONS: [PrintFilter, string][] = [
  ["", "출력 상태 전체"],
  ["none", "출력 안 함"],
  ["reprint", "다시 출력 필요"],
];

function printMatches(r: LeaveRequest, filter: PrintFilter): boolean {
  if (filter === "none") return !r.lastPrintedAt;
  if (filter === "reprint") return needsReprint(r);
  return true;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 조회 기간: 월을 고르면 그 달, 아니면 그 해 전체 */
function periodOf(year: number, month: number): { from: string; to: string } {
  if (!month) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const from = `${year}-${pad(month)}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return { from, to: addDays(nextMonth, -1) };
}

/** 사용 시간 합계 (1일 = 휴가원에 저장된 근무시간 기준) */
function totalText(r: LeaveRequest): string {
  return formatLeaveMinutes(r.totalMinutes, dayMinutesOf(r));
}

/** 휴가원 목록 (/leave-requests): 기간·상태·직원 필터로 찾아 상세에서 수정·취소·복구·출력 */
export function LeaveListPage() {
  const [params, setParams] = useSearchParams();
  const thisYear = currentYear();
  const year = Number(params.get("year")) || thisYear;
  const monthParam = Number(params.get("month"));
  const month = Number.isInteger(monthParam) && monthParam >= 1 && monthParam <= 12 ? monthParam : 0;
  const filter = filterFromParams(params);
  const statusParam = params.get("status");
  const status: LeaveListStatus = statusParam === "cancelled" || statusParam === "all" ? statusParam : "active";
  const printParam = params.get("print");
  const printFilter: PrintFilter = printParam === "none" || printParam === "reprint" ? printParam : "";
  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const { from, to } = periodOf(year, month);
  const list = useLeaveRequests({ status, from, to });
  const matches = useEmployeeFilterMatch(filter);
  const qc = useQueryClient();

  const [editor, setEditor] = useState<{ key: number; target: EditorTarget } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const editorSeq = useRef(0);
  const openEditor = (target: EditorTarget) => {
    setDetailId(null);
    setEditor({ key: ++editorSeq.current, target });
  };

  const years = [...new Set([thisYear + 1, ...Array.from({ length: 6 }, (_, i) => thisYear - i), year])].sort(
    (a, b) => b - a,
  );
  const all = list.data ?? [];
  const rows = all.filter((r) => printMatches(r, printFilter) && matches(r.employeeId));
  const periodLabel = month ? `${year}년 ${month}월` : `${year}년`;

  return (
    <div className="page">
      <PageHeader
        title="휴가원 목록"
        description="휴가 기간이 조회 기간과 겹치는 휴가원을 보여 줍니다. 줄을 누르면 상세 화면에서 수정·취소·복구·출력할 수 있습니다."
        actions={
          <Button variant="primary" onClick={() => openEditor({ mode: "create" })}>
            휴가원 작성
          </Button>
        }
      />

      <div className="lf-list-filters">
        <Select
          value={year}
          aria-label="연도"
          onChange={(e) => setParam("year", Number(e.target.value) === thisYear ? null : e.target.value)}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}년
            </option>
          ))}
        </Select>
        <Select
          value={month}
          aria-label="월"
          onChange={(e) => setParam("month", e.target.value === "0" ? null : e.target.value)}
        >
          <option value={0}>전체 월</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {m}월
            </option>
          ))}
        </Select>
        <EmployeeFilter value={filter} onChange={(f) => setParams((prev) => withFilterParams(prev, f), { replace: true })} />
        <Select
          value={status}
          aria-label="상태"
          onChange={(e) => setParam("status", e.target.value === "active" ? null : e.target.value)}
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          value={printFilter}
          aria-label="출력 상태"
          onChange={(e) => setParam("print", e.target.value || null)}
        >
          {PRINT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        {list.data && <span className="lf-list-count muted">{rows.length}건</span>}
        {list.isFetching && !list.isPending && <span className="spinner" aria-label="불러오는 중" />}
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorText error={list.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={`${periodLabel} 조건에 맞는 휴가원이 없습니다.`} />
      ) : (
        <div className="table-wrap">
          <table className="table lf-list">
            <thead>
              <tr>
                <th>직원</th>
                <th>종류·기간</th>
                <th className="num">사용 시간</th>
                <th>상태</th>
                <th>신청일</th>
                <th>최근 출력</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={r.status === "cancelled" ? "is-cancelled" : undefined}
                  onClick={() => setDetailId(r.id)}
                >
                  <td className="nowrap">
                    <button
                      type="button"
                      className="lf-list-who"
                      aria-label={`${r.employeeName} 휴가원 상세 보기`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailId(r.id);
                      }}
                    >
                      <ColorDot color={r.color} />
                      {r.employeeName}
                    </button>
                    {r.department && <span className="lf-list-dept">{r.department}</span>}
                    {r.employeeDeleted && <span className="lf-list-dept">삭제된 직원</span>}
                  </td>
                  <td>
                    <ul className="lf-list-periods">
                      {r.items.map((i) => (
                        <li key={i.id}>
                          <span className="lf-list-type">{i.leaveTypeDisplayName}</span>
                          {formatPeriod(i.startAt, i.endAt)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="num nowrap">{totalText(r)}</td>
                  <td>
                    {r.status === "active" ? <Badge tone="accent">신청</Badge> : <Badge tone="danger">취소됨</Badge>}
                  </td>
                  <td className="nowrap">{formatDateKo(r.appliedOn, r.appliedOn.slice(0, 4) !== String(thisYear))}</td>
                  <td className="nowrap">
                    {r.lastPrintedAt ? formatTimestamp(r.lastPrintedAt) : <span className="faint">출력 안 함</span>}
                    {needsReprint(r) && (
                      <div>
                        <Badge tone="warning" title="출력한 뒤에 수정·복구되어 출력한 종이와 내용이 다를 수 있습니다. 다시 출력해 결재를 받으세요.">
                          다시 출력 필요
                        </Badge>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor && (
        <LeaveEditor
          key={editor.key}
          target={editor.target}
          onClose={() => setEditor(null)}
          onSaved={(request) => {
            setEditor(null);
            qc.setQueryData(qk.leaveRequest(request.id), request);
            // 저장 뒤 상세를 열어 바로 출력할 수 있게
            setDetailId(request.id);
          }}
        />
      )}
      {detailId !== null && (
        <LeaveDetailModal
          requestId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={(request) => openEditor({ mode: "edit", request })}
        />
      )}
    </div>
  );
}
