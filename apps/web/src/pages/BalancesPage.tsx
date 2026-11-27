import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  balanceScopeText,
  columnBalances,
  dayMinutesOf,
  formatDotDate,
  formatLeaveMinutes,
  leaveTypeColumns,
  localToday,
  type BalanceRow,
  type LeaveType,
  type LeaveTypeColumn,
  type UsageReport,
} from "@leave-flow/shared";
import { ReportActions, ReportPrintHeader } from "../components/admin-reports/ReportExport.tsx";
import { YearSelect } from "../components/admin-reports/YearSelect.tsx";
import { EmployeeFilter, NO_FILTER, filterMatches, type EmployeeFilterValue } from "../components/form/EmployeeFilter.tsx";
import { Checkbox, ColorDot, EmptyState, ErrorText, PageHeader, Spinner, TextInput } from "../components/ui/index.tsx";
import { api, qs } from "../lib/api.ts";
import { currentYear } from "../lib/format.ts";
import { qk } from "../lib/queries.ts";
import "./BalancesPage.css";

/** 인쇄 부제목에 넣을 조건: "소속 아동사업부 · 구분 직원 · 직원 홍길동" */
function filterText(filter: EmployeeFilterValue, rows: UsageReport["rows"]): string {
  const nameOf = new Map(rows.map((r) => [r.employee.id, r.employee.name]));
  const names = filter.employeeIds.map((id) => nameOf.get(id)).filter((n) => n !== undefined);
  return [
    filter.departments.length ? `소속 ${filter.departments.join("·")}` : "",
    filter.categories.length ? `구분 ${filter.categories.join("·")}` : "",
    names.length ? `직원 ${names.join("·")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 잔여 칸: 잔여를 크게, 부여·사용을 작게 (1일 = 그 직원의 하루 근무시간) */
function RemainingCell({
  rows,
  dayMinutes,
  scopeOf,
}: {
  /** 이 직원의 그 열 종류들 (보통 하나, 소속·구분이 바뀐 직원은 둘 이상) */
  rows: BalanceRow[];
  dayMinutes: number;
  /** 열 머리글에 기간이 없을 때 칸마다 보일 기간 */
  scopeOf: ((row: BalanceRow) => string) | null;
}) {
  const shown = rows.filter((row) => row.remainingMinutes !== null);
  if (shown.length === 0) return <td className="bal-cell faint">-</td>;
  const f = (m: number) => formatLeaveMinutes(m, dayMinutes);
  const tone = (r: number) => (r < 0 ? "is-negative" : r === 0 ? "is-zero" : "");
  if (shown.length === 1) {
    const row = shown[0]!;
    const r = row.remainingMinutes!;
    return (
      <td className={`bal-cell ${tone(r)}`}>
        <div className="bal-remaining num">{f(r)}</div>
        <div className="bal-sub num">
          부여 {f(row.grantedMinutes)} · 사용 {f(row.usedMinutes)}
        </div>
        {scopeOf && <div className="bal-sub">{scopeOf(row)}</div>}
      </td>
    );
  }
  // 같은 표시 이름의 종류가 둘 이상 (소속·구분이 바뀐 직원): 관리 이름으로 나눠 보임
  return (
    <td className="bal-cell">
      {shown.map((row) => (
        <div key={row.leaveTypeId} className={`bal-split ${tone(row.remainingMinutes!)}`}>
          <div className="bal-sub">{row.name}</div>
          <div className="bal-remaining num">{f(row.remainingMinutes!)}</div>
          <div className="bal-sub num">
            부여 {f(row.grantedMinutes)} · 사용 {f(row.usedMinutes)}
          </div>
        </div>
      ))}
    </td>
  );
}

/** 차감하지 않는 종류(공가 등): 사용만 */
function UsedCell({ rows, dayMinutes }: { rows: BalanceRow[]; dayMinutes: number }) {
  const used = rows.reduce((sum, row) => sum + row.usedMinutes, 0);
  return (
    <td className={`bal-cell ${used === 0 ? "is-zero" : ""}`}>
      <div className="bal-used num">{formatLeaveMinutes(used, dayMinutes)}</div>
    </td>
  );
}

/** 직원별 휴가 종류 잔여를 한눈에 (모든 직원이 볼 수 있는 화면) */
export function BalancesPage() {
  const [year, setYear] = useState(currentYear);
  const [filter, setFilter] = useState(NO_FILTER);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const usage = useQuery({
    queryKey: qk.usage(year),
    queryFn: () => api.get<UsageReport>(`/api/usage${qs({ year })}`),
  });
  const report = usage.data;
  const scopeOf = (t: LeaveType) => balanceScopeText(t, year, localToday());
  const deducting = leaveTypeColumns(report?.leaveTypes.filter((t) => t.deducts) ?? [], scopeOf);
  const usedOnly = leaveTypeColumns(report?.leaveTypes.filter((t) => !t.deducts) ?? [], scopeOf);
  const typeById = new Map(report?.leaveTypes.map((t) => [t.id, t]) ?? []);
  const rowScope = (row: BalanceRow) => {
    const t = typeById.get(row.leaveTypeId);
    return t ? scopeOf(t) : "";
  };
  const keyword = search.trim();
  const rows = (report?.rows ?? []).filter(
    (r) =>
      (showInactive || r.employee.active) &&
      filterMatches(filter, r.employee) &&
      (!keyword || r.employee.name.includes(keyword)),
  );
  const hasInactive = (report?.rows ?? []).some((r) => !r.employee.active);
  const reportTitle = `${year}년 잔여 현황`;
  const reportSubtitle = [
    `출력 ${formatDotDate(localToday())}`,
    filterText(filter, report?.rows ?? []),
    keyword ? `이름 검색 "${keyword}"` : "",
    hasInactive && showInactive ? "퇴사·비활성 직원 포함" : "",
    "1일 = 직원별 하루 근무시간",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="page">
      <PageHeader
        title="잔여 현황"
        description="직원별로 휴가 종류마다 남은 양을 보여 줍니다. 연도별 종류는 그 해 기준, 누적 종류는 그 해까지 쌓인 양입니다. (1일 = 직원별 하루 근무시간)"
        actions={
          <ReportActions disabled={!rows.length} />
        }
      />
      <ReportPrintHeader title={reportTitle} subtitle={reportSubtitle} />
      <div className="bal-toolbar no-print">
        <YearSelect value={year} onChange={setYear} />
        <EmployeeFilter value={filter} onChange={setFilter} />
        <TextInput
          type="search"
          placeholder="이름 검색"
          aria-label="이름 검색"
          value={search}
          style={{ width: 160 }}
          onChange={(e) => setSearch(e.target.value)}
        />
        {hasInactive && <Checkbox label="퇴사·비활성 직원 포함" checked={showInactive} onChange={setShowInactive} />}
      </div>

      {usage.isPending ? (
        <Spinner />
      ) : usage.error ? (
        <ErrorText error={usage.error} />
      ) : !report || report.leaveTypes.length === 0 ? (
        <EmptyState title="등록된 휴가 종류가 없습니다.">
          <Link to="/admin/leave-types">휴가 종류 등록하기</Link>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title={report.rows.length === 0 ? "직원이 없습니다." : "조건에 맞는 직원이 없습니다."} />
      ) : (
        <div className="table-wrap">
          <table className="table bal-table">
            <thead>
              <tr>
                <th className="bal-sticky">직원</th>
                {deducting.map((c) => (
                  <th key={c.label} className="bal-head" title={c.types.map((t) => t.name).join(", ")}>
                    {c.label}
                    <span className="bal-head-mode">{c.scope ?? "기간은 칸마다 다름"}</span>
                  </th>
                ))}
                {usedOnly.map((c) => (
                  <th key={c.label} className="bal-head bal-head-used" title={c.types.map((t) => t.name).join(", ")}>
                    {c.label}
                    <span className="bal-head-mode">사용 (차감 안 함)</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ employee, balances }) => {
                const byType = new Map(balances.map((b) => [b.leaveTypeId, b]));
                const rowsOf = (c: LeaveTypeColumn) => columnBalances(c, byType);
                return (
                  <tr key={employee.id} className={employee.active ? undefined : "inactive"}>
                    <th scope="row" className="bal-sticky">
                      <div className="bal-employee">
                        <ColorDot color={employee.color} />
                        <span>
                          <span className="bal-name">{employee.name}</span>
                          <span className="bal-dept">
                            {employee.department || "소속 없음"}
                            {employee.active ? "" : " · 비활성"}
                          </span>
                        </span>
                      </div>
                    </th>
                    {deducting.map((c) => (
                      <RemainingCell
                        key={c.label}
                        rows={rowsOf(c)}
                        dayMinutes={dayMinutesOf(employee)}
                        scopeOf={c.scope === null ? rowScope : null}
                      />
                    ))}
                    {usedOnly.map((c) => (
                      <UsedCell key={c.label} rows={rowsOf(c)} dayMinutes={dayMinutesOf(employee)} />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
