import { leaveTypeAppliesTo, type Employee, type LeaveTypeTarget } from "@leave-flow/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Checkbox, ColorDot, ErrorText, Spinner } from "../ui/index.tsx";
import { useCategories, useDepartments, useEmployees } from "../../lib/queries.ts";
import "./form.css";

/**
 * 직원 필터 (달력·휴가원 목록·잔여 현황·시간외근무). 휴가 종류 적용 대상과 같은 방식:
 * 소속·구분은 고른 칸끼리 모두 맞아야(칸 안에서는 하나만), 따로 고른 직원은 조건과 관계없이 더함.
 * 아무것도 고르지 않으면 모두 보임. 소속·구분은 기록 당시가 아니라 직원의 지금 값.
 */
export type EmployeeFilterValue = LeaveTypeTarget;

export const NO_FILTER: EmployeeFilterValue = { departments: [], categories: [], employeeIds: [] };

const countOf = (f: EmployeeFilterValue) => f.departments.length + f.categories.length + f.employeeIds.length;

export function filterMatches(
  f: EmployeeFilterValue,
  employee: Pick<Employee, "id" | "department" | "category">,
): boolean {
  return countOf(f) === 0 || leaveTypeAppliesTo({ target: f }, employee);
}

/** 직원 번호로 거르기 (영구 삭제된 직원은 남은 소속·구분으로). 직원 정보를 불러오기 전에는 따로 고른 직원만 */
export function useEmployeeFilterMatch(f: EmployeeFilterValue): (employeeId: number) => boolean {
  const { data } = useEmployees(true, true);
  const byId = useMemo(() => new Map((data ?? []).map((e) => [e.id, e])), [data]);
  return (id) => {
    const e = byId.get(id);
    return e ? filterMatches(f, e) : countOf(f) === 0 || f.employeeIds.includes(id);
  };
}

/** 주소 쿼리(?dept=&cat=&emp=, 여러 번)에 담은 필터. 출력 화면에 갔다 돌아와도 유지되게 */
export function filterFromParams(params: URLSearchParams): EmployeeFilterValue {
  return {
    departments: params.getAll("dept"),
    categories: params.getAll("cat"),
    employeeIds: params
      .getAll("emp")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  };
}

export function withFilterParams(params: URLSearchParams, f: EmployeeFilterValue): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ["dept", "cat", "emp"]) next.delete(key);
  for (const d of f.departments) next.append("dept", d);
  for (const c of f.categories) next.append("cat", c);
  for (const id of f.employeeIds) next.append("emp", String(id));
  return next;
}

const toggle = <T,>(list: readonly T[], value: T, on: boolean) =>
  on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);

function FilterGroup({ label, empty, children }: { label: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="emp-filter-group">
      <span className="field-label">{label}</span>
      {children.length ? <div className="emp-filter-checks">{children}</div> : <span className="field-hint">{empty}</span>}
    </div>
  );
}

const POP_WIDTH = 380;
const POP_GAP = 4;
const VIEW_MARGIN = 16;

/** 필터 버튼 + 고르는 창 (버튼 아래, 화면 밖으로 넘치지 않게 위치를 맞춤) */
export function EmployeeFilter({
  value,
  onChange,
  hint,
}: {
  value: EmployeeFilterValue;
  onChange: (value: EmployeeFilterValue) => void;
  /** 화면마다 덧붙일 설명 (예: 신청서는 대상자 중 한 명이라도 맞으면) */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const departmentsQ = useDepartments();
  const categoriesQ = useCategories();
  // 지난 기록도 거를 수 있게 비활성 직원까지 (영구 삭제된 직원은 고를 수 없음)
  const employeesQ = useEmployees(true);
  const count = countOf(value);

  const place = () => {
    const r = wrapRef.current?.querySelector("button")?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(POP_WIDTH, window.innerWidth - VIEW_MARGIN * 2);
    const left = Math.max(VIEW_MARGIN, Math.min(r.left, window.innerWidth - VIEW_MARGIN - width));
    const top = r.bottom + POP_GAP;
    setPos({ left, top, width, maxHeight: Math.max(200, window.innerHeight - top - VIEW_MARGIN) });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      wrapRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // 소속·구분은 목록 순서로
  const departmentNames = (departmentsQ.data ?? []).map((d) => d.name);
  const categoryNames = (categoriesQ.data ?? []).map((c) => c.name);
  const error = departmentsQ.error ?? categoriesQ.error ?? employeesQ.error;
  const pending = departmentsQ.isPending || categoriesQ.isPending || employeesQ.isPending;

  return (
    <div ref={wrapRef}>
      <Button
        className={count > 0 ? "emp-filter-on" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        필터
        {count > 0 && <span className="emp-filter-count">{count}</span>}
      </Button>
      {open && (
        <div className="emp-filter-pop" role="dialog" aria-label="직원 필터" style={pos ?? { visibility: "hidden" }}>
          <div className="emp-filter-head">
            <strong>필터</strong>
            <span className="spacer" />
            <Button size="sm" variant="ghost" disabled={count === 0} onClick={() => onChange(NO_FILTER)}>
              모두 해제
            </Button>
          </div>
          {error ? (
            <ErrorText error={error} />
          ) : pending ? (
            <Spinner />
          ) : (
            <>
              <FilterGroup label="소속" empty="등록된 소속이 없습니다.">
                {departmentNames.map((name) => (
                  <Checkbox
                    key={name}
                    label={name}
                    checked={value.departments.includes(name)}
                    onChange={(on) =>
                      onChange({
                        ...value,
                        departments: departmentNames.filter((n) => toggle(value.departments, name, on).includes(n)),
                      })
                    }
                  />
                ))}
              </FilterGroup>
              <FilterGroup label="구분" empty="등록된 구분이 없습니다.">
                {categoryNames.map((name) => (
                  <Checkbox
                    key={name}
                    label={name}
                    checked={value.categories.includes(name)}
                    onChange={(on) =>
                      onChange({
                        ...value,
                        categories: categoryNames.filter((n) => toggle(value.categories, name, on).includes(n)),
                      })
                    }
                  />
                ))}
              </FilterGroup>
              <FilterGroup label="직원 (따로 추가)" empty="등록된 직원이 없습니다.">
                {(employeesQ.data ?? []).map((e) => (
                  <Checkbox
                    key={e.id}
                    label={
                      <span className="emp-filter-emp">
                        <ColorDot color={e.color} />
                        {e.name}
                        {!e.active && <span className="faint">비활성</span>}
                      </span>
                    }
                    checked={value.employeeIds.includes(e.id)}
                    onChange={(on) => onChange({ ...value, employeeIds: toggle(value.employeeIds, e.id, on) })}
                  />
                ))}
              </FilterGroup>
              <p className="emp-filter-hint">
                소속과 구분을 함께 고르면 둘 다 맞는 직원만 보입니다. 한 칸에서 여러 개를 고르면 그중 하나만 맞으면 되고,
                따로 고른 직원은 조건과 관계없이 더해집니다. 소속·구분은 직원의 지금 값 기준입니다.
                {hint && ` ${hint}`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
