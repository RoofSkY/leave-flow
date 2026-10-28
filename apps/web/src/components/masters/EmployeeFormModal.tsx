import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_APPROVAL_ROLES,
  dailyWorkMinutes,
  employeeInput,
  isTimeString,
  parseTime,
  quickRangeTimes,
  type Employee,
  type EmployeeInput,
} from "@leave-flow/shared";
import { api, errorMessage } from "../../lib/api.ts";
import { formatHoursKo } from "../../lib/format.ts";
import { invalidateLeaveData, useCategories, useDepartments, useSettings } from "../../lib/queries.ts";
import { PhoneInput, TimeSelect, allDayTimes } from "../form/index.tsx";
import { Button, Callout, Field, Modal, Select, TextInput, useToast } from "../ui/index.tsx";
import { apiFieldErrors, checkInput, type FieldErrors } from "./formErrors.ts";
import { ApprovalRoleChips, ColorPicker, FieldGroup, WeekdayChips, pickUnusedColor } from "./inputs.tsx";

const TIMES = allDayTimes();

/** 설정을 불러오기 전 근무시간 기본값 (서버 기본값과 같음) */
const FALLBACK_WORK = { start: "09:00", end: "18:00" };

function initialForm(
  employee: Employee | null,
  usedColors: readonly string[],
  work: { start: string; end: string },
): EmployeeInput {
  if (employee) {
    const { name, department, color, workDays, workStart, workEnd, emergencyContact, approvalRoles, category } = employee;
    return { name, department, color, workDays, workStart, workEnd, emergencyContact, approvalRoles, category };
  }
  return {
    name: "",
    department: "",
    color: pickUnusedColor(usedColors),
    workDays: [1, 2, 3, 4, 5],
    workStart: work.start,
    workEnd: work.end,
    emergencyContact: "",
    approvalRoles: DEFAULT_APPROVAL_ROLES,
    category: "",
  };
}

/** 하루 근무시간·반차 기준 안내 */
function scheduleHint(f: EmployeeInput): string | null {
  if (!isTimeString(f.workStart) || !isTimeString(f.workEnd) || parseTime(f.workEnd) <= parseTime(f.workStart)) {
    return null;
  }
  const daily = dailyWorkMinutes(f);
  if (daily <= 0) return null;
  return `하루 ${formatHoursKo(daily)} (점심 12:00~13:00 제외) · 반차 기준 ${quickRangeTimes(f, "am").end}`;
}

