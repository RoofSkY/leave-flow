import type { AbsenceRow } from "@leave-flow/shared";
import { useEffect, useState } from "react";
import { Button, ColorDot, ErrorText, Spinner } from "../ui/index.tsx";
import { formatLeaveMinutes } from "@leave-flow/shared";
import { formatDateKo, localToday } from "../../lib/format.ts";
import { shortRange, useAbsences } from "./leaveQueries.ts";
import "./calendar.css";

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

function AbsenceList({
  rows,
  empty,
  withDate,
  onOpen,
}: {
  rows: AbsenceRow[];
  empty: string;
  withDate: boolean;
  onOpen: (requestId: number) => void;
}) {
  if (rows.length === 0) return <div className="lf-absence-empty">{empty}</div>;
  return (
    <ul className="lf-absence-list">
      {rows.map((r) => (
        <li key={`${r.itemId}`}>
          <button type="button" className="lf-absence-row" onClick={() => onOpen(r.requestId)}>
            <ColorDot color={r.color} />
            <span className="lf-absence-name">
              {r.employeeName}
              <span className="lf-absence-type">{r.leaveTypeName}</span>
            </span>
            <span className="lf-absence-dur">{formatLeaveMinutes(r.minutes, r.dayMinutes)}</span>
            <span className="lf-absence-time">{shortRange(r.startAt, r.endAt, withDate)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 오늘 날짜. 브라우저를 밤새 켜 두어도 자정이 지나면 바뀌도록
 * 1분마다, 그리고 창이 다시 보이거나 포커스를 받을 때 확인
 */
function useLocalToday(): string {
  const [today, setToday] = useState(localToday);
  useEffect(() => {
    const check = () => setToday(localToday());
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}

/** 오늘 / 이번 주(월~일) 휴가자 */
export function AbsencePanel({ onOpenRequest, onClose }: { onOpenRequest: (id: number) => void; onClose: () => void }) {
  // 날짜가 바뀌면 조회 키도 새 날짜로 바뀌어 다시 불러옴
  const today = useLocalToday();
  const { data, isPending, error } = useAbsences(today);

  return (
    <aside className="lf-absence" aria-label="부재자">
      <div className="lf-absence-head">
        <h2>부재자</h2>
        <span className="spacer" />
        <Button variant="ghost" size="sm" icon title="패널 닫기" aria-label="패널 닫기" onClick={onClose}>
          ✕
        </Button>
      </div>
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorText error={error} />
      ) : (
        <>
          <section className="lf-absence-section">
            <h3>
              오늘 <span className="muted">{formatDateKo(data.date)}</span>
            </h3>
            <AbsenceList rows={data.today} empty="오늘 휴가자가 없습니다." withDate={false} onOpen={onOpenRequest} />
          </section>
          <section className="lf-absence-section">
            <h3>
              이번 주{" "}
              <span className="muted">
                {md(data.weekStart)} ~ {md(data.weekEnd)}
              </span>
            </h3>
            <AbsenceList rows={data.week} empty="이번 주 휴가자가 없습니다." withDate onOpen={onOpenRequest} />
          </section>
        </>
      )}
    </aside>
  );
}
