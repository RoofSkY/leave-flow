import type { OvertimePrintData } from "@leave-flow/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useParams } from "react-router";
import { overtimeApi, useAccrualTypes } from "../../components/overtime/api.ts";
import { KIND_LABEL, dotDate, withJosa } from "../../components/overtime/labels.ts";
import { GeneralOvertimeSheet, SoldierOvertimeSheet } from "../../components/overtime/OvertimeSheets.tsx";
import { PrintShell } from "../../components/print/PrintShell.tsx";
import { ErrorText, Spinner } from "../../components/ui/index.tsx";
import { formatTimestamp } from "../../lib/format.ts";
import { invalidateLeaveData, qk } from "../../lib/queries.ts";

/** 시간외근무 신청서 출력. 일반 신청서는 처음 인쇄할 때 오늘 날짜로 제출되고 적립됨 */
export function OvertimePrintPage() {
  const id = Number(useParams().id);
  const validId = Number.isInteger(id) && id > 0;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: [...qk.overtime(id), "print-data"],
    queryFn: () => overtimeApi.printData(id),
    enabled: validId,
  });
  const accrual = useAccrualTypes();
  // 인쇄 직전 서버가 돌려준 값 (제출일·출력일시가 정해진 상태)으로 다시 그림
  const [printed, setPrinted] = useState<OvertimePrintData | null>(null);
  const data = printed ?? query.data;

  // PDF 로 저장할 때 파일 이름
  useEffect(() => {
    if (!data) return;
    const prev = document.title;
    const paidOn = dotDate(data.request.paidOn ?? data.submitDate);
    document.title =
      data.request.kind === "general"
        ? `시간외근무신청서 ${dotDate(data.submitDate)}`
        : data.request.kind === "award"
          ? `시간외근무신청서(특별휴가 시상) ${paidOn}`
          : `시간외근무신청서(특별휴가) ${paidOn}`;
    return () => {
      document.title = prev;
    };
  }, [data]);

  if (!validId || query.error || (!query.isPending && !data)) {
    return (
      <div className="page stack">
        <ErrorText error={query.error ?? "시간외근무 신청서를 찾을 수 없습니다."} />
        <div>
          <Link to="/overtime">시간외근무 목록으로</Link>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <Spinner />
      </div>
    );
  }

  const r = data.request;
  const onBeforePrint = async () => {
    const result = await overtimeApi.print(id);
    flushSync(() => setPrinted(result));
    void invalidateLeaveData(qc);
  };

  const lastPrinted = r.lastPrintedAt ? `최근 출력 ${formatTimestamp(r.lastPrintedAt)}` : "아직 출력하지 않았습니다.";
  let notice: { text: string; warn?: boolean };
  if (r.kind !== "general") {
    notice = { text: lastPrinted };
  } else if (r.submittedOn) {
    notice = { text: `제출일 ${dotDate(r.submittedOn)} · 적립 완료 · ${lastPrinted}` };
  } else {
    // 미제출: 이번 인쇄가 제출·적립 (대상자마다 신청서에서 고른 종류로)
    notice = {
      warn: true,
      text: `인쇄하면 오늘 날짜로 제출되고 ${withJosa(accrual.namesOf(r.targets) || "휴가", "이", "가")} 적립됩니다.`,
    };
  }

  return (
    <div className="otp-root">
      <PrintShell
        title={r.kind === "general" ? "시간외근무 신청서" : `${KIND_LABEL[r.kind]} 신청서`}
        onBeforePrint={onBeforePrint}
        toolbarExtra={
          <span className={["otp-notice", notice.warn ? "otp-notice-warn" : "muted"].join(" ")} title={notice.text}>
            {notice.text}
          </span>
        }
      >
        {r.kind === "general" ? <GeneralOvertimeSheet data={data} /> : <SoldierOvertimeSheet data={data} />}
      </PrintShell>
    </div>
  );
}
