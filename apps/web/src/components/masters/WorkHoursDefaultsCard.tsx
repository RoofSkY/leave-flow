import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dailyWorkMinutes, settingsInput, type Settings } from "@leave-flow/shared";
import { TimeSelect, allDayTimes } from "../form/index.tsx";
import { Button, Field, useToast } from "../ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { formatHoursKo } from "../../lib/format.ts";
import { qk } from "../../lib/queries.ts";

const TIMES = allDayTimes();

/** 설정: 직원을 새로 추가할 때 채워 둘 근무 시작·종료 시각 */
export function WorkHoursDefaultsCard({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(null);
  const start = draft?.start ?? settings.defaultWorkStart;
  const end = draft?.end ?? settings.defaultWorkEnd;
  const dirty = !!draft && (draft.start !== settings.defaultWorkStart || draft.end !== settings.defaultWorkEnd);

  const check = settingsInput.safeParse({ defaultWorkStart: start, defaultWorkEnd: end });
  const error = check.success ? null : (check.error.issues[0]?.message ?? "근무시간이 올바르지 않습니다.");

  const save = useMutation({
    mutationFn: () => api.put<Settings>("/api/settings", { defaultWorkStart: start, defaultWorkEnd: end }),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings(), s);
      setDraft(null);
      toast("근무시간 기본값을 저장했습니다.");
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  return (
    <section className="card">
      <h2 className="section-title">근무시간 기본값</h2>
      <p className="settings-item-desc">
        직원을 새로 추가할 때 근무 시작·종료 칸에 미리 채워지는 시각입니다. 이미 등록된 직원의 근무시간은 바뀌지 않습니다.
      </p>
      <div className="row wrap" style={{ alignItems: "flex-start", gap: 12 }}>
        <Field label="근무 시작" className="settings-time-field">
          <TimeSelect
            value={start}
            options={TIMES}
            ariaLabel="근무 시작 기본값"
            onChange={(v) => setDraft({ start: v, end })}
          />
        </Field>
        <Field label="근무 종료" className="settings-time-field" error={error}>
          <TimeSelect
            value={end}
            options={TIMES}
            invalid={!!error}
            ariaLabel="근무 종료 기본값"
            onChange={(v) => setDraft({ start, end: v })}
          />
        </Field>
      </div>
      {!error && (
        <p className="field-hint">
          하루 {formatHoursKo(dailyWorkMinutes({ workStart: start, workEnd: end }))} 근무 (점심 12:00~13:00 제외)
        </p>
      )}
      <div className="settings-actions">
        <Button disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
          되돌리기
        </Button>
        <Button variant="primary" disabled={!dirty || !!error || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </section>
  );
}
