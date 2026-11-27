import type { Employee } from "@leave-flow/shared";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, ErrorText, Spinner } from "../ui/index.tsx";
import { useCategories, useDepartments, useEmployees } from "../../lib/queries.ts";
import { CalendarXIcon, ChevronIcon, EyeIcon } from "../ui/icons.tsx";
import { tint } from "./leaveQueries.ts";

/**
 * 달력 필터 (왼쪽 패널): 끈 소속·구분·직원. 처음엔 모두 켬.
 * 직원 자신·소속·구분 중 하나라도 끄면 그 직원 휴가를 숨김. 소속·구분은 직원의 지금 값.
 */
export interface CalendarHidden {
  departments: string[];
  categories: string[];
  employeeIds: number[];
}

export const NOTHING_HIDDEN: CalendarHidden = { departments: [], categories: [], employeeIds: [] };

export const isShown = (h: CalendarHidden, e: Pick<Employee, "id" | "department" | "category">) =>
  !h.employeeIds.includes(e.id) && !h.departments.includes(e.department) && !h.categories.includes(e.category);

/** 필터에서 이름을 누른 항목 (왼쪽 패널 옆에 그 휴가원 목록) */
export type FilterItem =
  | { kind: "department"; name: string }
  | { kind: "category"; name: string }
  | { kind: "employee"; id: number; name: string; color: string }
  | { kind: "cancelled" };

const itemKey = (i: FilterItem) =>
  i.kind === "employee" ? `employee:${i.id}` : i.kind === "cancelled" ? "cancelled" : `${i.kind}:${i.name}`;

const sameItem = (a: FilterItem | null, b: FilterItem) => a !== null && itemKey(a) === itemKey(b);

const flip = <T,>(hidden: readonly T[], value: T, shown: boolean) =>
  shown ? hidden.filter((v) => v !== value) : [...hidden, value];

/** 소속·구분·취소된 휴가처럼 색이 없는 줄 (옅은 색은 직원 줄 tint(색, 0.3) 과 같은 진하기) */
const PLAIN = { color: "var(--accent)", soft: "color-mix(in srgb, var(--accent) 30%, transparent)" };

/**
 * 한 줄: 켜면 진한 색 네모, 끄면 옅은 네모 + 흐린 글씨 + 눈 빗금.
 * 네모·눈은 보이기/숨기기, 이름은 휴가원 목록 열기. 눈은 끈 줄·마우스를 올린 줄·목록을 연 줄에만
 */
function FilterRow({
  name,
  extra,
  shown,
  onShownChange,
  color,
  soft,
  muted,
  open,
  onOpen,
  icon,
}: {
  name: string;
  /** 이름 뒤에 덧붙임 (비활성 등) */
  extra?: ReactNode;
  shown: boolean;
  onShownChange: (shown: boolean) => void;
  color: string;
  soft: string;
  /** 자신은 켰지만 소속·구분을 꺼서 보이지 않음 */
  muted?: boolean;
  open: boolean;
  onOpen: () => void;
  /** 색 네모 대신 보여 줄 아이콘 (켜면 진하게, 끄면 흐리게) */
  icon?: ReactNode;
}) {
  const check = (
    <input
      type="checkbox"
      className="cal-filter-check"
      checked={shown}
      onChange={(e) => onShownChange(e.target.checked)}
      aria-label={`${name} 보이기`}
    />
  );
  return (
    <div
      className={["cal-filter-row", !shown && "is-off", muted && "is-muted", open && "is-open"].filter(Boolean).join(" ")}
      style={{ "--c": color, "--c-soft": soft } as CSSProperties}
      title={muted ? "소속이나 구분을 꺼서 보이지 않음" : undefined}
    >
      {icon ? (
        <label className="cal-filter-icon">
          {check}
          {icon}
        </label>
      ) : (
        check
      )}
      <button type="button" className="cal-filter-name" aria-pressed={open} onClick={onOpen}>
        {name}
        {extra}
      </button>
      {/* 네모와 같은 동작이라 키보드·화면 읽기에서는 네모만 */}
      <button
        type="button"
        className="cal-filter-eye"
        tabIndex={-1}
        aria-hidden
        title={shown ? "숨기기" : "보이기"}
        onClick={() => onShownChange(!shown)}
      >
        <EyeIcon off={!shown} />
      </button>
    </div>
  );
}

