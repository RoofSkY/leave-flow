import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  yearOf,
  type Holiday,
  type HolidayChangeResult,
  type HolidayInput,
  type RecalcChange,
} from "@leave-flow/shared";
import { HolidayAddForm } from "../../components/admin-reports/HolidayAddForm.tsx";
import { HOLIDAY_KIND_LABELS } from "../../components/admin-reports/labels.ts";
import { RecalcResultModal } from "../../components/admin-reports/RecalcResultModal.tsx";
import { YearSelect } from "../../components/admin-reports/YearSelect.tsx";
import "../../components/admin-reports/admin-reports.css";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  ErrorText,
  PageHeader,
  Spinner,
  useConfirm,
  useToast,
} from "../../components/ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { currentYear, formatDateKo } from "../../lib/format.ts";
import { invalidateLeaveData, qk, useHolidays } from "../../lib/queries.ts";

const label = (h: Holiday) => `${formatDateKo(h.date, true)} ${h.name}`;

export function HolidaysPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [year, setYear] = useState(currentYear);
  const [showDeleted, setShowDeleted] = useState(false);
  const [recalculated, setRecalculated] = useState<RecalcChange[] | null>(null);
  const holidays = useHolidays(`${year}-01-01`, `${year}-12-31`, showDeleted);

  const afterChange = async (changes: RecalcChange[]) => {
    await Promise.all([qc.invalidateQueries({ queryKey: qk.holidaysAll() }), invalidateLeaveData(qc)]);
    if (changes.length > 0) setRecalculated(changes);
  };

  const add = useMutation({
    mutationFn: (input: HolidayInput) => api.post<HolidayChangeResult>("/api/holidays", input),
  });
  const remove = useMutation({
    mutationFn: (h: Holiday) => api.del<HolidayChangeResult>(`/api/holidays/${h.id}`),
  });
  const restore = useMutation({
    mutationFn: (h: Holiday) => api.post<HolidayChangeResult>(`/api/holidays/${h.id}/restore`),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ added: number; recalculated: RecalcChange[] }>("/api/holidays/sync"),
  });
  const busy = add.isPending || remove.isPending || restore.isPending || sync.isPending;

  const onAdd = async (input: HolidayInput): Promise<boolean> => {
    try {
      const result = await add.mutateAsync(input);
      toast(`${formatDateKo(input.date, true)} ${input.name}을(를) 추가했습니다.`);
      if (yearOf(input.date) !== year) setYear(yearOf(input.date));
      await afterChange(result.recalculated);
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    }
  };

  const onDelete = async (h: Holiday) => {
    const ok = await confirm({
      title: "공휴일·휴무일 삭제",
      message:
        `${label(h)}을(를) 삭제할까요?\n아직 지나지 않은 휴가원의 사용 시간이 다시 계산됩니다.` +
        (h.source === "auto" ? "\n자동 등록된 공휴일은 '삭제된 자동 공휴일 보기'에서 되살릴 수 있습니다." : ""),
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await remove.mutateAsync(h);
      toast(`${label(h)}을(를) 삭제했습니다.`);
      await afterChange(result.recalculated);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const onRestore = async (h: Holiday) => {
    const ok = await confirm({
      title: "자동 공휴일 되살리기",
      message: `${label(h)}을(를) 되살릴까요?\n아직 지나지 않은 휴가원의 사용 시간이 다시 계산됩니다.`,
      confirmLabel: "되살리기",
    });
    if (!ok) return;
    try {
      const result = await restore.mutateAsync(h);
      toast(`${label(h)}을(를) 되살렸습니다.`);
      await afterChange(result.recalculated);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const onSync = async () => {
    try {
      const result = await sync.mutateAsync();
      toast(result.added > 0 ? `법정공휴일 ${result.added}건을 새로 등록했습니다.` : "새로 등록할 법정공휴일이 없습니다.");
      await afterChange(result.recalculated);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const rows = holidays.data ?? [];
  const activeRows = rows.filter((h) => h.active);
  const publicDays = new Set(activeRows.filter((h) => h.kind === "public").map((h) => h.date)).size;
  const centerDays = new Set(activeRows.filter((h) => h.kind === "center").map((h) => h.date)).size;

  return (
    <div className="stack">
      <PageHeader
        title="공휴일·휴무일"
        actions={
          <Button
            onClick={onSync}
            disabled={busy}
            title="빠진 법정공휴일을 다시 등록합니다. 직접 삭제한 공휴일은 되살리지 않습니다."
          >
            {sync.isPending ? "불러오는 중…" : "자동 공휴일 다시 불러오기"}
          </Button>
        }
      />
      <Callout tone="info">
        <div>
          법정공휴일은 자동으로 등록됩니다. 선거일·임시공휴일처럼 빠진 날과 센터 휴무일은 아래에서 직접 추가하세요.
          <br />
          추가하거나 삭제하면 아직 지나지 않은 휴가원의 사용 시간이 자동으로 다시 계산됩니다.
        </div>
      </Callout>

      <HolidayAddForm onSubmit={onAdd} pending={add.isPending} />

      <div className="report-toolbar">
        <YearSelect value={year} onChange={setYear} />
        {holidays.data && (
          <span className="muted">
            공휴일 {publicDays}일 · 센터 휴무일 {centerDays}일
          </span>
        )}
        <span className="spacer" />
        <Checkbox label="삭제된 자동 공휴일 보기" checked={showDeleted} onChange={setShowDeleted} />
      </div>

      {holidays.isPending ? (
        <Spinner />
      ) : holidays.error ? (
        <ErrorText error={holidays.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={`${year}년에 등록된 공휴일·휴무일이 없습니다.`}>
          <span>법정공휴일은 올해 기준 앞뒤 몇 년치만 자동으로 등록됩니다. 필요한 날은 위에서 직접 추가하세요.</span>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>날짜</th>
                <th>이름</th>
                <th>구분</th>
                <th>등록 방식</th>
                <th aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id} className={h.active ? undefined : "inactive"}>
                  <td className="nowrap">{formatDateKo(h.date)}</td>
                  <td>
                    <span className="row wrap holiday-name">
                      {h.name}
                      {!h.active && <Badge>삭제됨</Badge>}
                    </span>
                  </td>
                  <td>
                    <Badge tone={h.kind === "public" ? "danger" : "accent"}>{HOLIDAY_KIND_LABELS[h.kind]}</Badge>
                  </td>
                  <td className="nowrap muted">{h.source === "auto" ? "자동" : "직접"}</td>
                  <td className="report-actions">
                    {h.active ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(h)}>
                        삭제
                      </Button>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => onRestore(h)}>
                        되살리기
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RecalcResultModal changes={recalculated} onClose={() => setRecalculated(null)} />
    </div>
  );
}
