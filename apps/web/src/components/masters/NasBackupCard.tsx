import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nasBackupDirInput, type SystemInfo } from "@leave-flow/shared";
import { Button, ErrorText, Field, Spinner, TextInput, useToast } from "../ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { qk } from "../../lib/queries.ts";

/** 설정: 백업을 함께 복사할 NAS 공유폴더 (config.json 의 nasBackupDir) */
export function NasBackupCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const system = useQuery({ queryKey: qk.system(), queryFn: () => api.get<SystemInfo>("/api/system/info") });
  const [draft, setDraft] = useState<string | null>(null);
  const saved = system.data?.nasBackupDir ?? "";
  const value = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved;

  const check = nasBackupDirInput.safeParse({ nasBackupDir: value });
  const error = check.success ? null : (check.error.issues[0]?.message ?? "NAS 백업 폴더가 올바르지 않습니다.");

  const save = useMutation({
    mutationFn: (dir: string) => api.put<{ nasBackupDir: string | null }>("/api/system/nas-backup-dir", { nasBackupDir: dir }),
    onSuccess: async (r) => {
      setDraft(null);
      await qc.invalidateQueries({ queryKey: qk.system() });
      toast(r.nasBackupDir ? "NAS 백업 폴더를 저장했습니다. 다음 백업부터 NAS에도 복사합니다." : "NAS 백업을 껐습니다.");
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  return (
    <section className="card">
      <h2 className="section-title">NAS 백업 폴더</h2>
      <p className="settings-item-desc">
        매일 자동 백업과 지금 백업 파일을 이 공유폴더에도 복사합니다. 저장할 때 그 폴더에 실제로 써 보고, 쓸 수 없으면
        저장하지 않습니다. 비워 두고 저장하면 NAS 백업을 끕니다.
      </p>
      {system.isPending ? (
        <Spinner />
      ) : system.error ? (
        <ErrorText error={system.error} />
      ) : (
        <>
          <Field
            label="공유폴더 주소"
            error={error}
            hint="출결 PC에 로그인한 Windows 계정으로 NAS에 접근합니다. 저장이 실패하면 그 계정으로 탐색기에서 NAS 폴더가 열리는지 확인하세요. (운영가이드 「NAS 백업 설정과 계정」 참고)"
          >
            <TextInput
              value={value}
              placeholder="\\NAS주소\backup\leave-flow"
              aria-invalid={!!error}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <div className="settings-actions">
            <Button disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
              되돌리기
            </Button>
            <Button variant="primary" disabled={!dirty || !!error || save.isPending} onClick={() => save.mutate(value)}>
              {save.isPending ? "폴더 확인 중…" : "저장"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
