import { formatHoursMinutes, type OvertimeKind, type OvertimeRequest } from "@leave-flow/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  EmployeeFilter,
  filterFromParams,
  useEmployeeFilterMatch,
  withFilterParams,
} from "../../components/form/EmployeeFilter.tsx";
import { GeneralOvertimeEditor } from "../../components/overtime/GeneralOvertimeEditor.tsx";
import { SoldierOvertimeEditor } from "../../components/overtime/SoldierOvertimeEditor.tsx";
import { overtimeApi, useAccrualTypes, useOvertimeList } from "../../components/overtime/api.ts";
import { CATEGORY_LABEL, KIND_LABEL, dotDate, targetDays, targetSummary } from "../../components/overtime/labels.ts";
import "../../components/overtime/overtime.css";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorText,
  PageHeader,
  Select,
  Spinner,
  useConfirm,
  useToast,
} from "../../components/ui/index.tsx";
import { errorMessage } from "../../lib/api.ts";
import { currentYear, formatDateKo, formatRangeKo, formatTimestamp } from "../../lib/format.ts";
import { invalidateLeaveData } from "../../lib/queries.ts";

const KINDS: OvertimeKind[] = ["general", "soldier", "award"];

/** 시간외근무 신청서 목록: 일반 / 사회복무요원 특별휴가 / 특별휴가(시상) */
export function OvertimePage() {
  const [params, setParams] = useSearchParams();
  const kind = KINDS.find((k) => k !== "general" && k === params.get("tab")) ?? "general";
  const thisYear = currentYear();
  const year = Number(params.get("year")) || thisYear;
  const includeCancelled = params.get("cancelled") === "1";
  const filter = filterFromParams(params);
  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const list = useOvertimeList({ kind, year, status: includeCancelled ? "all" : "active" });
  const accrual = useAccrualTypes();
  const matches = useEmployeeFilterMatch(filter);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<{ kind: OvertimeKind; request: OvertimeRequest | null } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const years = [...new Set([thisYear + 1, ...Array.from({ length: 6 }, (_, i) => thisYear - i), year])].sort(
    (a, b) => b - a,
  );

  /** 확인 창에 보여 줄 적립 내용: "보상휴가 1인당 2시간 30분" / "요원휴가 박요원 1일, 최요원 2일" */
  const accrualText = (r: OvertimeRequest) => {
    const names = accrual.namesOf(r.targets);
    if (!names) return "";
    return r.kind === "general"
      ? `${names} 1인당 ${formatHoursMinutes(r.minutes ?? 0)}`
      : `${names} ${r.targets.map((t) => `${t.employeeName} ${t.days ?? 0}일`).join(", ")}`;
  };
  const docLabel = (r: OvertimeRequest) =>
    r.kind === "general" ? `${targetSummary(r)} 시간외근무 신청서` : `${targetSummary(r)} ${KIND_LABEL[r.kind]} 신청서`;

  const run = async (id: number, action: () => Promise<unknown>, done: string) => {
    setBusyId(id);
    try {
      await action();
      void invalidateLeaveData(qc);
      toast(done);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (r: OvertimeRequest) => {
    const detail = accrualText(r);
    const ok = await confirm({
      title: "신청서 취소",
      message: r.accrued
        ? `${docLabel(r)}를 취소합니다.\n적립된 휴가도 함께 회수됩니다.${detail ? `\n(${detail})` : ""}`
        : `${docLabel(r)}를 취소합니다.\n아직 제출(출력)하지 않아 회수할 적립은 없습니다.`,
      confirmLabel: "신청서 취소",
      cancelLabel: "닫기",
      danger: true,
    });
    if (!ok) return;
    await run(r.id, () => overtimeApi.cancel(r.id), r.accrued ? "취소했습니다. 적립된 휴가를 회수했습니다." : "취소했습니다.");
  };

  const restore = async (r: OvertimeRequest) => {
    const reAccrue = r.kind !== "general" || !!r.submittedOn;
    const detail = accrualText(r);
    const ok = await confirm({
      title: "신청서 복구",
      message: reAccrue
        ? `${docLabel(r)}를 복구합니다.\n휴가가 다시 적립됩니다.${detail ? `\n(${detail})` : ""}`
        : `${docLabel(r)}를 복구합니다.`,
      confirmLabel: "복구",
      cancelLabel: "닫기",
    });
    if (!ok) return;
    await run(r.id, () => overtimeApi.restore(r.id), reAccrue ? "복구했습니다. 휴가를 다시 적립했습니다." : "복구했습니다.");
  };

  /** 저장한 신청서가 다른 연도 목록에 들어가면 (예: 1월 초에 작년 12월 근무 작성) 그 연도로 옮겨 바로 보이게 */
  const showSavedYear = (r: OvertimeRequest) => {
    const y = Number((r.kind === "general" ? r.workStartAt : r.paidOn)?.slice(0, 4));
    if (!y || y === year) return;
    setParam("year", y === thisYear ? null : String(y));
    toast(`${y}년 목록으로 이동했습니다.`);
  };

  const all = list.data ?? [];
  // 대상자 중 한 명이라도 맞으면
  const rows = all.filter((r) => r.targets.some((t) => matches(t.employeeId)));

  return (
    <div className="page">
      <PageHeader
        title="시간외근무"
        description="일반 시간외근무는 처음 출력할 때, 사회복무요원 특별휴가·특별휴가(시상)는 저장할 때 휴가가 적립됩니다."
        actions={
          <Button variant="primary" onClick={() => setEditing({ kind, request: null })}>
            + 새 신청서
          </Button>
        }
      />

      <div className="ot-toolbar">
        <div className="ot-tabs" role="tablist" aria-label="신청서 종류">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              className="ot-tab"
              aria-selected={kind === k}
              onClick={() => setParam("tab", k === "general" ? null : k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="ot-filters">
          <Select
            value={year}
            aria-label="연도"
            onChange={(e) => setParam("year", Number(e.target.value) === thisYear ? null : e.target.value)}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </Select>
          <EmployeeFilter
            value={filter}
            onChange={(f) => setParams((prev) => withFilterParams(prev, f), { replace: true })}
            hint="신청서는 대상자 중 한 명이라도 맞으면 보입니다."
          />
          <Checkbox
            label="취소된 것 포함"
            checked={includeCancelled}
            onChange={(v) => setParam("cancelled", v ? "1" : null)}
          />
        </div>
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorText error={list.error} />
      ) : all.length > 0 && rows.length === 0 ? (
        <EmptyState title="조건에 맞는 신청서가 없습니다." />
      ) : rows.length === 0 ? (
        <EmptyState title={`${year}년 ${KIND_LABEL[kind]} 신청서가 없습니다.`}>
          <Button onClick={() => setEditing({ kind, request: null })}>새 신청서 작성</Button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table ot-table">
            <thead>
              {kind === "general" ? (
                <tr>
                  <th>근무일시</th>
                  <th>대상</th>
                  <th className="num">금일발생</th>
                  <th>상세내용</th>
                  <th>상태</th>
                  <th>최근 출력</th>
                  <th aria-label="작업" />
                </tr>
              ) : (
                <tr>
                  <th>지급일자</th>
                  <th>대상</th>
                  <th>상세내용</th>
                  <th>상태</th>
                  <th>최근 출력</th>
                  <th aria-label="작업" />
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.status === "cancelled" ? "cancelled" : undefined}>
                  {r.kind === "general" ? (
                    <>
                      <td className="ot-when-cell">
                        {r.workStartAt && r.workEndAt ? formatRangeKo(r.workStartAt, r.workEndAt) : "-"}
                      </td>
                      <td className="ot-targets">
                        {targetSummary(r)}
                        {r.targets.some((t) => t.employeeDeleted) && <span className="muted"> (삭제된 직원 포함)</span>}
                      </td>
                      <td className="num nowrap">{formatHoursMinutes(r.minutes ?? 0)}</td>
                    </>
                  ) : (
                    <>
                      <td className="nowrap">{r.paidOn ? formatDateKo(r.paidOn) : "-"}</td>
                      <td className="ot-targets">
                        {r.targets.map((t) => (
                          <div key={t.employeeId} className="nowrap">
                            {t.employeeName} – {targetDays(t)}일{t.month !== null && ` (${t.month}월)`}
                            {t.employeeDeleted && <span className="muted"> (삭제된 직원)</span>}
                          </div>
                        ))}
                      </td>
                    </>
                  )}
                  <td className="ot-details">
                    {CATEGORY_LABEL[r.category]}
                    {r.workDetails && (
                      <span className="ot-details-text" title={r.workDetails}>
                        {r.workDetails}
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusBadge request={r} />
                  </td>
                  <td className="ot-printed-cell muted">{formatTimestamp(r.lastPrintedAt)}</td>
                  <td>
                    <div className="ot-row-actions">
                      {r.targets.some((t) => t.employeeDeleted) ? (
                        // 영구 삭제된 직원이 든 신청서는 보기·출력만 (서버와 같은 규칙)
                        r.status === "active" && (
                          <Button size="sm" onClick={() => navigate(`/print/overtime/${r.id}`)}>
                            출력
                          </Button>
                        )
                      ) : r.status === "active" ? (
                        <>
                          <Button size="sm" onClick={() => setEditing({ kind: r.kind, request: r })}>
                            수정
                          </Button>
                          <Button size="sm" onClick={() => navigate(`/print/overtime/${r.id}`)}>
                            출력
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => cancel(r)}>
                            취소
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" disabled={busyId === r.id} onClick={() => restore(r)}>
                          복구
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

      {editing?.kind === "general" && (
        <GeneralOvertimeEditor request={editing.request} onClose={() => setEditing(null)} onSaved={showSavedYear} />
      )}
      {(editing?.kind === "soldier" || editing?.kind === "award") && (
        <SoldierOvertimeEditor
          kind={editing.kind}
          request={editing.request}
          onClose={() => setEditing(null)}
          onSaved={showSavedYear}
        />
      )}
    </div>
  );
}

function StatusBadge({ request: r }: { request: OvertimeRequest }) {
  if (r.status === "cancelled") return <Badge tone="danger">취소</Badge>;
  if (r.kind !== "general") return <Badge tone="success">{r.accrued ? "적립됨" : "신청"}</Badge>;
  if (!r.submittedOn) {
    return (
      <Badge tone="warning" title="처음 출력할 때 제출되고 적립됩니다.">
        미제출 (미적립)
      </Badge>
    );
  }
  return (
    <Badge tone="success">
      제출됨 {dotDate(r.submittedOn)}
      {r.accrued ? " (적립)" : ""}
    </Badge>
  );
}
