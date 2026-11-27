import { dayMinutesOf, formatLeaveMinutes, formatPeriod, needsReprint, type LeaveRequest } from "@leave-flow/shared";
import { Badge, Button, ColorDot, ErrorText, Spinner } from "../ui/index.tsx";
import type { FilterItem } from "./CalendarFilter.tsx";
import { CalendarXIcon } from "../ui/icons.tsx";
import { requestPeriods, useLeaveRequestPages } from "./leaveQueries.ts";

const KIND_LABEL: Record<FilterItem["kind"], string> = {
  department: "소속",
  category: "구분",
  employee: "직원",
  cancelled: "상태",
};

function LeaveCard({ r, showName, onOpen }: { r: LeaveRequest; showName: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={["lf-card", r.status === "cancelled" && "is-cancelled"].filter(Boolean).join(" ")}
      onClick={onOpen}
    >
      {requestPeriods(r).map((p) => (
        <span key={p.key} className="lf-card-period">
          <strong className="lf-card-type">{p.typeName}</strong>
          <span className="lf-card-when">{formatPeriod(p.startAt, p.endAt)}</span>
        </span>
      ))}
      <span className="lf-card-tags">
        {showName && (
          <span className="lf-card-tag">
            <ColorDot color={r.color} />
            {r.employeeName}
          </span>
        )}
        {/* 1일 = 휴가원에 저장된 근무시간 기준 */}
        <span className="lf-card-tag">{formatLeaveMinutes(r.totalMinutes, dayMinutesOf(r))}</span>
        {r.status === "cancelled" && <Badge tone="danger">취소됨</Badge>}
        {r.noDeduct && <Badge>미차감</Badge>}
        {needsReprint(r) && <Badge tone="warning">다시 출력 필요</Badge>}
      </span>
    </button>
  );
}

/** 필터에서 누른 항목의 휴가원 (기간 제한 없이 최근 것부터, 더 불러오기) */
export function FilterLeaveList({
  item,
  closing,
  onClosed,
  showCancelled,
  onClose,
  onOpenRequest,
}: {
  item: FilterItem;
  /** 들어가는 애니메이션 중 (끝나면 onClosed) */
  closing: boolean;
  onClosed: () => void;
  /** 켜져 있으면 취소된 휴가원도 함께 */
  showCancelled: boolean;
  onClose: () => void;
  onOpenRequest: (requestId: number) => void;
}) {
  const list = useLeaveRequestPages({
    status: item.kind === "cancelled" ? "cancelled" : showCancelled ? "all" : "active",
    employeeId: item.kind === "employee" ? item.id : undefined,
    department: item.kind === "department" ? item.name : undefined,
    category: item.kind === "category" ? item.name : undefined,
  });
  const title = item.kind === "cancelled" ? "취소된 휴가" : item.name;
  const rows = list.data ?? [];

  return (
    <aside
      className={["lf-side is-list", closing && "is-closing"].filter(Boolean).join(" ")}
      aria-label={`${title} 휴가원`}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onClosed();
      }}
    >
      <div className="lf-card-head">
        {item.kind === "cancelled" ? (
          <CalendarXIcon />
        ) : (
          <span className="lf-card-swatch" style={{ background: item.kind === "employee" ? item.color : "var(--accent)" }} />
        )}
        <div className="lf-card-head-text">
          <span className="field-label">{KIND_LABEL[item.kind]}</span>
          <h2 className="lf-side-title">{title}</h2>
        </div>
        <Button variant="ghost" size="sm" icon title="목록 닫기" aria-label="목록 닫기" onClick={onClose}>
          ✕
        </Button>
      </div>
      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorText error={list.error} />
      ) : rows.length === 0 ? (
        <p className="lf-absence-empty">휴가원이 없습니다.</p>
      ) : (
        <ul className="lf-cards">
          {rows.map((r) => (
            <li key={r.id}>
              <LeaveCard r={r} showName={item.kind !== "employee"} onOpen={() => onOpenRequest(r.id)} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage ? "불러오는 중…" : "더 불러오기"}
        </Button>
      )}
    </aside>
  );
}
