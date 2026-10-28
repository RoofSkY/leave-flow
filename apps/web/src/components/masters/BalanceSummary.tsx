import { formatLeaveMinutes } from "@leave-flow/shared";
import { useBalances } from "../../lib/queries.ts";
import { ErrorText, Spinner } from "../ui/index.tsx";
import "./masters.css";

/** 직원의 휴가 종류별 잔여 (year 기준, 누적 종류는 그 해까지 합계). dayMinutes: 1일 = 그 직원의 하루 근무시간 */
export function BalanceSummary({ employeeId, year, dayMinutes }: { employeeId: number; year: number; dayMinutes: number }) {
  const balances = useBalances(employeeId, year);
  if (balances.isPending) return <Spinner />;
  if (balances.error) return <ErrorText error={balances.error} />;
  if (balances.data.length === 0) return null;
  return (
    <div className="balance-summary">
      {balances.data.map((b) => {
        const f = (m: number) => formatLeaveMinutes(m, dayMinutes);
        return (
          <div
            key={b.leaveTypeId}
            className={["balance-card", (b.remainingMinutes ?? 0) < 0 && "is-negative"].filter(Boolean).join(" ")}
          >
            <span className="balance-card-name" title={b.name}>
              {b.name}
            </span>
            <span className="balance-card-value">
              {b.remainingMinutes === null ? `사용 ${f(b.usedMinutes)}` : `잔여 ${f(b.remainingMinutes)}`}
            </span>
            {b.remainingMinutes === null ? (
              <span className="balance-card-sub">차감 안 함</span>
            ) : (
              <>
                <span className="balance-card-sub">부여 {f(b.grantedMinutes)}</span>
                <span className="balance-card-sub">사용 {f(b.usedMinutes)}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
