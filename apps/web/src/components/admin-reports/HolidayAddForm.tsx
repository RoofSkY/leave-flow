import { useState, type FormEvent } from "react";
import { holidayInput, type HolidayInput, type HolidayKind } from "@leave-flow/shared";
import { DateInput } from "../form/index.tsx";
import { Button, Field, Select, TextInput } from "../ui/index.tsx";
import "./admin-reports.css";

type FieldName = "date" | "name";

/** 공휴일·휴무일 추가 폼. 입력 검사를 통과하면 onSubmit, 성공하면 이름·날짜를 비움 */
export function HolidayAddForm({
  onSubmit,
  pending,
}: {
  onSubmit: (input: HolidayInput) => Promise<boolean>;
  pending: boolean;
}) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<HolidayKind>("center");
  const [error, setError] = useState<{ field: FieldName; message: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!date) return setError({ field: "date", message: "날짜를 고르세요." });
    const parsed = holidayInput.safeParse({ date, name, kind });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError({ field: issue?.path[0] === "date" ? "date" : "name", message: issue?.message ?? "입력값을 확인하세요." });
    }
    setError(null);
    if (await onSubmit(parsed.data)) {
      setDate("");
      setName("");
    }
  };

  return (
    <form className="card holiday-form" onSubmit={submit} noValidate>
      <div className="section-title">공휴일·휴무일 추가</div>
      <div className="holiday-form-fields">
        <Field label="날짜" required error={error?.field === "date" ? error.message : undefined}>
          <DateInput value={date} onChange={setDate} invalid={error?.field === "date"} ariaLabel="날짜" />
        </Field>
        <Field label="이름" required error={error?.field === "name" ? error.message : undefined}>
          <TextInput
            value={name}
            maxLength={50}
            placeholder="예: 체육대회, 선거일"
            aria-invalid={error?.field === "name" || undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="구분">
          <Select value={kind} onChange={(e) => setKind(e.target.value as HolidayKind)}>
            <option value="center">센터 휴무일</option>
            <option value="public">법정·임시공휴일</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={pending} className="holiday-form-submit">
          {pending ? "추가하는 중…" : "추가"}
        </Button>
      </div>
    </form>
  );
}
