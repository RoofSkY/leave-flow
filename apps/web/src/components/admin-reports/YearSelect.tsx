import { currentYear } from "../../lib/format.ts";
import { Button, Select } from "../ui/index.tsx";
import "./admin-reports.css";

/** 연도 고르기: [‹] [2026년] [›] */
export function YearSelect({ value, onChange }: { value: number; onChange: (year: number) => void }) {
  const now = currentYear();
  const first = Math.min(now - 5, value);
  const last = Math.max(now + 3, value);
  const years: number[] = [];
  for (let y = last; y >= first; y--) years.push(y);
  return (
    <div className="year-select" role="group" aria-label="연도">
      <Button size="sm" variant="ghost" icon title="이전 연도" aria-label="이전 연도" onClick={() => onChange(value - 1)}>
        ‹
      </Button>
      <Select value={value} aria-label="연도 선택" onChange={(e) => onChange(Number(e.target.value))}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}년
          </option>
        ))}
      </Select>
      <Button size="sm" variant="ghost" icon title="다음 연도" aria-label="다음 연도" onClick={() => onChange(value + 1)}>
        ›
      </Button>
    </div>
  );
}
