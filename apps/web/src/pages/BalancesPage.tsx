import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  dayMinutesOf,
  formatDotDate,
  formatLeaveMinutes,
  leaveTypeLabel,
  localToday,
  type BalanceRow,
  type LeaveType,
  type UsageReport,
} from "@leave-flow/shared";
import { balanceScopeText } from "../components/masters/labels.ts";
import { ReportActions, ReportPrintHeader, type ReportTable } from "../components/admin-reports/ReportExport.tsx";
import { YearSelect } from "../components/admin-reports/YearSelect.tsx";
import { EmployeeFilter, NO_FILTER, filterMatches, type EmployeeFilterValue } from "../components/form/EmployeeFilter.tsx";
import { Checkbox, ColorDot, EmptyState, ErrorText, PageHeader, Spinner, TextInput } from "../components/ui/index.tsx";
import { api, qs } from "../lib/api.ts";
import { currentYear } from "../lib/format.ts";
import { qk } from "../lib/queries.ts";
import "./BalancesPage.css";

/** 열 하나 = 표시 이름이 같은 휴가 종류 묶음 (예: 연차(직원)·연차(강사) → "연차") */
interface Column {
  label: string;
  types: LeaveType[];
  /** 묶음의 계산 범위가 모두 같으면 머리글에, 다르면 칸마다 표시 */
  scope: string | null;
}

/** 보이는 이름이 같은 종류끼리 한 열로 (한 직원에게는 그중 하나만 적용됨). 표시 순서 유지 */
function columnsOf(types: readonly LeaveType[], scopeOf: (t: LeaveType) => string): Column[] {
  const columns: Column[] = [];
  for (const t of types) {
    const label = leaveTypeLabel(t);
    const col = columns.find((c) => c.label === label);
    if (col) col.types.push(t);
    else columns.push({ label, types: [t], scope: null });
  }
  for (const c of columns) {
    const scopes = new Set(c.types.map(scopeOf));
    c.scope = scopes.size === 1 ? [...scopes][0]! : null;
  }
  return columns;
}

/** 이 직원의 그 열 종류들 (보통 하나, 소속·구분이 바뀐 직원은 둘 이상) */
function rowsOfColumn(c: Column, byType: Map<number, BalanceRow>): BalanceRow[] {
  return c.types.map((t) => byType.get(t.id)).filter((b): b is BalanceRow => b !== undefined);
}

/** 엑셀로 받을 표: 화면과 같은 열·같은 직원. 차감 종류는 잔여·부여·사용(기간이 칸마다 다르면 기간도) 칸으로 나눔 */
function balancesTable(
  rows: UsageReport["rows"],
  deducting: Column[],
  usedOnly: Column[],
  rowScope: (row: BalanceRow) => string,
): ReportTable {
  const head: ReportTable["head"] = [
    [
      { text: "직원", rowSpan: 2 },
      { text: "소속", rowSpan: 2 },
      ...deducting.map((c) => (c.scope ? { text: `${c.label}\n${c.scope}`, colSpan: 3 } : { text: c.label, colSpan: 4 })),
      ...usedOnly.map((c) => ({ text: c.label })),
    ],
    [
      ...deducting.flatMap((c) => ["잔여", "부여", "사용", ...(c.scope ? [] : ["기간"])].map((text) => ({ text }))),
      ...usedOnly.map(() => ({ text: "사용 (차감 안 함)" })),
    ],
  ];
  const body = rows.map(({ employee, balances }) => {
    const f = (m: number) => formatLeaveMinutes(m, dayMinutesOf(employee));
    const byType = new Map(balances.map((b) => [b.leaveTypeId, b]));
    // 같은 표시 이름의 종류가 둘 이상이면 화면처럼 관리 이름으로 나눠 줄을 바꿈
    const lines = (list: BalanceRow[], value: (b: BalanceRow) => string) =>
      list.length === 1 ? value(list[0]!) : list.map((b) => `${b.name} ${value(b)}`).join("\n");
    return [
      employee.active ? employee.name : `${employee.name} (비활성)`,
      employee.department,
      ...deducting.flatMap((c) => {
        const shown = rowsOfColumn(c, byType).filter((b) => b.remainingMinutes !== null);
        const scopeCell = c.scope ? [] : [shown.length ? lines(shown, rowScope) : ""];
        if (shown.length === 0) return ["-", "", "", ...scopeCell];
        return [
          lines(shown, (b) => f(b.remainingMinutes!)),
          lines(shown, (b) => f(b.grantedMinutes)),
          lines(shown, (b) => f(b.usedMinutes)),
          ...scopeCell,
        ];
      }),
      ...usedOnly.map((c) => f(rowsOfColumn(c, byType).reduce((sum, b) => sum + b.usedMinutes, 0))),
    ];
  });
  return { head, body };
}

/** 인쇄·엑셀 부제목에 넣을 조건: "소속 아동사업부 · 구분 직원 · 직원 홍길동" */
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
  const deducting = columnsOf(report?.leaveTypes.filter((t) => t.deducts) ?? [], scopeOf);
  const usedOnly = columnsOf(report?.leaveTypes.filter((t) => !t.deducts) ?? [], scopeOf);
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
          <ReportActions
            title={reportTitle}
            subtitle={reportSubtitle}
            table={rows.length ? balancesTable(rows, deducting, usedOnly, rowScope) : null}
          />
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
                const rowsOf = (c: Column) => rowsOfColumn(c, byType);
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
