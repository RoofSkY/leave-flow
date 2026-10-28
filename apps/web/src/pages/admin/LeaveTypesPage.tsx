import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LeaveType } from "@leave-flow/shared";
import { BALANCE_MODE_LABELS, balanceRuleText, targetRuleText } from "../../components/masters/labels.ts";
import { LeaveTypeFormModal } from "../../components/masters/LeaveTypeFormModal.tsx";
import { PermanentDeleteModal } from "../../components/masters/PermanentDeleteModal.tsx";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorText,
  PageHeader,
  Spinner,
  useConfirm,
  useToast,
} from "../../components/ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { invalidateLeaveData, useEmployees, useLeaveTypes } from "../../lib/queries.ts";
import "./masters.css";

/** 예시일 뿐 미리 만들지 않음 (처음 설치 시 휴가 종류는 0개) */
const EXAMPLES = ["연차", "병가", "공가", "특별휴가", "대체휴가"];

export function LeaveTypesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const leaveTypes = useLeaveTypes(true);
  const employees = useEmployees(true);

  /** "전체 직원", "아동사업부의 직원", "사회복무요원 + 홍길동", "아동사업부·가족사업부 + 홍길동 외 3명" */
  const targetText = (t: LeaveType) => {
    if (t.target === null) return <span className="muted">전체 직원</span>;
    const nameOf = (id: number) => employees.data?.find((e) => e.id === id)?.name ?? "";
    return targetRuleText(t.target, nameOf) || <span className="muted">대상 없음</span>;
  };
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<LeaveType | "new" | null>(null);
  const [deleting, setDeleting] = useState<LeaveType | null>(null);

  const all = leaveTypes.data ?? [];
  const rows = showInactive ? all : all.filter((t) => t.active);
  const inactiveCount = all.filter((t) => !t.active).length;
  const nextSortOrder = all.length ? Math.max(...all.map((t) => t.sortOrder)) + 1 : 1;

  const toggleActive = useMutation({
    mutationFn: (t: LeaveType) =>
      api.post<LeaveType>(`/api/leave-types/${t.id}/${t.active ? "deactivate" : "activate"}`),
    onSuccess: async (t) => {
      toast(t.active ? `${t.name} 종류를 다시 활성화했습니다.` : `${t.name} 종류를 비활성화했습니다.`);
      await invalidateLeaveData(qc);
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const onToggle = async (t: LeaveType) => {
    const ok = await confirm(
      t.active
        ? {
            title: "휴가 종류 비활성화",
            message: `${t.name} 종류를 비활성화할까요?\n새 휴가원·부여에서 고를 수 없게 되고, 지난 기록은 그대로 남습니다.`,
            confirmLabel: "비활성화",
            danger: true,
          }
        : {
            title: "휴가 종류 활성화",
            message: `${t.name} 종류를 다시 활성화할까요?`,
            confirmLabel: "활성화",
          },
    );
    if (ok) toggleActive.mutate(t);
  };

  return (
    <div>
      <PageHeader
        title="휴가 종류"
        description="휴가원에서 고를 휴가 종류입니다. 표시 순서대로 휴가원 양식의 체크박스와 휴가현황 표가 만들어집니다."
        actions={
          all.length > 0 && (
            <>
              <Checkbox
                label={`비활성 포함${inactiveCount ? ` (${inactiveCount})` : ""}`}
                checked={showInactive}
                onChange={setShowInactive}
              />
              <Button variant="primary" onClick={() => setEditing("new")}>
                종류 추가
              </Button>
            </>
          )
        }
      />

      {leaveTypes.isPending ? (
        <Spinner />
      ) : leaveTypes.error ? (
        <ErrorText error={leaveTypes.error} />
      ) : all.length === 0 ? (
        <EmptyState title="등록된 휴가 종류가 없습니다.">
          <p className="empty-guide">
            처음 설치하면 휴가 종류는 하나도 없습니다. 사무실에서 쓰는 휴가 종류를 모두 직접 등록하세요. 예를 들면
            다음과 같습니다.
          </p>
          <div className="empty-examples">
            {EXAMPLES.map((n) => (
              <Badge key={n}>{n}</Badge>
            ))}
          </div>
          <Button variant="primary" onClick={() => setEditing("new")}>
            첫 휴가 종류 추가
          </Button>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="활성 휴가 종류가 없습니다.">
          <p className="empty-guide">비활성 포함을 켜서 다시 활성화하거나 새 종류를 추가하세요.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>이름</th>
                <th>잔여 차감</th>
                <th>잔여 방식</th>
                <th>적용 대상</th>
                <th className="num">순서</th>
                <th>상태</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={t.active ? undefined : "inactive"}>
                  <td>
                    <span className="cell-name">{t.name}</span>
                    {t.displayName && t.displayName !== t.name && (
                      <span className="cell-sub">표시 이름: {t.displayName}</span>
                    )}
                  </td>
                  <td className="nowrap">{t.deducts ? "차감" : <span className="muted">안 함</span>}</td>
                  <td className="nowrap">
                    {BALANCE_MODE_LABELS[t.balanceMode].name}
                    <span className="cell-sub">{balanceRuleText(t)}</span>
                  </td>
                  <td>{targetText(t)}</td>
                  <td className="num">{t.sortOrder}</td>
                  <td>{t.active ? <Badge tone="success">활성</Badge> : <Badge>비활성</Badge>}</td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                        수정
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={toggleActive.isPending}
                        onClick={() => void onToggle(t)}
                      >
                        {t.active ? "비활성화" : "활성화"}
                      </Button>
                      {!t.active && (
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(t)}>
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
          kind="leaveType"
          id={deleting.id}
          name={deleting.name}
          onClose={() => setDeleting(null)}
        />
      )}

      {editing && (
        <LeaveTypeFormModal
          leaveType={editing === "new" ? null : editing}
          nextSortOrder={nextSortOrder}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
