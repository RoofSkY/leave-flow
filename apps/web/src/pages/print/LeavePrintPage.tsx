import { useQueryClient } from "@tanstack/react-query";
import { needsReprint, type LeavePrintData } from "@leave-flow/shared";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { LeavePrintSheet } from "../../components/leave/LeavePrintSheet.tsx";
import { leavePrintKey, useLeavePrintData } from "../../components/leave/leaveQueries.ts";
import { PrintShell } from "../../components/print/PrintShell.tsx";
import { ErrorText, Spinner, useConfirm } from "../../components/ui/index.tsx";
import { api } from "../../lib/api.ts";
import { formatTimestamp } from "../../lib/format.ts";
import { invalidateLeaveData } from "../../lib/queries.ts";

const OVERFLOW_MESSAGE = "내용이 A4 한 장을 넘어 다음 장으로 이어서 출력됩니다. 업무인계 내용을 줄여 주세요.";

/** 휴가원 출력 (/print/leave/:id) */
export function LeavePrintPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isPending, error } = useLeavePrintData(id);
  // 글자·간격을 줄여도 A4 한 장을 넘는지 (LeavePrintSheet 가 알려 줌)
  const [overflow, setOverflow] = useState(false);

  // PDF로 저장할 때 파일 이름
  useEffect(() => {
    if (!data) return;
    const prev = document.title;
    document.title = `휴가원_${data.request.employeeName}_${data.request.items[0]?.startAt.slice(0, 10) ?? ""}`;
    return () => {
      document.title = prev;
    };
  }, [data]);

  // 인쇄 직전: 출력 기록 (취소된 휴가원 등은 서버가 거절 → 인쇄하지 않음)
  const recordPrint = async () => {
    if (!data) throw new Error("출력할 휴가원을 불러오지 못했습니다.");
    if (overflow) {
      const ok = await confirm({
        title: "A4 한 장을 넘습니다",
        message: `휴가원 내용이 A4 한 장에 다 들어가지 않아 다음 장으로 이어서 출력됩니다.\n업무인계 내용을 줄이면 한 장에 출력할 수 있습니다.\n\n그대로 인쇄할까요?`,
        confirmLabel: "그대로 인쇄",
        cancelLabel: "닫기",
      });
      if (!ok) return false;
    }
    const printed = await api.post<LeavePrintData>(`/api/leave-requests/${id}/print`);
    qc.setQueryData(leavePrintKey(id), printed);
    void invalidateLeaveData(qc);
  };

  return (
    <PrintShell
      title="휴가원 출력"
      onBeforePrint={recordPrint}
      toolbarExtra={
        data && (
          <>
            {overflow && (
              <span className="lf-print-warn" role="alert">
                {OVERFLOW_MESSAGE}
              </span>
            )}
            {needsReprint(data.request) && (
              <span className="lf-print-warn">출력한 뒤에 수정되었습니다. 다시 출력해 결재를 받으세요.</span>
            )}
            <span className="muted" style={{ fontSize: 13 }}>
              최근 출력 {data.request.lastPrintedAt ? formatTimestamp(data.request.lastPrintedAt) : "없음"}
            </span>
          </>
        )
      }
    >
      {!Number.isInteger(id) || id <= 0 ? (
        <div className="lf-print-msg">
          <ErrorText error="잘못된 주소입니다." />
        </div>
      ) : isPending ? (
        <div className="lf-print-msg">
          <Spinner />
        </div>
      ) : error ? (
        <div className="lf-print-msg">
          <ErrorText error={error} />
        </div>
      ) : (
        <LeavePrintSheet data={data} onOverflow={setOverflow} />
      )}
    </PrintShell>
  );
}
