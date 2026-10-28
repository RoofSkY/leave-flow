import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dayMinutesOf, formatLeaveMinutes, type OpeningBalance } from "@leave-flow/shared";
import { Link } from "react-router";
import { YearSelect } from "../../components/masters/inputs.tsx";
import { OpeningBalanceFormModal } from "../../components/masters/OpeningBalanceFormModal.tsx";
import {
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

export function OpeningBalancesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const employees = useEmployees(true);
  const leaveTypes = useLeaveTypes(true);
  const [year, setYear] = useState(currentYear());
  const [editing, setEditing] = useState<OpeningBalance | "new" | null>(null);

  const openings = useQuery({
    queryKey: qk.openingBalances({ year }),
    queryFn: () => api.get<OpeningBalance[]>(`/api/opening-balances${qs({ year })}`),
  });

  const allEmployees = employees.data ?? [];
  const allTypes = leaveTypes.data ?? [];
  const employeeById = new Map(allEmployees.map((e) => [e.id, e]));
  const typeById = new Map(allTypes.map((t) => [t.id, t]));
  const canAdd = allEmployees.some((e) => e.active) && allTypes.some((t) => t.active);

  const remove = useMutation({
    mutationFn: (o: OpeningBalance) => api.del<void>(`/api/opening-balances/${o.id}`),
    onSuccess: async () => {
      toast("기존 잔여량 기록을 삭제했습니다.");
      await invalidateLeaveData(qc);
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const onDelete = async (o: OpeningBalance) => {
    const emp = employeeById.get(o.employeeId);
    const type = typeById.get(o.leaveTypeId);
    const ok = await confirm({
      title: "기존 잔여량 삭제",
      message: `${emp?.name ?? ""} ${type?.name ?? ""} ${o.year}년 기존 잔여량 기록을 삭제할까요?\n이 기록의 총 부여량과 기존 사용량이 잔여 계산에서 빠집니다.`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (ok) remove.mutate(o);
  };

  const loading = openings.isPending || employees.isPending || leaveTypes.isPending;
  const error = openings.error ?? employees.error ?? leaveTypes.error;
  const rows = openings.data ?? [];

  return (
    <div>
      <PageHeader
        title="기존 잔여량"
        actions={
          <Button variant="primary" disabled={!canAdd} onClick={() => setEditing("new")}>
            기존 잔여량 입력
          </Button>
        }
      />

      <div className="masters-section">
        <Callout tone="info">
          <span>
            프로그램을 처음 쓸 때 한 번만 입력합니다. 직원·휴가 종류별로 <b>올해 총 부여량</b>과 <b>현재 잔여량</b>을
            넣으면 <b>기존 사용량</b>(= 총 부여량 − 현재 잔여량)이 자동으로 계산되어 기준일자와 함께 저장됩니다.
            휴가원 양식의 누적사용에는 기존 사용량과 <b>기준일자 이후</b> 휴가원 사용량이 합쳐집니다. 기준일자까지(당일 포함)의
            부여(시간외근무 적립 포함)와 휴가원 사용은 입력한 값에 이미 들어 있는 것으로 보고 다시 더하지 않습니다.
            <br />
            여기 입력한 총 부여량은 그 해 부여량에 이미 들어가므로, 같은 부여를 부여 내역에 다시 넣지 마세요.
          </span>
        </Callout>
      </div>

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
          <YearSelect value={year} onChange={(y) => y !== null && setYear(y)} />
        </Field>
      </div>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorText error={error} />
      ) : rows.length === 0 ? (
        <EmptyState title={`${year}년에 입력한 기존 잔여량이 없습니다.`} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>직원</th>
                <th>종류</th>
                <th>기준일자</th>
                <th className="num">총 부여량</th>
                <th className="num">현재 잔여량</th>
                <th className="num">기존 사용량</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const emp = employeeById.get(o.employeeId);
                const type = typeById.get(o.leaveTypeId);
                const f = (m: number) => formatLeaveMinutes(m, dayMinutesOf(emp));
                return (
                  <tr key={o.id} className={emp && !emp.active ? "inactive" : undefined}>
                    <td>
                      <span className="cell-name">
                        {emp && <ColorDot color={emp.color} />}
                        {emp?.name ?? "-"}
                      </span>
                    </td>
                    <td className="nowrap">{type?.name ?? "-"}</td>
                    <td className="nowrap">{formatDateKo(o.baseDate)}</td>
                    <td className="num nowrap">{f(o.totalGrantedMinutes)}</td>
                    <td className="num nowrap">{f(o.remainingMinutes)}</td>
                    <td className="num nowrap">
                      <b>{f(o.usedMinutes)}</b>
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(o)}>
                          수정
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={remove.isPending}
                          onClick={() => void onDelete(o)}
                        >
                          삭제
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <OpeningBalanceFormModal
          opening={editing === "new" ? null : editing}
          defaultYear={year}
          employees={allEmployees}
          leaveTypes={allTypes}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
