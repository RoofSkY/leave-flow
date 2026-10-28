import type { Employee } from "@leave-flow/shared";
import { useState } from "react";
import { Button, ColorDot, TextInput } from "../ui/index.tsx";
import "./form.css";

/**
 * 직원 여러 명 고르기: 이름·소속 검색, 소속별로 한 번에 고르기, 보이는 직원 모두 고르기.
 * selected 는 고른 순서대로 유지.
 */
export function EmployeeMultiSelect({
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
  const departments = [...new Set(employees.map((e) => e.department).filter(Boolean))];
  const selectedSet = new Set(selected);

  const add = (ids: number[]) => onChange([...selected, ...ids.filter((id) => !selectedSet.has(id))]);
  const remove = (ids: number[]) => onChange(selected.filter((id) => !ids.includes(id)));
  const allShownSelected = shown.length > 0 && shown.every((e) => selectedSet.has(e.id));

  return (
    <div className="emp-multi" aria-invalid={invalid || undefined}>
      <div className="emp-multi-tools">
        <TextInput
          type="search"
          placeholder="이름·소속 검색"
          aria-label="직원 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          size="sm"
          disabled={shown.length === 0}
          onClick={() => (allShownSelected ? remove(shown.map((e) => e.id)) : add(shown.map((e) => e.id)))}
        >
          {allShownSelected ? "모두 해제" : keyword ? "검색된 직원 모두 선택" : "모두 선택"}
        </Button>
      </div>
      {departments.length > 1 && (
        <div className="emp-multi-depts" aria-label="소속별로 고르기">
          {departments.map((d) => {
            const ids = employees.filter((e) => e.department === d).map((e) => e.id);
            const all = ids.every((id) => selectedSet.has(id));
            return (
              <button
                key={d}
                type="button"
                className={["emp-multi-dept", all && "is-on"].filter(Boolean).join(" ")}
                aria-pressed={all}
                onClick={() => (all ? remove(ids) : add(ids))}
              >
                {d} {ids.length}명
              </button>
            );
          })}
        </div>
      )}
      <div className="emp-multi-items">
        {shown.length === 0 && <div className="emp-multi-empty muted">검색 결과가 없습니다.</div>}
        {shown.map((e) => {
          const checked = selectedSet.has(e.id);
          return (
            <label key={e.id} className={["emp-multi-item", checked && "is-checked"].filter(Boolean).join(" ")}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(ev) => (ev.target.checked ? add([e.id]) : remove([e.id]))}
              />
              <ColorDot color={e.color} />
              <span className="emp-multi-name">{e.name}</span>
              {e.department && <span className="faint">{e.department}</span>}
            </label>
          );
        })}
      </div>
      <div className="emp-multi-summary">
        {selected.length === 0 ? (
          <span className="muted">선택한 직원이 없습니다.</span>
        ) : (
          <>
            <strong>{selected.length}명 선택</strong>
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
