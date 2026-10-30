import { useQueryClient } from "@tanstack/react-query";
import { dayMinutesOf, formatLeaveMinutes, needsReprint, type LeaveRequest, type LeaveSaveResult } from "@leave-flow/shared";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, ColorDot, ErrorText, Modal, Spinner, useConfirm, useToast } from "../ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { formatDateKo, formatRangeKo, formatTimestamp } from "../../lib/format.ts";
import { invalidateLeaveData, qk } from "../../lib/queries.ts";
import { requestPeriods, useLeaveRequest } from "./leaveQueries.ts";
import "./leave.css";

function periodsText(r: LeaveRequest): string {
  return requestPeriods(r).map((p) => `${p.typeName} ${formatRangeKo(p.startAt, p.endAt)}`).join("\n");
}

/** 휴가원 상세: 수정 / 취소 / 복구 / 출력 / 영구 삭제(취소된 휴가원) */
export function LeaveDetailModal({
  requestId,
  onClose,
  onEdit,
}: {
  requestId: number;
  onClose: () => void;
  onEdit: (request: LeaveRequest) => void;
}) {
  const { data: r, isPending, error } = useLeaveRequest(requestId);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();

  const run = async (path: "cancel" | "restore", done: string) => {
    setBusy(true);
    try {
      const res = await api.post<LeaveSaveResult>(`/api/leave-requests/${requestId}/${path}`);
      qc.setQueryData(qk.leaveRequest(requestId), res.request);
      void invalidateLeaveData(qc);
      toast(done);
      if (res.warnings.length) toast(res.warnings.map((w) => w.message).join("\n"), "warning");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (req: LeaveRequest) => {
    const ok = await confirm({
      title: "휴가원을 취소할까요?",
      message: `${req.employeeName}\n${periodsText(req)}\n\n기록은 남고 잔여량은 되돌아갑니다. 나중에 복구할 수 있습니다.`,
      confirmLabel: "휴가원 취소",
      cancelLabel: "닫기",
      danger: true,
    });
    if (ok) await run("cancel", "휴가원을 취소했습니다.");
  };

  const restore = async (req: LeaveRequest) => {
    const ok = await confirm({
      title: "휴가원을 복구할까요?",
      message: `${req.employeeName}\n${periodsText(req)}\n\n다시 신청 상태가 되고 사용 시간을 지금 공휴일·휴무일 기준으로 다시 계산합니다.`,
      confirmLabel: "복구",
      cancelLabel: "닫기",
    });
    if (ok) await run("restore", "휴가원을 복구했습니다.");
  };

  const purge = async (req: LeaveRequest) => {
    const ok = await confirm({
      title: "휴가원을 영구 삭제할까요?",
      message: `${req.employeeName}
${periodsText(req)}

되돌릴 수 없습니다. 출력 기록도 함께 지워지고, 지우기 직전에 자동으로 백업을 만듭니다.`,
      confirmLabel: "영구 삭제",
      cancelLabel: "닫기",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post<void>(`/api/leave-requests/${requestId}/delete`);
      toast("휴가원을 영구 삭제했습니다.");
      onClose();
      qc.removeQueries({ queryKey: qk.leaveRequest(requestId) });
      void invalidateLeaveData(qc);
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  const purgeButton = (req: LeaveRequest) => (
    <Button variant="ghost" className="lf-danger-text" onClick={() => purge(req)} disabled={busy}>
      영구 삭제
    </Button>
  );

  // 영구 삭제된 직원의 휴가원은 보기·출력·영구 삭제만, 삭제된 종류가 든 휴가원은 수정만 막음 (서버와 같은 규칙)
  const footer = r ? (
    r.employeeDeleted ? (
      <>
        {purgeButton(r)}
        <span className="spacer" />
        {r.status === "active" && (
          <Button variant="primary" onClick={() => navigate(`/print/leave/${r.id}`)}>
            출력
          </Button>
        )}
      </>
    ) : r.status === "active" ? (
      <>
        <Button variant="ghost" className="lf-danger-text" onClick={() => cancel(r)} disabled={busy}>
          휴가원 취소
        </Button>
        <span className="spacer" />
        {!r.items.some((i) => i.leaveTypeDeleted) && (
          <Button onClick={() => onEdit(r)} disabled={busy}>
            수정
          </Button>
        )}
        <Button variant="primary" onClick={() => navigate(`/print/leave/${r.id}`)} disabled={busy}>
          출력
        </Button>
      </>
    ) : (
      <>
        {purgeButton(r)}
        <span className="spacer" />
        <Button variant="primary" onClick={() => restore(r)} disabled={busy}>
          복구
        </Button>
      </>
    )
  ) : undefined;

  return (
    <Modal open title="휴가원" onClose={onClose} closeOnOverlay footer={footer}>
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorText error={error} />
      ) : (
        <div className="lf-detail">
          <div className="lf-detail-who">
            <ColorDot color={r.color} />
            <strong>{r.employeeName}</strong>
            {r.department && <span className="muted">{r.department}</span>}
            {r.employeeDeleted && <Badge>삭제된 직원</Badge>}
            <span className="spacer" />
            {r.status === "active" ? <Badge tone="accent">신청</Badge> : <Badge tone="danger">취소됨</Badge>}
          </div>

          <ul className={["lf-detail-items", r.status === "cancelled" && "is-cancelled"].filter(Boolean).join(" ")}>
            {requestPeriods(r).map((p) => (
              <li key={p.key}>
                <span className="lf-detail-type">
                  {p.typeName}
                  {p.items.some((i) => i.leaveTypeDeleted) && <span className="muted"> (삭제된 종류)</span>}
                </span>
                <span className="lf-detail-range">{formatRangeKo(p.startAt, p.endAt)}</span>
                <span className="lf-detail-min">{formatLeaveMinutes(p.minutes, dayMinutesOf(r))}</span>
              </li>
            ))}
          </ul>

          <dl className="lf-dl">
            <dt>휴가사유</dt>
            <dd>{r.reason || <span className="faint">-</span>}</dd>
            <dt>비상연락</dt>
            <dd>{r.emergencyContact || <span className="faint">-</span>}</dd>
            <dt>업무인계</dt>
            <dd className="lf-pre">{r.handoverNote || <span className="faint">-</span>}</dd>
            <dt>신청일</dt>
            <dd>{formatDateKo(r.appliedOn, true)}</dd>
            <dt>최근 출력</dt>
            <dd>
              {r.lastPrintedAt ? formatTimestamp(r.lastPrintedAt) : <span className="faint">출력 기록 없음</span>}
              {needsReprint(r) && (
                <>
                  {" "}
                  <Badge tone="warning" title="출력한 뒤에 수정·복구되어 출력한 종이와 내용이 다를 수 있습니다. 다시 출력해 결재를 받으세요.">
                    출력 후 수정됨 · 다시 출력 필요
                  </Badge>
                </>
              )}
            </dd>
            {r.cancelledAt && (
              <>
                <dt>취소일시</dt>
                <dd>{formatTimestamp(r.cancelledAt)}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </Modal>
  );
}
