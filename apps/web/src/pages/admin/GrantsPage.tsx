import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dayMinutesOf, formatLeaveMinutes, type Grant } from "@leave-flow/shared";
import { Link } from "react-router";
import { EmployeeSelect, LeaveTypeSelect } from "../../components/form/index.tsx";
import { BalanceSummary } from "../../components/masters/BalanceSummary.tsx";
import { GrantFormModal } from "../../components/masters/GrantFormModal.tsx";
import { YearSelect } from "../../components/masters/inputs.tsx";
import {
  Badge,
  Button,
  Callout,
  ColorDot,
  EmptyState,
  ErrorText,
  Field,
  PageHeader,
  Spinner,
  useConfirm,
  useToast,
} from "../../components/ui/index.tsx";
import { api, errorMessage, qs } from "../../lib/api.ts";
import { currentYear, formatDateKo } from "../../lib/format.ts";
import { invalidateLeaveData, qk, useEmployees, useLeaveTypes } from "../../lib/queries.ts";
import "./masters.css";

export function GrantsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const employees = useEmployees(true);
  const leaveTypes = useLeaveTypes(true);
  const [year, setYear] = useState<number | null>(currentYear());
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [leaveTypeId, setLeaveTypeId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Grant | "new" | null>(null);

  const filters = { year, employeeId, leaveTypeId };
  const grants = useQuery({
    queryKey: qk.grants(filters),
    queryFn: () => api.get<Grant[]>(`/api/grants${qs(filters)}`),
  });

  const allEmployees = employees.data ?? [];
  const allTypes = leaveTypes.data ?? [];
  const employeeById = new Map(allEmployees.map((e) => [e.id, e]));
  const typeById = new Map(allTypes.map((t) => [t.id, t]));
  const canAdd = allEmployees.some((e) => e.active) && allTypes.some((t) => t.active);
  const selectedEmployee = employeeId !== null ? employeeById.get(employeeId) : undefined;
  const summaryYear = year ?? currentYear();

  const remove = useMutation({
    mutationFn: (g: Grant) => api.del<void>(`/api/grants/${g.id}`),
    onSuccess: async () => {
      toast("부여 내역을 삭제했습니다.");
      await invalidateLeaveData(qc);
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const onDelete = async (g: Grant) => {
    const emp = employeeById.get(g.employeeId);
    const type = typeById.get(g.leaveTypeId);
    const ok = await confirm({
      title: "부여 내역 삭제",
      message: `${emp?.name ?? ""} ${type?.name ?? ""} ${formatLeaveMinutes(g.minutes, dayMinutesOf(emp))} (${formatDateKo(g.grantDate, true)}) 부여를 삭제할까요?\n잔여량이 바로 줄어듭니다.`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (ok) remove.mutate(g);
  };

  const loading = grants.isPending || employees.isPending || leaveTypes.isPending;
  const error = grants.error ?? employees.error ?? leaveTypes.error;
  const rows = grants.data ?? [];

  return (
    <div>
      <PageHeader
        title="부여 내역"
        description="직원별 휴가 부여를 날짜·양·비고로 기록합니다. 새해 부여량도 여기서 입력합니다. 여러 직원을 골라 한 번에 부여할 수 있습니다."
        actions={
          <Button variant="primary" disabled={!canAdd} onClick={() => setEditing("new")}>
            부여 추가
          </Button>
        }
      />

      {!leaveTypes.isPending && allTypes.length === 0 && (
        <div className="masters-section">
          <Callout tone="warning">
            <span>
              등록된 휴가 종류가 없습니다. <Link to="/admin/leave-types">휴가 종류</Link>를 먼저 등록하세요.
            </span>
          </Callout>
        </div>
      )}

      <div className="masters-toolbar">
        <Field label="연도">
          <YearSelect value={year} onChange={setYear} allLabel="전체 연도" />
        </Field>
        <Field label="직원">
          <EmployeeSelect
            employees={allEmployees}
            value={employeeId}
            onChange={setEmployeeId}
            placeholder="전체 직원"
          />
        </Field>
        <Field label="휴가 종류">
          <LeaveTypeSelect
            leaveTypes={allTypes}
            value={leaveTypeId}
            onChange={setLeaveTypeId}
            placeholder="전체 종류"
          />
        </Field>
      </div>

      {selectedEmployee && (
        <section className="masters-section">
          <div className="section-title">
            {selectedEmployee.name} · {summaryYear}년 잔여
            <span className="field-hint" style={{ marginLeft: 8, fontWeight: 400 }}>
              누적 종류는 {summaryYear}년까지의 합계
            </span>
          </div>
          <BalanceSummary employeeId={selectedEmployee.id} year={summaryYear} dayMinutes={dayMinutesOf(selectedEmployee)} />
        </section>
      )}

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorText error={error} />
      ) : rows.length === 0 ? (
        <EmptyState title="부여 내역이 없습니다.">
          {canAdd && <p className="empty-guide">부여 추가 버튼으로 직원별 부여량을 입력하세요.</p>}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>부여일</th>
                <th>직원</th>
                <th>종류</th>
                <th className="num">양</th>
                <th>비고</th>
                <th>출처</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const emp = employeeById.get(g.employeeId);
                const type = typeById.get(g.leaveTypeId);
                return (
                  <tr key={g.id}>
                    <td className="nowrap">{formatDateKo(g.grantDate, year === null)}</td>
                    <td>
                      <span className="cell-name">
                        {emp && <ColorDot color={emp.color} />}
                        {emp?.name ?? "-"}
                      </span>
                    </td>
                    <td className="nowrap">{type?.name ?? "-"}</td>
                    <td className="num nowrap">{formatLeaveMinutes(g.minutes, dayMinutesOf(emp))}</td>
                    <td>
                      <div className="cell-note" title={g.note || undefined}>
                        {g.note || <span className="faint">-</span>}
                      </div>
                    </td>
                    <td>{g.source === "overtime" ? <Badge tone="accent">시간외근무</Badge> : <Badge>직접 입력</Badge>}</td>
                    <td>
                      {g.source === "overtime" ? (
                        <Link to="/overtime" className="row-hint" title="시간외근무 신청서에서 수정·취소합니다.">
                          시간외근무 화면에서 수정
                        </Link>
                      ) : (
                        <div className="row-actions">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(g)}>
                            수정
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={remove.isPending}
                            onClick={() => void onDelete(g)}
                          >
                            삭제
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <GrantFormModal
          grant={editing === "new" ? null : editing}
          employees={allEmployees}
          leaveTypes={allTypes}
          defaults={{ employeeId, leaveTypeId }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
