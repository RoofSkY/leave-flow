import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupFile, SystemInfo, UpdateCheckResult } from "@leave-flow/shared";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorText,
  PageHeader,
  Spinner,
  useConfirm,
  useToast,
} from "../../components/ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { formatTimestamp } from "../../lib/format.ts";
import { qk } from "../../lib/queries.ts";
import "./SystemPage.css";

interface Restarting {
  kind: "update" | "restore";
  bootId: string;
  startedAt: number;
}

const RESTART_POLL_MS = 1_500;
const RESTART_TIMEOUT_MS = 3 * 60_000;

const REASON_LABELS: Record<string, string> = {
  daily: "자동",
  manual: "수동",
  "pre-restore": "복구 전",
  "pre-update": "업데이트 전",
  "pre-delete": "영구 삭제 전",
};

/** leave-flow-YYYYMMDD-HHMMSS-<사유>[-번호].db → 사유 이름 */
function backupReason(name: string): string {
  const reason = /^leave-flow-\d{8}-\d{6}-([a-z]+(?:-[a-z]+)*)/.exec(name)?.[1];
  return reason ? (REASON_LABELS[reason] ?? reason) : "-";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 서버 updater 와 같은 규칙 (앞의 v 무시, 시험판은 정식판보다 낮음) */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = null] = v.replace(/^v/i, "").split(/-(.*)/s);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function InfoList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="system-dl">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <span className="muted">{children}</span>;

