# 배포 구조와 자동 업데이트

```
문서\leave-flow\            ← 설치 폴더 (LEAVE_FLOW_HOME, 설치할 때 바꿀 수 있음)
  node\node.exe            ← 전용 포터블 Node 24 (PC의 다른 Node·Python과 무관)
  launcher.mjs             ← 트레이(tray.ps1)가 실행하는 프로그램. 서버를 띄우고 감시
  versions\0.1.0\server.mjs, web\ …
  state.json               ← {"current":"0.1.0","previous":null,"pending":null, ...}
  config.json              ← 포트, NAS 백업 폴더, 업데이트 저장소 등 (config.ts 참고)
  data\leave-flow.db       ← DB (+ restore-pending.db: 복구 대기)
  backups\                 ← 로컬 백업
  logs\                    ← 서버 로그 (launcher가 기록)
  updates\                 ← 내려받은 업데이트 파일
```

- 릴리스 자산: `leave-flow-<버전>.zip`(안에 `server.mjs`, `web/`, `launcher.mjs`, `scripts/`) + `leave-flow-<버전>.zip.sha256` + 처음 설치용 `leave-flow-setup-<버전>.exe`(자동 업데이트에는 쓰지 않음). GitHub 태그 `v<버전>`.
- 서버(updater): `https://api.github.com/repos/<repo>/releases/latest` 확인 → 새 버전이면 zip·sha256 다운로드 → SHA-256 확인 → **DB 백업** → `versions/<버전>/`에 압축 해제(경로 탈출 방지) → `state.json`의 `pending` 기록 → 종료 코드 75.
- launcher: 종료 코드 75면 `pending`을 `current`로 바꾸고(이전 값은 `previous`) 새 버전 실행 → 60초 안에 `/api/health`의 version이 새 버전이 아니면 `previous`로 되돌리고 실패 기록. 종료 코드 76(백업 복구)은 그냥 재시작. 그 밖의 비정상 종료는 잠시 뒤 재시작. 0이면 launcher도 종료.
- 백업 복구: 지금 DB를 백업 → 고를 백업을 `data/restore-pending.db`로 복사 → 종료 코드 76 → 서버 시작 시 `applyPendingRestore(config)`가 DB를 바꿔 끼움(index.ts에서 DB 열기 전에 호출).
- 개발 실행(`APP_VERSION === "dev"`)이나 `updateRepo`가 없으면 업데이트 기능은 꺼짐.
- 새 버전 확인은 `autoUpdate=false`여도 주기적으로 함 (`autoUpdate`는 자동 설치 여부만 정함). `updateCheckHours`는 1~576으로 보정.
- `state.json`의 `failedVersion`은 되돌린 버전(설치 스크립트로 낮은 버전을 다시 설치한 경우 포함) → 자동 업데이트에서 건너뜀. launcher의 시험 기동 확인은 `config.host`(0.0.0.0·:: 이면 127.0.0.1) 사용.
