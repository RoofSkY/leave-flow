import { useQueryClient } from "@tanstack/react-query";
import {
  WEEKDAY_LABELS,
  dayMinutesOf,
  distinctLeaveTypeLabels,
  formatLeaveMinutes,
  isDateString,
  isTimeString,
  leaveTypeAppliesTo,
  leaveTypeLabel,
  parseTime,
  quickRangeTimes,
  selectableLeaveTimes,
  weekdayOf,
  yearOf,
  type Employee,
  type LeavePreview,
  type LeaveRequest,
  type LeaveSaveResult,
  type LeaveType,
  type QuickRange,
  type WorkSchedule,
} from "@leave-flow/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { DateInput, EmployeeSelect, LeaveTypeSelect, PhoneInput, TimeSelect } from "../form/index.tsx";
import {
  Badge,
  Button,
  Callout,
  ErrorText,
  Field,
  Modal,
  Spinner,
  TextInput,
  Textarea,
  useConfirm,
  useToast,
} from "../ui/index.tsx";
import { ApiRequestError, api, errorMessage } from "../../lib/api.ts";
import { localToday } from "../../lib/format.ts";
import { invalidateLeaveData, useBalances, useEmployees, useHolidays, useLeaveTypes } from "../../lib/queries.ts";
import type { EditorPrefill } from "./LeaveCalendar.tsx";
import { estimateHandoverLines } from "./leaveQueries.ts";
import "./leave.css";

export type EditorTarget = { mode: "create"; prefill?: EditorPrefill } | { mode: "edit"; request: LeaveRequest };