export function SystemPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [restarting, setRestarting] = useState<Restarting | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const info = useQuery({
    queryKey: qk.system(),
    queryFn: () => api.get<SystemInfo>("/api/system/info"),
    enabled: !restarting,
  });
  const backups = useQuery({
    queryKey: qk.backups(),
    queryFn: () => api.get<BackupFile[]>("/api/backups"),
    enabled: !restarting,
  });

  const backupNow = useMutation({ mutationFn: () => api.post<BackupFile>("/api/backups") });
  const check = useMutation({ mutationFn: () => api.post<UpdateCheckResult>("/api/system/update/check") });
  const apply = useMutation({ mutationFn: () => api.post<{ message: string }>("/api/system/update/apply") });
  const restore = useMutation({
    mutationFn: (b: BackupFile) =>
      api.post<{ message: string }>("/api/backups/restore", { name: b.name, location: b.location }),
  });
  const busy = !!restarting || backupNow.isPending || check.isPending || apply.isPending || restore.isPending;

  // 서버가 다시 시작될 때까지 기다렸다가 새로고침 (업데이트면 새 버전, 되돌렸으면 이전 버전으로 뜸)
  useEffect(() => {
    if (!restarting) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const next = await api.get<SystemInfo>("/api/system/info");
        if (!stopped && next.bootId !== restarting.bootId) {
          stopped = true;
          window.location.reload();
          return;
        }
      } catch {
        // 재시작 중
      }
      if (!stopped && Date.now() - restarting.startedAt > RESTART_TIMEOUT_MS) setTimedOut(true);
    }, RESTART_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [restarting]);

  const startRestart = (kind: Restarting["kind"]) => {
    if (!info.data) return;
    setTimedOut(false);
    setRestarting({ kind, bootId: info.data.bootId, startedAt: Date.now() });
  };

  const onBackup = async () => {
    try {
      const file = await backupNow.mutateAsync();
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.backups() }),
        qc.invalidateQueries({ queryKey: qk.system() }),
        qc.invalidateQueries({ queryKey: qk.auditLogs() }),
      ]);
      const nasError = qc.getQueryData<SystemInfo>(qk.system())?.lastBackupError;
      if (nasError) toast(`로컬에 백업했지만 ${nasError}`, "warning");
      else toast(`백업했습니다. (${file.name})`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const onCheck = async () => {
    try {
      const result = await check.mutateAsync();
      toast(result.message);
      await qc.invalidateQueries({ queryKey: qk.system() });
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const onApply = async () => {
    const data = info.data;
    if (!data?.latestVersion) return;
    const ok = await confirm({
      title: "지금 업데이트",
      message:
        `${data.version} → ${data.latestVersion}\n\n` +
        "업데이트 전에 데이터를 자동으로 백업합니다.\n" +
        "서버가 잠시 재시작되어 모든 직원의 화면이 잠깐 끊깁니다. 작성 중인 내용이 있으면 먼저 저장해 주세요.\n" +
        "새 버전이 정상적으로 시작되지 않으면 이전 버전으로 자동으로 되돌립니다.",
      confirmLabel: "업데이트",
    });
    if (!ok) return;
    try {
      const result = await apply.mutateAsync();
      toast(result.message);
      startRestart("update");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const onRestore = async (b: BackupFile) => {
    const ok = await confirm({
      title: "백업으로 복구",
      message:
        `${formatTimestamp(b.modifiedAt)} 백업 (${backupReason(b.name)}, ${b.location === "nas" ? "NAS" : "로컬"})\n` +
        `${b.name}\n\n` +
        "현재 데이터는 백업한 뒤 선택한 백업으로 바뀝니다.\n" +
        "이 백업 이후에 입력하거나 고친 휴가원·시간외근무 신청서·관리 화면 내용은 모두 사라집니다.\n" +
        "복구하는 동안 서버가 재시작되어 모든 직원의 화면이 잠깐 끊깁니다.",
      confirmLabel: "복구",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await restore.mutateAsync(b);
      toast(result.message);
      startRestart("restore");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  if (info.isPending && !restarting) {
    return (
      <div>
        <PageHeader title="백업·업데이트" />
        <Spinner />
      </div>
    );
  }

  const data = info.data;
  const disabledReason = !data
    ? null
    : data.version === "dev"
      ? "개발 실행 중에는 업데이트 기능을 쓰지 않습니다."
      : !data.updateRepo
        ? "config.json 에 업데이트 저장소(updateRepo)를 설정하면 업데이트를 사용할 수 있습니다."
        : null;
  const hasNewer = !!data?.latestVersion && data.version !== "dev" && compareVersions(data.latestVersion, data.version) > 0;
  const failure =
    data?.updateFailure && data.version !== "dev" && compareVersions(data.updateFailure.version, data.version) > 0
      ? data.updateFailure
      : null;

  return (
    <div>
      <PageHeader title="백업·업데이트" description="프로그램 버전과 데이터 백업을 관리합니다." />

      {restarting && (
        <div className="system-restart">
          <Callout tone="info">
            {timedOut ? (
              <div className="stack">
                <span>
                  서버가 아직 다시 시작되지 않았습니다. 잠시 뒤 새로고침하세요. 계속 접속되지 않으면 출결 PC의
                  leave-flow 로그(설치 폴더\logs)를 확인하세요.
                </span>
                <div>
                  <Button size="sm" onClick={() => window.location.reload()}>
                    새로고침
                  </Button>
                </div>
              </div>
            ) : (
              <Spinner
                label={
                  restarting.kind === "update"
                    ? "새 버전으로 바꾸는 중입니다. 서버가 다시 시작되면 자동으로 새로고침합니다."
                    : "백업으로 복구하는 중입니다. 서버가 다시 시작되면 자동으로 새로고침합니다."
                }
              />
            )}
          </Callout>
        </div>
      )}

      <ErrorText error={info.error} />

      {data && (
        <div className="system-grid">
          <section className="card system-card" aria-labelledby="system-version">
            <h2 id="system-version" className="section-title">
              버전 정보
            </h2>
            <InfoList
              rows={[
                [
                  "현재 버전",
                  <>
                    <span className="mono">{data.version}</span>
                    {data.version === "dev" && <Badge>개발 실행</Badge>}
                  </>,
                ],
                [
                  "최신 버전",
                  data.latestVersion ? (
                    <>
                      <span className="mono">{data.latestVersion}</span>
                      {hasNewer ? <Badge tone="accent">새 버전</Badge> : <Badge tone="success">최신</Badge>}
                    </>
                  ) : (
                    <Muted>확인 전</Muted>
                  ),
                ],
                ["최근 확인", data.lastUpdateCheckAt ? formatTimestamp(data.lastUpdateCheckAt) : <Muted>-</Muted>],
                ["최근 업데이트", data.lastUpdatedAt ? formatTimestamp(data.lastUpdatedAt) : <Muted>-</Muted>],
                [
                  "업데이트 저장소",
                  data.updateRepo ? <span className="mono">{data.updateRepo}</span> : <Muted>설정 안 됨</Muted>,
                ],
                [
                  "자동 업데이트",
                  data.autoUpdate ? (
                    <Badge tone="success">켜짐</Badge>
                  ) : (
                    <Badge>꺼짐</Badge>
                  ),
                ],
              ]}
            />
            {failure && (
              <Callout tone="warning">
                {formatTimestamp(failure.at)}에 새 버전 {failure.version}이(가) 정상적으로 시작되지 않아 이전 버전으로
                되돌렸습니다. ({failure.message}) 이 버전은 자동으로 다시 설치하지 않습니다.
              </Callout>
            )}
            {disabledReason && <Callout>{disabledReason}</Callout>}
            <div className="system-actions">
              <Button onClick={onCheck} disabled={busy || !!disabledReason}>
                {check.isPending ? "확인 중…" : "업데이트 확인"}
              </Button>
              <Button variant="primary" onClick={onApply} disabled={busy || !!disabledReason || !hasNewer}>
                {apply.isPending ? "새 버전을 받는 중…" : "지금 업데이트"}
              </Button>
            </div>
          </section>

          <section className="card system-card" aria-labelledby="system-backup">
            <h2 id="system-backup" className="section-title">
              백업
            </h2>
            <InfoList
              rows={[
                ["최근 백업", data.lastBackupAt ? formatTimestamp(data.lastBackupAt) : <Muted>아직 없음</Muted>],
                ["자동 백업", `매일 ${data.backupTime}, ${data.backupKeepDays}일 보관`],
                ["로컬 폴더", <span className="system-path">{data.backupDir}</span>],
                [
                  "NAS 폴더",
                  data.nasBackupDir ? (
                    <span className="system-path">{data.nasBackupDir}</span>
                  ) : (
                    <Muted>설정 안 됨</Muted>
                  ),
                ],
              ]}
            />
            {data.lastBackupError && <Callout tone="danger">{data.lastBackupError}</Callout>}
            {!data.nasBackupDir && (
              <Callout>config.json 의 nasBackupDir 에 NAS 공유폴더를 지정하면 백업을 NAS 에도 복사합니다.</Callout>
            )}
            <div className="system-actions">
              <Button variant="primary" onClick={onBackup} disabled={busy}>
                {backupNow.isPending ? "백업하는 중…" : "지금 백업"}
              </Button>
            </div>
          </section>

          <section className="card system-card" aria-labelledby="system-excel">
            <h2 id="system-excel" className="section-title">
              엑셀 백업
            </h2>
            <p className="system-text">
              직원, 휴가 종류, 부여 내역, 휴가원, 시간외근무 신청서, 공휴일, 사용 현황, 변경 이력 등 전체 데이터를 엑셀
              파일(.xlsx)로 내려받습니다.
            </p>
            <p className="system-text muted">엑셀 파일로는 복구할 수 없습니다. 복구는 아래의 백업 파일을 사용하세요.</p>
            <div className="system-actions">
              <a className="btn" href="/api/export.xlsx" download aria-disabled={busy || undefined}>
                엑셀로 내려받기
              </a>
            </div>
          </section>
        </div>
      )}

      <section className="system-backups" aria-labelledby="system-backup-list">
        <div className="row">
          <h2 id="system-backup-list" className="section-title">
            백업 파일
          </h2>
          <span className="spacer" />
          {backups.data && backups.data.length > 0 && <span className="muted">{backups.data.length}개</span>}
        </div>
        <ErrorText error={backups.error} />
        {backups.isPending && !restarting ? (
          <Spinner />
        ) : backups.data && backups.data.length === 0 ? (
          <EmptyState title="백업 파일이 아직 없습니다.">
            {data && <span>매일 {data.backupTime}에 자동으로 백업합니다. 지금 바로 만들려면 '지금 백업'을 누르세요.</span>}
          </EmptyState>
        ) : backups.data ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>일시</th>
                  <th>종류</th>
                  <th>위치</th>
                  <th className="num">크기</th>
                  <th>파일 이름</th>
                  <th aria-label="복구" />
                </tr>
              </thead>
              <tbody>
                {backups.data.map((b) => (
                  <tr key={`${b.location}/${b.name}`}>
                    <td className="backup-when">{formatTimestamp(b.modifiedAt)}</td>
                    <td className="nowrap">{backupReason(b.name)}</td>
                    <td>
                      <Badge tone={b.location === "nas" ? "accent" : undefined}>
                        {b.location === "nas" ? "NAS" : "로컬"}
                      </Badge>
                    </td>
                    <td className="num nowrap">{formatSize(b.size)}</td>
                    <td className="backup-name">{b.name}</td>
                    <td className="system-row-action">
                      <Button size="sm" onClick={() => onRestore(b)} disabled={busy}>
                        복구
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