/** 소속·구분·직원 묶음. 제목에 마우스를 올리면 앞에 접기 화살표 (접힌 동안은 늘 보임) */
function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={["cal-filter-group", collapsed && "is-collapsed"].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="cal-filter-title"
        aria-expanded={!collapsed}
        title={collapsed ? "펼치기" : "접기"}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="cal-filter-fold">
          <ChevronIcon dir={collapsed ? "right" : "down"} size={12} />
        </span>
        <span className="field-label">{title}</span>
      </button>
      {!collapsed && (children.length ? children : <span className="field-hint">{empty}</span>)}
    </div>
  );
}

export function CalendarFilterPanel({
  hidden,
  onChange,
  showCancelled,
  onShowCancelledChange,
  openItem,
  onOpenItem,
}: {
  hidden: CalendarHidden;
  onChange: (hidden: CalendarHidden) => void;
  showCancelled: boolean;
  onShowCancelledChange: (show: boolean) => void;
  /** 휴가원 목록을 연 항목 */
  openItem: FilterItem | null;
  /** 이름을 누름 (이미 연 항목이면 null 로 닫음) */
  onOpenItem: (item: FilterItem | null) => void;
}) {
  const departmentsQ = useDepartments();
  const categoriesQ = useCategories();
  // 지난 기록도 거를 수 있게 비활성 직원까지 (영구 삭제된 직원은 고를 수 없음)
  const employeesQ = useEmployees(true);
  const error = departmentsQ.error ?? categoriesQ.error ?? employeesQ.error;
  const pending = departmentsQ.isPending || categoriesQ.isPending || employeesQ.isPending;
  const anyHidden = hidden.departments.length + hidden.categories.length + hidden.employeeIds.length > 0;
  const openProps = (item: FilterItem) => {
    const open = sameItem(openItem, item);
    return { open, onOpen: () => onOpenItem(open ? null : item) };
  };

  return (
    <section className="cal-filter" aria-label="필터">
      <div className="cal-filter-head">
        <h2 className="lf-side-title">필터</h2>
        <span className="spacer" />
        <Button size="sm" variant="ghost" disabled={!anyHidden} onClick={() => onChange(NOTHING_HIDDEN)}>
          모두 보이기
        </Button>
      </div>
      {error ? (
        <ErrorText error={error} />
      ) : pending ? (
        <Spinner />
      ) : (
        <>
          <Group title="소속" empty="등록된 소속이 없습니다.">
            {(departmentsQ.data ?? []).map(({ name }) => (
              <FilterRow
                key={name}
                name={name}
                {...PLAIN}
                {...openProps({ kind: "department", name })}
                shown={!hidden.departments.includes(name)}
                onShownChange={(shown) => onChange({ ...hidden, departments: flip(hidden.departments, name, shown) })}
              />
            ))}
          </Group>
          <Group title="구분" empty="등록된 구분이 없습니다.">
            {(categoriesQ.data ?? []).map(({ name }) => (
              <FilterRow
                key={name}
                name={name}
                {...PLAIN}
                {...openProps({ kind: "category", name })}
                shown={!hidden.categories.includes(name)}
                onShownChange={(shown) => onChange({ ...hidden, categories: flip(hidden.categories, name, shown) })}
              />
            ))}
          </Group>
          <Group title="직원" empty="등록된 직원이 없습니다.">
            {(employeesQ.data ?? []).map((e) => {
              const shown = !hidden.employeeIds.includes(e.id);
              return (
                <FilterRow
                  key={e.id}
                  name={e.name}
                  extra={!e.active && <span className="faint"> 비활성</span>}
                  color={e.color}
                  soft={tint(e.color, 0.3)}
                  {...openProps({ kind: "employee", id: e.id, name: e.name, color: e.color })}
                  shown={shown}
                  muted={shown && !isShown(hidden, e)}
                  onShownChange={(next) => onChange({ ...hidden, employeeIds: flip(hidden.employeeIds, e.id, next) })}
                />
              );
            })}
          </Group>
        </>
      )}
      <div className="cal-filter-group">
        <FilterRow
          name="취소된 휴가"
          {...PLAIN}
          icon={<CalendarXIcon />}
          {...openProps({ kind: "cancelled" })}
          shown={showCancelled}
          onShownChange={onShowCancelledChange}
        />
      </div>
    </section>
  );
}
