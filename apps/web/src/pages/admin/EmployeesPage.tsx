import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Employee } from "@leave-flow/shared";
import { EmployeeFormModal } from "../../components/masters/EmployeeFormModal.tsx";
import { formatWorkDays } from "../../components/masters/labels.ts";
import { PermanentDeleteModal } from "../../components/masters/PermanentDeleteModal.tsx";
import {
  Badge,
  Button,
  Checkbox,
  ColorDot,
  EmptyState,
  ErrorText,
  PageHeader,
  Spinner,
  useConfirm,
  useToast,
} from "../../components/ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { invalidateLeaveData, useEmployees } from "../../lib/queries.ts";
import "./masters.css";

export function EmployeesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const employees = useEmployees(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [deleting, setDeleting] = useState<Employee | null>(null);

  const all = employees.data ?? [];
  const rows = showInactive ? all : all.filter((e) => e.active);
  const inactiveCount = all.length - all.filter((e) => e.active).length;

  const toggleActive = useMutation({
    mutationFn: (e: Employee) =>
      api.post<Employee>(`/api/employees/${e.id}/${e.active ? "deactivate" : "activate"}`),
    onSuccess: async (e) => {
      toast(e.active ? `${e.name} 직원을 다시 활성화했습니다.` : `${e.name} 직원을 비활성화했습니다.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ["employees"] }), invalidateLeaveData(qc)]);
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const onToggle = async (e: Employee) => {
    const ok = await confirm(
      e.active
        ? {
            title: "직원 비활성화",
            message: `${e.name} 직원을 비활성화할까요?\n휴가원 작성·시간외근무 대상 목록에서 빠지고, 지난 기록은 그대로 남습니다.`,
            confirmLabel: "비활성화",
            danger: true,
          }
        : {
            title: "직원 활성화",
            message: `${e.name} 직원을 다시 활성화할까요?\n휴가원 작성 목록에 다시 나옵니다.`,
            confirmLabel: "활성화",
          },
    );
    if (ok) toggleActive.mutate(e);
  };

  return (
    <div>
      <PageHeader
        title="직원"
        description="퇴사한 직원은 비활성화해 지난 기록을 남깁니다. 잘못 만들었거나 정리할 직원은 비활성화한 뒤 영구 삭제할 수 있습니다."
        actions={
          <>
            <Checkbox
              label={`비활성 포함${inactiveCount ? ` (${inactiveCount})` : ""}`}
              checked={showInactive}
              onChange={setShowInactive}
            />
            <Button variant="primary" onClick={() => setEditing("new")}>
              직원 추가
            </Button>
          </>
        }
      />

      {employees.isPending ? (
        <Spinner />
      ) : employees.error ? (
        <ErrorText error={employees.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={all.length === 0 ? "등록된 직원이 없습니다." : "활성 직원이 없습니다."}>
          <p className="empty-guide">직원을 추가하면 휴가원 작성과 달력에서 고를 수 있습니다.</p>
          <Button variant="primary" onClick={() => setEditing("new")}>
            직원 추가
          </Button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>성명</th>
                <th>소속</th>
                <th>근무 요일</th>
                <th>근무시간</th>
                <th>비상연락처</th>
                <th>구분</th>
                <th>상태</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.active ? undefined : "inactive"}>
                  <td>
                    <span className="cell-name">
                      <ColorDot color={e.color} />
                      {e.name}
                    </span>
                  </td>
                  <td>{e.department || <span className="faint">-</span>}</td>
                  <td className="nowrap">{formatWorkDays(e.workDays)}</td>
                  <td className="nowrap">
                    {e.workStart}~{e.workEnd}
                  </td>
                  <td className="nowrap">{e.emergencyContact || <span className="faint">-</span>}</td>
                  <td>
                    {e.category ? (
                      <Badge tone={e.isSocialServiceAgent ? "accent" : undefined}>{e.category}</Badge>
                    ) : (
                      <span className="faint">-</span>
                    )}
                  </td>
                  <td>{e.active ? <Badge tone="success">활성</Badge> : <Badge>비활성</Badge>}</td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>
                        수정
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={toggleActive.isPending}
                        onClick={() => void onToggle(e)}
                      >
                        {e.active ? "비활성화" : "활성화"}
                      </Button>
                      {!e.active && (
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(e)}>
                          삭제
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleting && (
        <PermanentDeleteModal
          kind="employee"
          id={deleting.id}
          name={deleting.name}
          onClose={() => setDeleting(null)}
        />
      )}

      {editing && (
        <EmployeeFormModal
          employee={editing === "new" ? null : editing}
          usedColors={all.filter((e) => e.active && (editing === "new" || e.id !== editing.id)).map((e) => e.color)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
