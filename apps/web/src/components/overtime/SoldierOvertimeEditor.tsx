import {
  awardWorkDetails,
  overtimeAwardInput,
  overtimeSoldierInput,
  soldierWorkDetails,
  type OvertimeAwardInput,
  type OvertimeCategory,
  type OvertimeRequest,
  type OvertimeSoldierInput,
} from "@leave-flow/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { ApiRequestError, errorMessage } from "../../lib/api.ts";
import { localToday } from "../../lib/format.ts";
import { invalidateLeaveData, useEmployees } from "../../lib/queries.ts";
import { DateInput } from "../form/index.tsx";
import { Button, Callout, ColorDot, EmptyState, Modal, Select, Spinner, TextInput, Textarea, useToast } from "../ui/index.tsx";
import { overtimeApi, useAccrualTypes } from "./api.ts";
import { AccrualTypeSelect, CategoryRadios, FieldGroup } from "./FieldGroup.tsx";
import { KIND_LABEL, targetDays, withJosa } from "./labels.ts";
import "./overtime.css";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

interface TargetState {
  /** 적립 휴가 종류 (처음에는 비어 있음) */
  leaveTypeId: number | null;
  days: number;
  month: number;
  /** 발생 월을 직접 고르지 않았으면 지급일자의 월을 따라감 */
  monthAuto: boolean;
}

const monthOf = (date: string) => Number(date.slice(5, 7)) || 1;
const validDays = (d: number) => Number.isInteger(d) && d >= 1 && d <= 31;

