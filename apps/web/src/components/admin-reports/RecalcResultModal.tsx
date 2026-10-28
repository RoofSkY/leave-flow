import { formatLeaveMinutes, type RecalcChange } from "@leave-flow/shared";
import { formatRangeKo } from "../../lib/format.ts";
import { Button, Callout, Modal } from "../ui/index.tsx";
import "./admin-reports.css";

/** 공휴일·휴무일 변경으로 사용 시간이 바뀐 휴가원 목록 */
export function RecalcResultModal({ changes, onClose }: { changes: RecalcChange[] | null; onClose: () => void }) {
  return (
    <Modal
      open={!!changes && changes.length > 0}
      title="사용 시간이 다시 계산된 휴가원"
      size="lg"
      onClose={onClose}
      closeOnOverlay
      footer={
        <Button variant="primary" onClick={onClose}>
          확인
        </Button>
      }
    >
      <div className="stack">
        <Callout tone="info">
          공휴일·휴무일이 바뀌어 아래 {changes?.length ?? 0}건의 사용 시간이 바뀌었습니다. 변경 이력에도 기록했습니다.
        </Callout>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>직원</th>
                <th>종류</th>
                <th>기간</th>
                <th className="num">변경 전 → 후</th>
              </tr>
            </thead>
            <tbody>
              {(changes ?? []).map((c) => (
                <tr key={c.itemId}>
                  <td className="nowrap">{c.employeeName}</td>
                  <td className="nowrap">{c.leaveTypeName}</td>
                  <td>{formatRangeKo(c.startAt, c.endAt)}</td>
                  <td className="num nowrap">
                    <span className="muted">{formatLeaveMinutes(c.beforeMinutes, c.dayMinutes)}</span>
                    {" → "}
                    <strong>{formatLeaveMinutes(c.afterMinutes, c.dayMinutes)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
