import { overtimeGeneralInput, type OvertimeGeneralInput, type OvertimeRequest } from "@leave-flow/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { ApiRequestError, errorMessage } from "../../lib/api.ts";
import { localToday } from "../../lib/format.ts";
import { invalidateLeaveData, useEmployees } from "../../lib/queries.ts";
import { DateInput, DurationInput, TimeSelect, allDayTimes } from "../form/index.tsx";
import { Button, Callout, ColorDot, EmptyState, Field, Modal, Spinner, TextInput, Textarea, useToast } from "../ui/index.tsx";
import { overtimeApi, useAccrualTypes } from "./api.ts";
import { EmployeeChecklist } from "./EmployeeChecklist.tsx";
import { AccrualTypeSelect, CategoryRadios, FieldGroup } from "./FieldGroup.tsx";
import { dotDate } from "./labels.ts";
import "./overtime.css";

const TIMES = allDayTimes();

type ErrorKey = "employeeIds" | "leaveTypes" | "period" | "minutes" | "other";

/** 일반 시간외근무 신청서 작성·수정 */
export function GeneralOvertimeEditor({
  request,
  onClose,
  onSaved,
}: {
  request: OvertimeRequest | null;
  onClose: () => void;
  /** 저장 성공 직후 (닫기 전) 저장된 신청서로 호출 */
  onSaved?: (saved: OvertimeRequest) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useEmployees(true);
  const accrual = useAccrualTypes();
  const today = localToday();

  const initialIds = request?.targets.map((t) => t.employeeId) ?? [];
  const initialTypeOf = (id: number) => request?.targets.find((t) => t.employeeId === id)?.leaveTypeId;
  const [employeeIds, setEmployeeIds] = useState<number[]>(initialIds);
  /** 직원별 적립 종류 (대상에서 뺐다가 다시 넣으면 고른 값이 그대로 남음) */
  const [leaveTypeIds, setLeaveTypeIds] = useState<Record<number, number | null>>(() =>
    Object.fromEntries(request?.targets.map((t) => [t.employeeId, t.leaveTypeId]) ?? []),
  );
  const [startDate, setStartDate] = useState(request?.workStartAt?.slice(0, 10) ?? today);
  const [startTime, setStartTime] = useState(request?.workStartAt?.slice(11, 16) ?? "");
  const [endDate, setEndDate] = useState(request?.workEndAt?.slice(0, 10) ?? today);
  const [endTime, setEndTime] = useState(request?.workEndAt?.slice(11, 16) ?? "");
  const [minutes, setMinutes] = useState(request?.minutes ?? 0);
  const [cumulativeNote, setCumulativeNote] = useState(request?.cumulativeNote ?? "");
  const [category, setCategory] = useState<"official_event" | "special_work">(
    request?.category === "official_event" ? "official_event" : "special_work",
  );
  const [workDetails, setWorkDetails] = useState(request?.workDetails ?? "");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  // 새로 고를 수 있는 직원은 활성 직원만 (수정 중이면 원래 대상은 그대로 보여 줌)
  const choices = (employees.data ?? []).filter((e) => e.active || initialIds.includes(e.id));
  // 대상 직원 (고른 순서)
  const selected = employeeIds.flatMap((id) => choices.filter((e) => e.id === id));

  const validate = (): { input: OvertimeGeneralInput | null; errors: Partial<Record<ErrorKey, string>> } => {
    const errors: Partial<Record<ErrorKey, string>> = {};
    if (!startDate || !startTime || !endDate || !endTime) errors.period = "근무 시작·종료 일시를 선택하세요.";
    const parsed = overtimeGeneralInput.safeParse({
      kind: "general",
      targets: employeeIds.map((employeeId) => ({ employeeId, leaveTypeId: leaveTypeIds[employeeId] ?? null })),
      workStartAt: `${startDate}T${startTime}`,
      workEndAt: `${endDate}T${endTime}`,
      minutes,
      cumulativeNote,
      category,
      workDetails,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        const field: ErrorKey =
          key === "targets"
            ? issue.path[2] === "leaveTypeId"
              ? "leaveTypes"
              : "employeeIds"
            : key === "minutes"
              ? "minutes"
              : key === "workStartAt" || key === "workEndAt"
                ? "period"
                : "other";
        errors[field] ??= issue.message;
      }
    }
    return { input: parsed.success && !errors.period ? parsed.data : null, errors };
  };
  const { errors } = validate();
  const shown = showErrors ? errors : {};

  const changeStartDate = (v: string) => {
    // 종료일이 시작일과 같았거나 더 이르면 함께 옮김
    setEndDate((prev) => (!prev || prev === startDate || prev < v ? v : prev));
    setStartDate(v);
  };

  const save = async () => {
    setShowErrors(true);
    const { input, errors: errs } = validate();
    if (!input) {
      if (errs.other) toast(errs.other, "error");
      return;
    }
    setSaving(true);
    try {
      const saved = request
        ? await overtimeApi.update(request.id, input, request.updatedAt)
        : await overtimeApi.create(input);
      void invalidateLeaveData(qc);
      toast(
        request?.accrued
          ? "수정했습니다. 적립된 휴가도 함께 수정했습니다."
          : request
            ? "수정했습니다."
            : "저장했습니다. 처음 출력할 때 제출되고 적립됩니다.",
      );
      onSaved?.(saved);
      onClose();
    } catch (err) {
      // 다른 사람이 먼저 고친 경우 등: 다시 열면 최신 내용이 보이게
      if (err instanceof ApiRequestError && err.status === 409) void invalidateLeaveData(qc);
      toast(errorMessage(err), "error");
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={request ? "시간외근무 신청서 수정" : "새 시간외근무 신청서"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>닫기</Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </Button>
        </>
      }
    >
      <div className="stack">
        {request?.submittedOn ? (
          <Callout tone="info">
            {dotDate(request.submittedOn)}에 제출된 신청서입니다. 저장하면 적립된 {accrual.namesOf(request.targets) || "휴가"}도
            함께 수정됩니다.
          </Callout>
        ) : (
          <Callout tone="info">처음 출력할 때 제출일이 정해지고 대상자마다 고른 휴가 종류로 적립됩니다.</Callout>
        )}

        <FieldGroup label="대상 직원" required error={shown.employeeIds} hint="여러 명이면 모두 같은 근무시간·같은 발생량으로 적립됩니다.">
          {employees.isPending ? (
            <Spinner />
          ) : choices.length === 0 ? (
            <EmptyState title="등록된 직원이 없습니다.">
              <Link to="/admin/employees">관리 &gt; 직원에서 먼저 등록하세요.</Link>
            </EmptyState>
          ) : (
            <EmployeeChecklist
              employees={choices}
              selected={employeeIds}
              onChange={setEmployeeIds}
              invalid={!!shown.employeeIds}
            />
          )}
        </FieldGroup>
        {selected.length > 0 && (
          <FieldGroup
            label="적립할 휴가 종류"
            required
            error={shown.leaveTypes}
            hint="대상 직원마다 그 직원에게 적용되는 종류 중에서 고릅니다."
          >
            <div className="ot-agent-list">
              {selected.map((e) => (
                <div key={e.id} className="ot-agent">
                  <span className="ot-type-name">
                    <ColorDot color={e.color} />
                    <span>{e.name}</span>
                  </span>
                  <AccrualTypeSelect
                    name={e.name}
                    options={accrual.optionsFor(e, initialTypeOf(e.id))}
                    value={leaveTypeIds[e.id] ?? null}
                    onChange={(id) => setLeaveTypeIds((prev) => ({ ...prev, [e.id]: id }))}
                    invalid={!!shown.leaveTypes && !leaveTypeIds[e.id]}
                  />
                </div>
              ))}
            </div>
          </FieldGroup>
        )}

        <FieldGroup label="근무시간" required error={shown.period}>
          <div className="ot-period">
            <div className="ot-when">
              <span className="ot-when-label">시작</span>
              <DateInput value={startDate} onChange={changeStartDate} ariaLabel="근무 시작일" invalid={!!shown.period} />
              <TimeSelect value={startTime} onChange={setStartTime} options={TIMES} ariaLabel="근무 시작 시각" invalid={!!shown.period} />
            </div>
            <span className="ot-period-sep">~</span>
            <div className="ot-when">
              <span className="ot-when-label">종료</span>
              <DateInput value={endDate} onChange={setEndDate} min={startDate} ariaLabel="근무 종료일" invalid={!!shown.period} />
              <TimeSelect value={endTime} onChange={setEndTime} options={TIMES} ariaLabel="근무 종료 시각" invalid={!!shown.period} />
            </div>
          </div>
        </FieldGroup>

        <div className="form-grid">
          <FieldGroup
            label="금일발생"
            required
            error={shown.minutes}
            hint="10분 단위로 직접 입력합니다. (근무시간에서 자동 계산하지 않음)"
          >
            <DurationInput value={minutes} onChange={setMinutes} ariaLabel="금일발생" />
          </FieldGroup>
          <Field label="누적" hint="화면에서만 보관하고 양식에는 출력되지 않습니다.">
            <TextInput value={cumulativeNote} maxLength={100} onChange={(e) => setCumulativeNote(e.target.value)} />
          </Field>
        </div>

        <FieldGroup label="상세내용" required>
          <CategoryRadios options={["official_event", "special_work"] as const} value={category} onChange={setCategory} />
        </FieldGroup>

        <Field label="근무내역">
          <Textarea rows={5} maxLength={3000} value={workDetails} onChange={(e) => setWorkDetails(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
