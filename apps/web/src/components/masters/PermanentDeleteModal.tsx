import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeleteCheck } from "@leave-flow/shared";
import { api, errorMessage } from "../../lib/api.ts";
import { invalidateLeaveData } from "../../lib/queries.ts";
import { Button, Callout, ErrorText, Field, Modal, Spinner, TextInput, useToast } from "../ui/index.tsx";

/**
 * 직원·휴가 종류 영구 삭제.
 * 기록이 없으면 한 번 확인, 있으면 남는 문서·지워지는 기록 수를 보여 주고 이름을 그대로 입력해야 삭제.
 */
export function PermanentDeleteModal({
  kind,
  id,
  name,
  onClose,
}: {
  kind: "employee" | "leaveType";
  id: number;
  name: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmName, setConfirmName] = useState("");
  const base = kind === "employee" ? `/api/employees/${id}` : `/api/leave-types/${id}`;
  const label = kind === "employee" ? "직원" : "휴가 종류";
  const labelObj = kind === "employee" ? "직원을" : "휴가 종류를";

  const check = useQuery({
    queryKey: ["delete-check", kind, id],
    queryFn: () => api.get<DeleteCheck>(`${base}/delete-check`),
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => api.post<void>(`${base}/delete`, { confirmName }),
    onSuccess: async () => {
      toast(`${name} ${labelObj} 영구 삭제했습니다.`);
      onClose();
      await Promise.all([qc.invalidateQueries({ queryKey: ["employees"] }), invalidateLeaveData(qc)]);
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const c = check.data;
  const hasRecords = !!c && c.leaveRequests + c.overtimeRequests + c.grants + c.openingBalances > 0;
  const kept = c
    ? [
        c.leaveRequests ? `휴가원 ${c.leaveRequests}건` : "",
        c.overtimeRequests ? `시간외근무 신청서 ${c.overtimeRequests}건` : "",
      ].filter(Boolean)
    : [];
  const balance = c
    ? [c.grants ? `부여 내역 ${c.grants}건` : "", c.openingBalances ? `기존 잔여 ${c.openingBalances}건` : ""].filter(
        Boolean,
      )
    : [];
  const canDelete = !!c && !c.blockedReason && (!hasRecords || confirmName.trim() === name);

  return (
    <Modal
      open
      title={`${label} 영구 삭제`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="danger" disabled={!canDelete || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "삭제 중…" : "영구 삭제"}
          </Button>
        </>
      }
    >
      {check.error ? (
        <ErrorText error={check.error} />
      ) : !c ? (
        <Spinner />
      ) : c.blockedReason ? (
        <Callout tone="warning">{c.blockedReason}</Callout>
      ) : !hasRecords ? (
        <p>
          <strong>{name}</strong> {labelObj} 영구 삭제할까요? 관련 기록이 없어 바로 지워집니다. 되돌릴 수 없습니다.
        </p>
      ) : (
        <div className="stack">
          <Callout tone="danger">
            <div className="stack" style={{ gap: 4 }}>
              <strong>되돌릴 수 없습니다.</strong>
              {balance.length > 0 &&
                (c.balanceKept ? (
                  <span>
                    {balance.join(", ")}은(는) 휴가원의 휴가현황이 그대로 나오도록 관리 화면에서만 숨기고 보관합니다.
                  </span>
                ) : (
                  <span>함께 지워지는 기록: {balance.join(", ")}</span>
                ))}
              {kept.length > 0 && (
                <span>
                  {kept.join(", ")}은(는) 지우지 않고 남깁니다.{" "}
                  {kind === "employee"
                    ? "작성할 때의 성명과 휴가현황으로 계속 보이고 출력할 수 있지만, 수정·취소·복구는 할 수 없습니다."
                    : "휴가원에는 종류 이름이 그대로 보이고, 잔여 계산에서는 빠집니다."}
                </span>
              )}
              <span>삭제하기 직전에 자동으로 백업을 만듭니다.</span>
            </div>
          </Callout>
          <Field label={`확인을 위해 ${label} 이름(${name})을 그대로 입력하세요.`}>
            <TextInput
              value={confirmName}
              autoFocus
              placeholder={name}
              aria-label="확인용 이름"
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
