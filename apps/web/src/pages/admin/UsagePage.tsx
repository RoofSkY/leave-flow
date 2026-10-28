import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  dayMinutesOf,
  formatDotDate,
  formatLeaveMinutes,
  localToday,
  type BalanceRow,
  type LeaveType,
  type UsageReport,
} from "@leave-flow/shared";
import { balanceScopeText } from "../../components/masters/labels.ts";
import { ReportActions, ReportPrintHeader, type ReportTable } from "../../components/admin-reports/ReportExport.tsx";
import { YearSelect } from "../../components/admin-reports/YearSelect.tsx";
import "../../components/admin-reports/admin-reports.css";
import { Badge, ColorDot, EmptyState, ErrorText, PageHeader, Spinner } from "../../components/ui/index.tsx";
import { api, qs } from "../../lib/api.ts";
import { currentYear } from "../../lib/format.ts";
import { qk } from "../../lib/queries.ts";

/** 1일 = 그 직원의 하루 근무시간 */
function Amount({ minutes, dayMinutes, negative }: { minutes: number; dayMinutes: number; negative?: boolean }) {
  const cls = negative && minutes < 0 ? "usage-negative" : minutes === 0 ? "faint" : undefined;
  return <span className={cls}>{formatLeaveMinutes(minutes, dayMinutes)}</span>;
}

function typeMeta(t: LeaveType, year: number): string {
  return t.deducts ? balanceScopeText(t, year, localToday()) : "차감 안 함";
}

/** 한 칸 묶음의 부여·사용·잔여(분). 기록이 없으면 0 */
function amountsOf(b: BalanceRow | undefined) {
  const granted = b?.grantedMinutes ?? 0;
  const used = b?.usedMinutes ?? 0;
  return { granted, used, remaining: b?.remainingMinutes ?? granted - used };
}

/** 엑셀로 받을 표: 화면과 같은 열 (차감 종류는 부여·사용·잔여, 차감 안 하는 종류는 사용) */
function usageTable(report: UsageReport): ReportTable {
  const head: ReportTable["head"] = [
    [
      { text: "직원", rowSpan: 2 },
      { text: "소속", rowSpan: 2 },
      ...report.leaveTypes.map((t) => ({ text: `${t.name}\n${typeMeta(t, report.year)}`, colSpan: t.deducts ? 3 : 1 })),
    ],
    report.leaveTypes.flatMap((t) => (t.deducts ? ["부여", "사용", "잔여"] : ["사용"]).map((text) => ({ text }))),
  ];
  const body = report.rows.map(({ employee, balances }) => {
    const f = (m: number) => formatLeaveMinutes(m, dayMinutesOf(employee));
    const byType = new Map(balances.map((b) => [b.leaveTypeId, b]));
    return [
      employee.active ? employee.name : `${employee.name} (비활성)`,
      employee.department,
      ...report.leaveTypes.flatMap((t) => {
        const a = amountsOf(byType.get(t.id));
        return t.deducts ? [f(a.granted), f(a.used), f(a.remaining)] : [f(a.used)];
      }),
    ];
  });
  return { head, body };
}

export function UsagePage() {
  const [year, setYear] = useState(currentYear);
  const usage = useQuery({
    queryKey: qk.usage(year),
    queryFn: () => api.get<UsageReport>(`/api/usage${qs({ year })}`),
  });
  const report = usage.data;
  const reportTitle = `${year}년 사용 현황`;
  const reportSubtitle = `출력 ${formatDotDate(localToday())} · 1일 = 직원별 하루 근무시간`;

  return (
    <div className="stack">
      <PageHeader
        title="사용 현황"
        description="직원별·휴가 종류별 부여·사용·잔여입니다. 연도별 종류는 그 해, 누적 종류는 그 해까지의 합계입니다."
        actions={
          <ReportActions
            title={reportTitle}
            subtitle={reportSubtitle}
            table={report && report.leaveTypes.length && report.rows.length ? usageTable(report) : null}
          />
        }
      />
      <ReportPrintHeader title={reportTitle} subtitle={reportSubtitle} />
      <div className="report-toolbar no-print">
        <YearSelect value={year} onChange={setYear} />
      </div>

      {usage.isPending ? (
        <Spinner />
      ) : usage.error ? (
        <ErrorText error={usage.error} />
      ) : !report || report.leaveTypes.length === 0 ? (
        <EmptyState title="등록된 휴가 종류가 없습니다.">
          <Link to="/admin/leave-types">휴가 종류 등록하기</Link>
        </EmptyState>
      ) : report.rows.length === 0 ? (
        <EmptyState title="직원이 없습니다.">
          <Link to="/admin/employees">직원 등록하기</Link>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table usage-table">
            <thead>
              <tr>
                <th rowSpan={2} className="usage-sticky">
                  직원
                </th>
                {report.leaveTypes.map((t) => (
                  <th key={t.id} colSpan={t.deducts ? 3 : 1} className="usage-group">
                    <div>{t.name}</div>
                    <div className="usage-type-meta">{typeMeta(t, report.year)}</div>
                  </th>
                ))}
              </tr>
              <tr>
                {report.leaveTypes.map((t) =>
                  t.deducts ? (
                    [
                      <th key={`${t.id}-g`} className="num usage-group-start">
                        부여
                      </th>,
                      <th key={`${t.id}-u`} className="num">
                        사용
                      </th>,
                      <th key={`${t.id}-r`} className="num">
                        잔여
                      </th>,
                    ]
                  ) : (
                    <th key={`${t.id}-u`} className="num usage-group-start">
                      사용
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {report.rows.map(({ employee, balances }) => {
                const byType = new Map<number, BalanceRow>(balances.map((b) => [b.leaveTypeId, b]));
                return (
                  <tr key={employee.id} className={employee.active ? undefined : "inactive"}>
                    <td className="usage-sticky">
                      <div className="usage-employee">
                        <ColorDot color={employee.color} />
                        <span className="nowrap">{employee.name}</span>
                        {!employee.active && <Badge>비활성</Badge>}
                      </div>
                      {employee.department && <div className="usage-department">{employee.department}</div>}
                    </td>
                    {report.leaveTypes.map((t) => {
                      const { granted, used, remaining } = amountsOf(byType.get(t.id));
                      if (!t.deducts) {
                        return (
                          <td key={t.id} className="num nowrap usage-group-start">
                            <Amount minutes={used} dayMinutes={dayMinutesOf(employee)} />
                          </td>
                        );
                      }
                      return [
                        <td key={`${t.id}-g`} className="num nowrap usage-group-start">
                          <Amount minutes={granted} dayMinutes={dayMinutesOf(employee)} />
                        </td>,
                        <td key={`${t.id}-u`} className="num nowrap">
                          <Amount minutes={used} dayMinutes={dayMinutesOf(employee)} />
                        </td>,
                        <td key={`${t.id}-r`} className="num nowrap usage-remaining">
                          <Amount minutes={remaining} dayMinutes={dayMinutesOf(employee)} negative />
                        </td>,
                      ];
                    })}
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