/** 사회복무요원 특별휴가·특별휴가(시상) 신청서 작성·수정. 시상은 발생 월이 없고 상세내용은 시상 하나 */
export function SoldierOvertimeEditor({
  kind,
  request,
  onClose,
  onSaved,
}: {
  kind: "soldier" | "award";
  request: OvertimeRequest | null;
  onClose: () => void;
  /** 저장 성공 직후 (닫기 전) 저장된 신청서로 호출 */
  onSaved?: (saved: OvertimeRequest) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useEmployees(true);
  const accrual = useAccrualTypes();
  const isAward = kind === "award";
  // 근무내역 기본 문구: 시상은 요원별 지급 줄, 요원은 '특별휴가'일 때만 법 조항 + 요원별 발생 ('공식행사'면 비워 둠)
  const defaultDetails = (cat: OvertimeCategory, items: { name: string; month: number; days: number }[]) =>
    isAward ? awardWorkDetails(items) : cat === "special_leave" ? soldierWorkDetails(items) : "";

  const initialPaidOn = request?.paidOn ?? localToday();
  const initialIds = request?.targets.map((t) => t.employeeId) ?? [];
  const [paidOn, setPaidOn] = useState(initialPaidOn);
  const [targets, setTargets] = useState<Record<number, TargetState>>(() =>
    Object.fromEntries(
      (request?.targets ?? []).map((t) => {
        const month = t.month ?? monthOf(initialPaidOn);
        return [
          t.employeeId,
          { leaveTypeId: t.leaveTypeId, days: targetDays(t), month, monthAuto: month === monthOf(initialPaidOn) },
        ];
      }),
    ),
  );
  const [category, setCategory] = useState<"official_event" | "special_leave">(
    request?.category === "official_event" ? "official_event" : "special_leave",
  );
  // 근무내역: 직접 고치기 전까지는 기본 문구를 자동으로 채움
  const [customDetails, setCustomDetails] = useState<string | null>(() => {
    if (!request) return null;
    const auto = defaultDetails(
      request.category,
      request.targets.map((t) => ({ name: t.employeeName, month: t.month ?? 1, days: targetDays(t) })),
    );
    return request.workDetails === auto ? null : request.workDetails;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  // 새로 고를 수 있는 대상은 구분이 사회복무요원 특별휴가 대상인 활성 직원 (수정 중이면 원래 대상도 보여 줌)
  const agents = (employees.data ?? []).filter(
    (e) => (e.active && e.isSocialServiceAgent) || initialIds.includes(e.id),
  );
  // 순서: 저장된 대상은 저장된 순서대로, 새로 고른 요원은 그 뒤에 목록 순서대로 (sort 는 안정 정렬)
  // 성명: 저장된 대상은 작성 시점 이름 (서버도 그대로 둠), 새로 고른 요원만 지금 이름
  // → 열어서 그대로 저장하면 대상 순서·기본 근무내역이 바뀌지 않음
  const storedOrder = (id: number) => {
    const i = initialIds.indexOf(id);
    return i === -1 ? initialIds.length : i;
  };
  const selected = agents
    .filter((e) => targets[e.id])
    .sort((a, b) => storedOrder(a.id) - storedOrder(b.id))
    .map((e) => ({
      employee: e,
      name: request?.targets.find((t) => t.employeeId === e.id)?.employeeName ?? e.name,
      ...targets[e.id]!,
    }));
  const autoDetails = defaultDetails(
    category,
    selected.map((s) => ({ name: s.name, month: s.month, days: s.days })),
  );
  const workDetails = customDetails ?? autoDetails;

  const toggle = (id: number, on: boolean) =>
    setTargets((prev) => {
      const next = { ...prev };
      if (on) next[id] = { leaveTypeId: null, days: 1, month: monthOf(paidOn), monthAuto: true };
      else delete next[id];
      return next;
    });
  const patch = (id: number, p: Partial<TargetState>) =>
    setTargets((prev) => ({ ...prev, [id]: { ...prev[id]!, ...p } }));
  const changePaidOn = (v: string) => {
    setPaidOn(v);
    if (!v) return;
    setTargets((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([id, t]) => [id, t.monthAuto ? { ...t, month: monthOf(v) } : t]),
      ),
    );
  };

  const validate = (): { input: OvertimeSoldierInput | OvertimeAwardInput | null; error: string | null } => {
    if (selected.length === 0) return { input: null, error: "대상 요원을 한 명 이상 선택하세요." };
    if (!paidOn) return { input: null, error: "지급일자를 입력하세요." };
    if (selected.some((s) => s.leaveTypeId === null)) {
      return { input: null, error: "요원마다 적립할 휴가 종류를 선택하세요." };
    }
    if (selected.some((s) => !validDays(s.days))) {
      return { input: null, error: "발생 일수는 1~31 사이의 정수로 입력하세요." };
    }
    const parsed = isAward
      ? overtimeAwardInput.safeParse({
          kind,
          targets: selected.map((s) => ({ employeeId: s.employee.id, leaveTypeId: s.leaveTypeId, days: s.days })),
          paidOn,
          workDetails,
        })
      : overtimeSoldierInput.safeParse({
          kind,
          targets: selected.map((s) => ({
            employeeId: s.employee.id,
            leaveTypeId: s.leaveTypeId,
            days: s.days,
            month: s.month,
          })),
          paidOn,
          category,
          workDetails,
        });
    return parsed.success
      ? { input: parsed.data, error: null }
      : { input: null, error: parsed.error.issues[0]?.message ?? "입력값을 확인하세요." };
  };
  const { error } = validate();

  const save = async () => {
    setShowErrors(true);
    const { input } = validate();
    if (!input) return;
    setSaving(true);
    try {
      const saved = request
        ? await overtimeApi.update(request.id, input, request.updatedAt)
        : await overtimeApi.create(input);
      void invalidateLeaveData(qc);
      toast(
        request
          ? "수정했습니다. 적립된 휴가도 함께 수정했습니다."
          : `저장했습니다. ${withJosa(accrual.namesOf(saved.targets) || "휴가", "이", "가")} 적립되었습니다.`,
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
      title={request ? `${KIND_LABEL[kind]} 신청서 수정` : `새 ${KIND_LABEL[kind]} 신청서`}
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
        {!request && (
          <Callout tone="info">저장하면 바로 요원마다 고른 휴가 종류로 적립됩니다. (부여일 = 지급일자)</Callout>
        )}

        <div className="form-grid">
          <FieldGroup label="지급일자" required hint="휴가명의 (월 일)에 들어가고, 적립 부여일이 됩니다.">
            <DateInput value={paidOn} onChange={changePaidOn} ariaLabel="지급일자" invalid={showErrors && !paidOn} />
          </FieldGroup>
          {!isAward && (
            <FieldGroup label="상세내용" required>
              <CategoryRadios options={["official_event", "special_leave"] as const} value={category} onChange={setCategory} />
            </FieldGroup>
          )}
        </div>

        <FieldGroup
          label="대상 요원"
          required
          hint={
            isAward
              ? "요원마다 적립할 휴가 종류를 고르고, 발생 일수를 고칠 수 있습니다."
              : "요원마다 적립할 휴가 종류를 고르고, 발생 일수와 발생 월을 고칠 수 있습니다."
          }
        >
          {employees.isPending ? (
            <Spinner />
          ) : agents.length === 0 ? (
            <EmptyState title="사회복무요원 특별휴가 대상 구분인 직원이 없습니다.">
              <Link to="/admin/settings">
                관리 &gt; 설정의 구분에서 &apos;사회복무요원 특별휴가 대상&apos;을 켜고, 직원에게 그 구분을 정하세요.
              </Link>
            </EmptyState>
          ) : (
            <div className="ot-agent-list">
              {agents.map((e) => {
                const t = targets[e.id];
                return (
                  <div key={e.id} className={["ot-agent", t && "checked"].filter(Boolean).join(" ")}>
                    <label className="ot-agent-name">
                      <input type="checkbox" checked={!!t} onChange={(ev) => toggle(e.id, ev.target.checked)} />
                      <ColorDot color={e.color} />
                      <span>{e.name}</span>
                      {!e.active && <span className="faint">(비활성)</span>}
                    </label>
                    {t && (
                      <div className="ot-agent-inputs">
                        <AccrualTypeSelect
                          name={e.name}
                          options={accrual.optionsFor(e, request?.targets.find((x) => x.employeeId === e.id)?.leaveTypeId)}
                          value={t.leaveTypeId}
                          onChange={(id) => patch(e.id, { leaveTypeId: id })}
                          invalid={showErrors && t.leaveTypeId === null}
                        />
                        <TextInput
                          type="number"
                          min={1}
                          max={31}
                          step={1}
                          value={Number.isNaN(t.days) ? "" : t.days}
                          aria-label={`${e.name} 발생 일수`}
                          aria-invalid={showErrors && !validDays(t.days) ? true : undefined}
                          className="ot-days"
                          onChange={(ev) => patch(e.id, { days: ev.target.value === "" ? Number.NaN : Number(ev.target.value) })}
                        />
                        <span className="muted">일</span>
                        {!isAward && (
                          <>
                            <Select
                              value={t.month}
                              aria-label={`${e.name} 발생 월`}
                              className="ot-month"
                              onChange={(ev) => patch(e.id, { month: Number(ev.target.value), monthAuto: false })}
                            >
                              {MONTHS.map((m) => (
                                <option key={m} value={m}>
                                  {m}월
                                </option>
                              ))}
                            </Select>
                            <span className="muted">발생</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </FieldGroup>

        <FieldGroup
          label={
            <span className="ot-details-label">
              근무내역
              {customDetails !== null && (
                <Button size="sm" variant="ghost" onClick={() => setCustomDetails(null)}>
                  기본 문구로 되돌리기
                </Button>
              )}
            </span>
          }
          hint={
            customDetails !== null
              ? "직접 고친 문구입니다. 대상이나 상세내용을 바꿔도 자동으로 고쳐지지 않습니다."
              : isAward
                ? "기본 문구가 자동으로 들어가고, 대상·일수를 바꾸면 함께 고쳐집니다. 직접 고칠 수도 있습니다."
                : category === "special_leave"
                  ? "특별휴가는 기본 문구가 자동으로 들어가고, 대상·일수·월을 바꾸면 함께 고쳐집니다. 직접 고칠 수도 있습니다."
                  : "공식행사는 기본 문구 없이 비워 둡니다. 필요한 내용을 직접 적으세요."
          }
        >
          <Textarea
            rows={7}
            maxLength={3000}
            aria-label="근무내역"
            value={workDetails}
            onChange={(e) => setCustomDetails(e.target.value === autoDetails ? null : e.target.value)}
          />
        </FieldGroup>

        {showErrors && error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  );
}