/** 직원 추가·수정. employee = null 이면 새로 추가 */
export function EmployeeFormModal({
  employee,
  usedColors,
  onClose,
}: {
  employee: Employee | null;
  /** 다른 활성 직원들이 쓰는 색 */
  usedColors: readonly string[];
  onClose: () => void;
}) {
  const formId = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const departments = useDepartments();
  const categories = useCategories();
  const defaults = settings.data
    ? { start: settings.data.defaultWorkStart, end: settings.data.defaultWorkEnd }
    : FALLBACK_WORK;
  const [form, setForm] = useState<EmployeeInput>(() => initialForm(employee, usedColors, defaults));
  const [errors, setErrors] = useState<FieldErrors>({});
  /** 근무시간을 직접 고쳤는지 (안 고쳤으면 설정의 기본값이 늦게 불러와져도 반영) */
  const workTouched = useRef(false);
  const set = <K extends keyof EmployeeInput>(key: K, value: EmployeeInput[K]) => {
    if (key === "workStart" || key === "workEnd") workTouched.current = true;
    setForm((f) => ({ ...f, [key]: value }));
  };

  useEffect(() => {
    if (employee || workTouched.current || !settings.data) return;
    const { defaultWorkStart, defaultWorkEnd } = settings.data;
    setForm((f) => ({ ...f, workStart: defaultWorkStart, workEnd: defaultWorkEnd }));
  }, [employee, settings.data]);

  // 소속 선택지: 소속 목록 + (목록에 없는 기존 소속이면 그것도)
  const deptNames = (departments.data ?? []).map((d) => d.name);
  const deptOptions = form.department && !deptNames.includes(form.department) ? [...deptNames, form.department] : deptNames;
  // 구분 선택지도 같은 방식
  const categoryList = categories.data ?? [];
  const categoryNames = categoryList.map((c) => c.name);
  const categoryOptions =
    form.category && !categoryNames.includes(form.category) ? [...categoryNames, form.category] : categoryNames;
  const isAgentCategory = categoryList.some((c) => c.name === form.category && c.socialServiceAgent);

  const save = useMutation({
    mutationFn: (input: EmployeeInput) =>
      employee ? api.put<Employee>(`/api/employees/${employee.id}`, input) : api.post<Employee>("/api/employees", input),
    onSuccess: async (saved) => {
      toast(employee ? `${saved.name} 직원 정보를 저장했습니다.` : `${saved.name} 직원을 추가했습니다.`);
      onClose();
      await Promise.all([qc.invalidateQueries({ queryKey: ["employees"] }), invalidateLeaveData(qc)]);
    },
    onError: (err) => {
      setErrors(apiFieldErrors(err));
      toast(errorMessage(err), "error");
    },
  });

  const submit = () => {
    const r = checkInput(employeeInput, form);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    save.mutate(r.data);
  };

  const hint = scheduleHint(form);

  return (
    <Modal
      open
      title={employee ? "직원 정보 수정" : "직원 추가"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" type="submit" form={formId} disabled={save.isPending}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="form-grid">
          <Field label="성명" required error={errors.name}>
            <TextInput
              value={form.name}
              maxLength={50}
              autoFocus
              aria-invalid={!!errors.name || undefined}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field
            label="소속"
            error={errors.department}
            hint={
              departments.data && deptNames.length === 0 ? (
                <>
                  등록된 소속이 없습니다. <Link to="/admin/settings">관리 &gt; 설정</Link>에서 추가하세요.
                </>
              ) : undefined
            }
          >
            <Select
              value={form.department}
              aria-invalid={!!errors.department || undefined}
              onChange={(e) => set("department", e.target.value)}
            >
              <option value="">소속 없음</option>
              {deptOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {deptNames.includes(name) ? "" : " (목록에 없음)"}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <FieldGroup label="색상" hint="달력에서 이 직원의 휴가를 이 색으로 표시합니다." error={errors.color}>
          <ColorPicker value={form.color} onChange={(c) => set("color", c)} usedColors={usedColors} />
        </FieldGroup>

        <FieldGroup label="근무 요일" required error={errors.workDays}>
          <WeekdayChips value={form.workDays} onChange={(d) => set("workDays", d)} />
        </FieldGroup>

        <div className="form-grid">
          <Field label="근무 시작" required error={errors.workStart}>
            <TimeSelect
              value={form.workStart}
              options={TIMES}
              invalid={!!errors.workStart}
              onChange={(v) => set("workStart", v)}
            />
          </Field>
          <Field label="근무 종료" required error={errors.workEnd}>
            <TimeSelect
              value={form.workEnd}
              options={TIMES}
              invalid={!!errors.workEnd}
              onChange={(v) => set("workEnd", v)}
            />
          </Field>
        </div>
        {hint && <span className="field-hint">{hint}</span>}

        <Field label="비상연락처" hint="휴가원 작성 시 기본값으로 들어갑니다." error={errors.emergencyContact}>
          <PhoneInput
            value={form.emergencyContact}
            invalid={!!errors.emergencyContact}
            onChange={(v) => set("emergencyContact", v)}
          />
        </Field>

        <FieldGroup label="결재칸" required hint="휴가원 결재란에 고른 칸이 나옵니다." error={errors.approvalRoles}>
          <ApprovalRoleChips value={form.approvalRoles} onChange={(r) => set("approvalRoles", r)} />
        </FieldGroup>

        <Field
          label="구분"
          error={errors.category}
          hint={
            categories.data && categoryNames.length === 0 ? (
              <>
                등록된 구분이 없습니다. <Link to="/admin/settings">관리 &gt; 설정</Link>에서 추가하세요.
              </>
            ) : isAgentCategory ? (
              "사회복무요원 특별휴가 신청서의 대상자 목록에 나옵니다."
            ) : undefined
          }
        >
          <Select
            value={form.category}
            aria-invalid={!!errors.category || undefined}
            onChange={(e) => set("category", e.target.value)}
          >
            <option value="">구분 없음</option>
            {categoryOptions.map((name) => (
              <option key={name} value={name}>
                {name}
                {categoryNames.includes(name) ? "" : " (목록에 없음)"}
              </option>
            ))}
          </Select>
        </Field>

        {employee && (
          <Callout>근무 요일·근무시간을 바꿔도 이미 신청한 휴가원은 신청할 때의 값으로 유지됩니다.</Callout>
        )}
      </form>
    </Modal>
  );
}
