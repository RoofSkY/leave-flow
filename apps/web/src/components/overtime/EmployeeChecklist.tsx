import type { Employee } from "@leave-flow/shared";
import { useState } from "react";
import { Button, ColorDot, TextInput } from "../ui/index.tsx";

/**
 * 직원 여러 명 선택 (체크 목록 + 이름 검색).
 * selected 는 고른 순서대로 유지 (양식에 그 순서로 나감).
 */
export function EmployeeChecklist({
  employees,
  selected,
  onChange,
  invalid,
}: {
  employees: readonly Employee[];
  selected: readonly number[];
  onChange: (ids: number[]) => void;
  invalid?: boolean;
}) {
  const [search, setSearch] = useState("");
  const keyword = search.trim();
  const shown = keyword
    ? employees.filter((e) => e.name.includes(keyword) || e.department.includes(keyword))
    : employees;
  const toggle = (id: number, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  const nameOf = (id: number) => employees.find((e) => e.id === id)?.name ?? "";

  return (
    <div className="ot-checklist" aria-invalid={invalid || undefined}>
      {employees.length > 6 && (
        <TextInput
          type="search"
          placeholder="이름·소속 검색"
          aria-label="직원 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className="ot-checklist-items">
        {shown.length === 0 && <div className="ot-checklist-empty muted">검색 결과가 없습니다.</div>}
        {shown.map((e) => {
          const checked = selected.includes(e.id);
          return (
            <label key={e.id} className={["ot-checklist-item", checked && "checked"].filter(Boolean).join(" ")}>
              <input type="checkbox" checked={checked} onChange={(ev) => toggle(e.id, ev.target.checked)} />
              <ColorDot color={e.color} />
              <span className="ot-checklist-name">{e.name}</span>
              {e.department && <span className="faint">{e.department}</span>}
              {!e.active && <span className="faint">(비활성)</span>}
            </label>
          );
        })}
      </div>
      <div className="ot-checklist-summary">
        {selected.length === 0 ? (
          <span className="muted">선택한 직원이 없습니다.</span>
        ) : (
          <>
            <span>
              <strong>{selected.length}명</strong> <span className="muted">{selected.map(nameOf).join(", ")}</span>
            </span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              모두 해제
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