interface ItemDraft {
  key: number;
  leaveTypeId: number | null;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

interface Draft {
  employeeId: number | null;
  items: ItemDraft[];
  reason: string;
  emergencyContact: string;
  handoverNote: string;
}

const MAX_ITEMS = 20;
/** 업무인계가 이 줄 수를 넘으면 출력 시 한 장을 넘을 수 있다고 안내 (항목 1개 기준 약 10줄이 들어감) */
const HANDOVER_HINT_LINES = 10;
const QUICK: [QuickRange, string][] = [
  ["full", "종일"],
  ["am", "오전"],
  ["pm", "오후"],
];

let itemSeq = 0;
function newItem(partial: Partial<ItemDraft> = {}): ItemDraft {
  return { key: ++itemSeq, leaveTypeId: null, startDate: "", startTime: "", endDate: "", endTime: "", ...partial };
}

function isComplete(it: ItemDraft): boolean {
  return (
    it.leaveTypeId !== null &&
    isDateString(it.startDate) &&
    isDateString(it.endDate) &&
    isTimeString(it.startTime) &&
    isTimeString(it.endTime)
  );
}

function toInput(it: ItemDraft) {
  return { leaveTypeId: it.leaveTypeId!, startAt: `${it.startDate}T${it.startTime}`, endAt: `${it.endDate}T${it.endTime}` };
}

/** 직원을 고르면 비어 있는 시각은 근무시간으로 채우고, 근무시간 밖 시각은 안으로 당김 */
function fitToSchedule(it: ItemDraft, s: WorkSchedule): ItemDraft {
  const ws = parseTime(s.workStart);
  const we = parseTime(s.workEnd);
  const clamp = (t: string, fallback: string) => {
    if (!isTimeString(t)) return fallback;
    const m = parseTime(t);
    return m < ws ? s.workStart : m > we ? s.workEnd : t;
  };
  return { ...it, startTime: clamp(it.startTime, s.workStart), endTime: clamp(it.endTime, s.workEnd) };
}

/** 휴가원 작성·수정 창. 기준 데이터를 불러온 뒤 폼을 띄움 */
export function LeaveEditor({
  target,
  onClose,
  onSaved,
}: {
  target: EditorTarget;
  onClose: () => void;
  onSaved: (request: LeaveRequest) => void;
}) {
  const employeesQ = useEmployees(true);
  const typesQ = useLeaveTypes(true);
  const editing = target.mode === "edit" ? target.request : null;
  const title = editing ? "휴가원 수정" : "휴가원 작성";

  if (employeesQ.isPending || typesQ.isPending || employeesQ.error || typesQ.error) {
    return (
      <Modal open title={title} onClose={onClose} size="lg">
        {employeesQ.error || typesQ.error ? <ErrorText error={employeesQ.error ?? typesQ.error} /> : <Spinner />}
      </Modal>
    );
  }

  const usedTypeIds = new Set(editing?.items.map((i) => i.leaveTypeId) ?? []);
  const types = typesQ.data.filter((t) => t.active || usedTypeIds.has(t.id));
  const employees = employeesQ.data.filter((e) => e.active || e.id === editing?.employeeId);

  if (!editing && (!types.length || !employees.length)) {
    const noTypes = !types.length;
    return (
      <Modal open title={title} onClose={onClose} closeOnOverlay>
        <Callout tone="info">
          <span>
            {noTypes ? "관리 화면에서 휴가 종류를 먼저 등록하세요." : "관리 화면에서 직원을 먼저 등록하세요."}{" "}
            <Link className="lf-callout-link" to={noTypes ? "/admin/leave-types" : "/admin/employees"} onClick={onClose}>
              {noTypes ? "휴가 종류 등록하기" : "직원 등록하기"} →
            </Link>
          </span>
        </Callout>
      </Modal>
    );
  }

  return (
    <EditorForm
      title={title}
      target={target}
      employees={employees}
      types={types}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function initialDraft(target: EditorTarget, types: LeaveType[]): Draft {
  if (target.mode === "edit") {
    const r = target.request;
    return {
      employeeId: r.employeeId,
      items: r.items.map((i) =>
        newItem({
          leaveTypeId: i.leaveTypeId,
          startDate: i.startAt.slice(0, 10),
          startTime: i.startAt.slice(11, 16),
          endDate: i.endAt.slice(0, 10),
          endTime: i.endAt.slice(11, 16),
        }),
      ),
      reason: r.reason,
      emergencyContact: r.emergencyContact,
      handoverNote: r.handoverNote,
    };
  }
  const p = target.prefill;
  const startDate = p?.startDate ?? localToday();
  return {
    employeeId: null,
    items: [
      newItem({
        leaveTypeId: types.find((t) => t.active)?.id ?? null,
        startDate,
        endDate: p?.endDate ?? startDate,
        startTime: p?.startTime ?? "",
        endTime: p?.endTime ?? "",
      }),
    ],
    reason: "",
    emergencyContact: "",
    handoverNote: "",
  };
}

function EditorForm({
  title,
  target,
  employees,
  types,
  onClose,
  onSaved,
}: {
  title: string;
  target: EditorTarget;
  employees: Employee[];
  types: LeaveType[];
  onClose: () => void;
  onSaved: (request: LeaveRequest) => void;
}) {
  const editing = target.mode === "edit" ? target.request : null;
  const [initial] = useState(() => initialDraft(target, types));
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const employee = employees.find((e) => e.id === draft.employeeId) ?? null;
  // 1일 = 그 직원의 하루 근무시간
  const fmt = (m: number) => formatLeaveMinutes(m, dayMinutesOf(employee));
  const times = useMemo(() => (employee ? selectableLeaveTimes(employee) : []), [employee]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  // 소진 종류(남은 양이 없으면 숨김): 그 직원의 잔여가 없으면 뺌 (올해·항목 날짜 중 늦은 해까지 쌓인 잔여)
  const balanceYear = Math.max(
    yearOf(localToday()),
    ...draft.items.filter((it) => isDateString(it.startDate)).map((it) => yearOf(it.startDate)),
  );
  const balancesQ = useBalances(draft.employeeId, balanceYear);
  const usedUpIds = (balancesQ.data ?? [])
    .filter(
      (b) =>
        b.balanceMode === "used_up" &&
        !!typeById.get(b.leaveTypeId)?.hideWhenEmpty &&
        b.remainingMinutes !== null &&
        b.remainingMinutes <= 0,
    )
    .map((b) => b.leaveTypeId);
  const keptTypeId = (id: number) => !!editing?.items.some((i) => i.leaveTypeId === id);
  // 고를 수 있는 종류: 그 직원에게 적용되고 위에서 숨기지 않은 종류 + 수정 중인 휴가원에 이미 있던 종류
  const typeOptions = types.filter(
    (t) =>
      keptTypeId(t.id) || ((!employee || leaveTypeAppliesTo(t, employee)) && !usedUpIds.includes(t.id)),
  );
  // 고른 종류가 숨겨지면 (직원을 고른 뒤 잔여를 불러왔을 때) 고를 수 있는 첫 종류로
  const usedUpKey = usedUpIds.join(",");
  const fallbackTypeId = typeOptions.find((t) => t.active)?.id ?? null;
  useEffect(() => {
    if (!usedUpKey) return;
    const hidden = usedUpKey.split(",").map(Number);
    const stale = (it: ItemDraft) => it.leaveTypeId !== null && hidden.includes(it.leaveTypeId) && !keptTypeId(it.leaveTypeId);
    setDraft((d) =>
      d.items.some(stale)
        ? { ...d, items: d.items.map((it) => (stale(it) ? { ...it, leaveTypeId: fallbackTypeId } : it)) }
        : d,
    );
  }, [usedUpKey]); // 숨길 종류가 바뀔 때만
  // 표시 이름으로 보이고, 목록 안에서 겹치면 관리 이름으로 구별
  const typeLabel = distinctLeaveTypeLabels(typeOptions);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  // 공휴일·휴무일 표시용 (조회 실패 시 표시만 생략)
  const dates = draft.items.flatMap((i) => [i.startDate, i.endDate]).filter(isDateString).sort();
  const holidaysQ = useHolidays(dates[0] ?? localToday(), dates[dates.length - 1] ?? localToday());
  const holidayByDate = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of holidaysQ.data ?? []) {
      if (h.active) map.set(h.date, map.has(h.date) ? `${map.get(h.date)}, ${h.name}` : h.name);
    }
    return map;
  }, [holidaysQ.data]);

  /* ---------- 미리보기 (입력이 멈추고 250ms 뒤) ---------- */
  // 다 입력한 항목만 보내고, 응답을 원래 항목 번호(indexes)에 맞춰 표시
  const complete = draft.items.map((it, idx) => (isComplete(it) ? idx : -1)).filter((i) => i >= 0);
  const previewKey = draft.employeeId
    ? JSON.stringify({
        body: {
          employeeId: draft.employeeId,
          items: complete.map((idx) => toInput(draft.items[idx]!)),
          excludeRequestId: editing?.id ?? null,
        },
        indexes: complete,
      })
    : "";
  const [preview, setPreview] = useState<{ key: string; data: LeavePreview; indexes: number[] } | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    if (!previewKey) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const { body, indexes } = JSON.parse(previewKey) as { body: unknown; indexes: number[] };
    const timer = setTimeout(() => {
      api
        .post<LeavePreview>("/api/leave-requests/preview", body)
        .then((data) => {
          if (mySeq !== seq.current) return;
          setPreview({ key: previewKey, data, indexes });
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (mySeq === seq.current) setPreviewError(err);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [previewKey]);

  const stale = !!preview && preview.key !== previewKey;
  const previewItem = (idx: number) => {
    if (!preview) return null;
    const pos = preview.indexes.indexOf(idx);
    return pos >= 0 ? (preview.data.items[pos] ?? null) : null;
  };

  /* ---------- 입력 ---------- */
  const setItem = (key: number, patch: Partial<ItemDraft> | ((it: ItemDraft) => Partial<ItemDraft>)) =>
    setDraft((d) => ({
      ...d,
      items: d.items.map((it) => (it.key === key ? { ...it, ...(typeof patch === "function" ? patch(it) : patch) } : it)),
    }));

  const selectEmployee = (id: number | null) => {
    const next = employees.find((e) => e.id === id) ?? null;
    setDraft((d) => {
      const prev = employees.find((e) => e.id === d.employeeId);
      const keepContact = d.emergencyContact !== "" && d.emergencyContact !== prev?.emergencyContact;
      return {
        ...d,
        employeeId: id,
        emergencyContact: keepContact ? d.emergencyContact : (next?.emergencyContact ?? ""),
        items: next
          ? d.items.map((it) => {
              // 새 직원에게 적용되지 않는 종류는 그 직원에게 적용되는 첫 종류로
              const type = it.leaveTypeId !== null ? types.find((t) => t.id === it.leaveTypeId) : undefined;
              const leaveTypeId =
                type && !leaveTypeAppliesTo(type, next)
                  ? (types.find((t) => t.active && leaveTypeAppliesTo(t, next))?.id ?? null)
                  : it.leaveTypeId;
              return fitToSchedule({ ...it, leaveTypeId }, next);
            })
          : d.items,
      };
    });
  };

  const addItem = () =>
    setDraft((d) => {
      const last = d.items[d.items.length - 1];
      const date = last?.endDate || localToday();
      const base = newItem({ leaveTypeId: last?.leaveTypeId ?? null, startDate: date, endDate: date });
      return { ...d, items: [...d.items, employee ? fitToSchedule(base, employee) : base] };
    });

  const removeItem = (key: number) => setDraft((d) => ({ ...d, items: d.items.filter((it) => it.key !== key) }));

  // 종일: 여러 날 범위는 그대로 두고 시각만 근무시간으로. 반차(오전·오후)는 하루짜리 항목에서만 (버튼을 막아 둠)
  const applyQuick = (key: number, range: QuickRange) => {
    if (!employee) return;
    const q = quickRangeTimes(employee, range);
    setItem(key, (it) => ({
      startTime: q.start,
      endTime: q.end,
      endDate:
        range === "full" && isDateString(it.endDate) && it.endDate >= it.startDate ? it.endDate : it.startDate,
    }));
  };

  /* ---------- 닫기·저장 ---------- */
  const closing = useRef(false);
  const requestClose = async () => {
    if (closing.current || saving) return;
    if (dirty) {
      closing.current = true;
      const ok = await confirm({
        title: "작성 중인 내용이 있습니다",
        message: "저장하지 않고 닫을까요?",
        confirmLabel: "닫기",
        cancelLabel: "계속 작성",
        danger: true,
      });
      closing.current = false;
      if (!ok) return;
    }
    onClose();
  };

  const save = async () => {
    if (!draft.employeeId) {
      toast("직원을 선택하세요.", "error");
      return;
    }
    if (draft.items.length === 0) {
      toast("휴가 항목을 하나 이상 추가하세요.", "error");
      return;
    }
    const missing = draft.items.findIndex((it) => !isComplete(it));
    if (missing >= 0) {
      toast(`${missing + 1}번째 항목의 휴가 종류와 기간을 모두 입력하세요.`, "error");
      return;
    }
    if (!draft.reason.trim()) {
      toast("휴가사유를 입력하세요.", "error");
      return;
    }
    if (!draft.emergencyContact.trim()) {
      toast("비상연락처를 입력하세요.", "error");
      return;
    }
    const body = {
      employeeId: draft.employeeId,
      items: draft.items.map(toInput),
      reason: draft.reason,
      emergencyContact: draft.emergencyContact,
      handoverNote: draft.handoverNote,
    };
    setSaving(true);
    try {
      const res = editing
        ? await api.put<LeaveSaveResult>(`/api/leave-requests/${editing.id}`, { ...body, baseUpdatedAt: editing.updatedAt })
        : await api.post<LeaveSaveResult>("/api/leave-requests", body);
      void invalidateLeaveData(qc);
      toast(editing ? "휴가원을 수정했습니다." : "휴가원을 저장했습니다. 상세 화면에서 출력할 수 있습니다.");
      if (res.warnings.length) toast(res.warnings.map((w) => w.message).join("\n"), "warning");
      onSaved(res.request);
    } catch (err) {
      // 다른 사람이 먼저 고친 경우 등: 다시 열면 최신 내용이 보이게
      if (err instanceof ApiRequestError && err.status === 409) void invalidateLeaveData(qc);
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  /* ---------- 표시 ---------- */
  const dateFlag = (date: string) => {
    if (!isDateString(date)) return null;
    const holiday = holidayByDate.get(date);
    if (employee && !employee.workDays.includes(weekdayOf(date))) {
      return <span className="lf-dt-flag is-bad">{WEEKDAY_LABELS[weekdayOf(date)]}요일 · 근무 요일이 아닙니다</span>;
    }
    if (holiday) return <span className="lf-dt-flag is-holiday">{holiday} · 휴가 시간에서 빠집니다</span>;
    return null;
  };

  const itemResult = (it: ItemDraft, idx: number) => {
    if (!employee) return <span className="faint">직원을 선택하면 사용 시간을 계산합니다.</span>;
    if (!isComplete(it)) return <span className="faint">휴가 종류와 기간을 입력하세요.</span>;
    const p = previewItem(idx);
    if (!p) return <span className="faint">계산 중…</span>;
    if (p.error) return <span className="lf-err">{p.error}</span>;
    return (
      <span>
        사용 시간 <strong>{fmt(p.minutes)}</strong>
      </span>
    );
  };

  return (
    <Modal
      open
      title={title}
      onClose={requestClose}
      size="lg"
      footer={
        <>
          <Button onClick={requestClose} disabled={saving}>
            닫기
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </Button>
        </>
      }
    >
      <div className="lf-editor">
        <Field label="직원" required>
          <EmployeeSelect employees={employees} value={draft.employeeId} onChange={selectEmployee} disabled={!!editing} />
        </Field>
        {employee && (
          <div className="lf-emp-meta muted">
            근무 {employee.workDays.map((d) => WEEKDAY_LABELS[d]).join("·")} {employee.workStart}~{employee.workEnd}
          </div>
        )}

        <div>
          <div className="lf-section-head">
            <span className="section-title">휴가 항목</span>
            <span className="spacer" />
            <Button size="sm" onClick={addItem} disabled={draft.items.length >= MAX_ITEMS}>
              + 항목 추가
            </Button>
          </div>
          <div className="lf-items">
            {draft.items.map((it, idx) => {
              const n = idx + 1;
              return (
                <div key={it.key} className="lf-item">
                  <div className="lf-item-head">
                    <span className="lf-item-no">{n}</span>
                    <div className="lf-item-type">
                      <LeaveTypeSelect
                        leaveTypes={typeOptions}
                        labelOf={typeLabel}
                        value={it.leaveTypeId}
                        onChange={(v) => setItem(it.key, { leaveTypeId: v })}
                      />
                    </div>
                    <div className="lf-quick" role="group" aria-label={`${n}번째 항목 빠른 선택`}>
                      {QUICK.map(([range, label]) => {
                        const q = employee ? quickRangeTimes(employee, range) : null;
                        const multiDay = isDateString(it.endDate) && it.endDate !== it.startDate;
                        const halfOnMultiDay = range !== "full" && multiDay;
                        const on = !!q && !halfOnMultiDay && it.startTime === q.start && it.endTime === q.end;
                        return (
                          <button
                            key={range}
                            type="button"
                            aria-pressed={on}
                            disabled={!employee || !isDateString(it.startDate) || halfOnMultiDay}
                            title={
                              !employee
                                ? "직원을 먼저 선택하세요."
                                : halfOnMultiDay
                                  ? "여러 날 항목에는 종일만 쓸 수 있습니다. 반차는 시작일과 종료일을 같게 하세요."
                                  : undefined
                            }
                            onClick={() => applyQuick(it.key, range)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="spacer" />
                    {draft.items.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon
                        title="항목 삭제"
                        aria-label={`${n}번째 항목 삭제`}
                        onClick={() => removeItem(it.key)}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                  <div className="lf-item-range">
                    <div className="lf-dt">
                      <span className="lf-dt-label">시작</span>
                      <DateInput
                        value={it.startDate}
                        ariaLabel={`${n}번째 항목 시작일`}
                        onChange={(v) =>
                          setItem(it.key, (cur) => ({
                            startDate: v,
                            endDate: cur.endDate === cur.startDate || v > cur.endDate ? v : cur.endDate,
                          }))
                        }
                      />
                      <TimeSelect
                        value={it.startTime}
                        options={times}
                        disabled={!employee}
                        ariaLabel={`${n}번째 항목 시작 시각`}
                        onChange={(v) => setItem(it.key, { startTime: v })}
                      />
                      {dateFlag(it.startDate)}
                    </div>
                    <span className="lf-tilde">~</span>
                    <div className="lf-dt">
                      <span className="lf-dt-label">종료</span>
                      <DateInput
                        value={it.endDate}
                        min={it.startDate || undefined}
                        ariaLabel={`${n}번째 항목 종료일`}
                        onChange={(v) => setItem(it.key, { endDate: v })}
                      />
                      <TimeSelect
                        value={it.endTime}
                        options={times}
                        disabled={!employee}
                        ariaLabel={`${n}번째 항목 종료 시각`}
                        onChange={(v) => setItem(it.key, { endTime: v })}
                      />
                      {it.endDate !== it.startDate && dateFlag(it.endDate)}
                    </div>
                  </div>
                  <div className={["lf-item-result", stale && "lf-stale"].filter(Boolean).join(" ")}>
                    {itemResult(it, idx)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <PreviewPanel
          hasEmployee={!!employee}
          preview={preview?.data ?? null}
          stale={stale}
          error={previewError}
          typeById={typeById}
          dayMinutes={dayMinutesOf(employee)}
        />

        <Field label="휴가사유" required>
          <TextInput
            value={draft.reason}
            maxLength={500}
            placeholder="예: 개인 사유"
            onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
          />
        </Field>
        <Field label="비상연락처" required hint="직원을 고르면 직원 정보의 비상연락처가 들어갑니다.">
          <PhoneInput
            value={draft.emergencyContact}
            onChange={(v) => setDraft((d) => ({ ...d, emergencyContact: v }))}
          />
        </Field>
        <Field
          label="업무인계 및 기타사항"
          hint={
            estimateHandoverLines(draft.handoverNote) > HANDOVER_HINT_LINES
              ? "내용이 길어 출력하면 A4 한 장을 넘을 수 있습니다. 출력 화면에서 확인하세요."
              : undefined
          }
        >
          <Textarea
            value={draft.handoverNote}
            maxLength={2000}
            rows={3}
            placeholder="해당 사항이 있을 때 적어 주세요."
            onChange={(e) => setDraft((d) => ({ ...d, handoverNote: e.target.value }))}
          />
        </Field>
      </div>
    </Modal>
  );
}

function PreviewPanel({
  hasEmployee,
  preview,
  stale,
  error,
  typeById,
  dayMinutes,
}: {
  hasEmployee: boolean;
  preview: LeavePreview | null;
  stale: boolean;
  error: unknown;
  typeById: Map<number, LeaveType>;
  /** 1일 = 그 직원의 하루 근무시간 */
  dayMinutes: number;
}) {
  const fmt = (m: number) => formatLeaveMinutes(m, dayMinutes);
  const afterById = new Map(preview?.balancesAfter.map((b) => [b.leaveTypeId, b]) ?? []);
  const rows = preview?.balancesBefore.filter((b) => b.deducts) ?? [];
  // 표시 이름 (겹치면 관리 이름)
  const rowLabel = distinctLeaveTypeLabels(preview?.balancesBefore ?? []);
  const labelById = new Map(preview?.balancesBefore.map((b) => [b.leaveTypeId, rowLabel(b)]) ?? []);
  const year = preview?.balancesBefore[0]?.year;

  return (
    <div className="lf-preview">
      <div className="lf-preview-head">
        <span className="section-title">이번 사용 · 잔여</span>
        {year && <span className="muted">{year}년 기준</span>}
      </div>
      {!hasEmployee ? (
        <span className="muted">직원을 선택하면 휴가 종류별 잔여를 보여 줍니다.</span>
      ) : error ? (
        <ErrorText error={error} />
      ) : !preview ? (
        <Spinner label="계산 중" />
      ) : (
        <div className={["stack", stale && "lf-stale"].filter(Boolean).join(" ")} style={{ gap: 10 }}>
          {preview.totalsByType.length > 0 && (
            <div className="lf-totals">
              <span className="muted">이번 사용</span>
              {preview.totalsByType.map((t) => {
                const type = typeById.get(t.leaveTypeId);
                return (
                  <Badge key={t.leaveTypeId} tone="accent">
                    {labelById.get(t.leaveTypeId) ?? (type ? leaveTypeLabel(type) : "휴가")} {fmt(t.minutes)}
                  </Badge>
                );
              })}
            </div>
          )}
          {rows.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>종류</th>
                    <th className="num">현재 잔여</th>
                    <th className="num">이번 사용</th>
                    <th className="num">신청 후 잔여</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => {
                    const after = afterById.get(b.leaveTypeId);
                    const before = b.remainingMinutes ?? 0;
                    const remaining = after?.remainingMinutes ?? before;
                    const used = before - remaining;
                    return (
                      <tr key={b.leaveTypeId} className={used ? "lf-row-used" : undefined}>
                        <td>{labelById.get(b.leaveTypeId)}</td>
                        <td className={["num", before < 0 && "lf-neg"].filter(Boolean).join(" ")}>
                          {fmt(before)}
                        </td>
                        <td className="num">{used ? fmt(used) : "-"}</td>
                        <td className={["num", remaining < 0 && "lf-neg"].filter(Boolean).join(" ")}>
                          {fmt(remaining)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <span className="muted">잔여를 관리하는 휴가 종류가 없습니다.</span>
          )}
          {preview.warnings.length > 0 && (
            <Callout tone="warning">
              <div>
                <strong>확인해 주세요. (저장은 할 수 있습니다)</strong>
                <ul className="lf-warnings">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </div>
            </Callout>
          )}
        </div>
      )}
    </div>
  );
}
