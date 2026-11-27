# 설정 파일

설정은 `<설치 폴더>\config.json`에 있습니다. 관리자 PowerShell에서 `update-config.ps1`로 바꾸는 것이 가장 쉽습니다 (값을 바꾸고 다시 시작까지 함).
포트만 바꿀 때는 트레이 아이콘의 **포트 바꾸기…**가 더 간단합니다 (같은 스크립트를 실행함).
메모장으로 직접 고쳤으면 트레이 **종료** 후 다시 켜야 적용됩니다.

## update-config.ps1

```powershell
cd <설치 폴더>\versions\<버전>\scripts
powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -Port 8090
```

| 옵션                              | 뜻                                                 |
| --------------------------------- | -------------------------------------------------- |
| `-Port`                           | 접속 포트 (방화벽 규칙도 함께 바꿈)                |
| `-NasBackupDir` / `-DisableNas`   | NAS 백업 폴더 / NAS 백업 끄기                      |
| `-UpdateRepo` / `-DisableUpdates` | 업데이트 저장소 `owner/repo` / 업데이트 기능 끄기  |
| `-AutoUpdate on` / `off`          | 새 버전 자동 설치 켜기 / 끄기 (확인은 계속)        |
| `-BackupTime`, `-BackupKeepDays`  | 자동 백업 시각, 보관 일수                          |

끌 때 `-NasBackupDir ""`처럼 빈 값을 주면 PowerShell 5.1에서 오류가 나니 `-DisableNas`·`-DisableUpdates`를 쓰세요.

## config.json 항목

| 항목                   | 뜻                                                                    | 기본값            |
| ---------------------- | --------------------------------------------------------------------- | ----------------- |
| `port`                 | 접속 포트                                                             | `8082`            |
| `nasBackupDir`         | NAS 백업 폴더. JSON에서는 `\`를 두 번 씀 (`"\\\\NAS주소\\backup"`)    | `null`            |
| `backupTime`           | 자동 백업 시각 `"HH:MM"`                                              | `"12:30"`         |
| `backupKeepDays`       | 백업 보관 일수 (로컬·NAS)                                             | `30`              |
| `updateRepo`           | 자동 업데이트할 공개 GitHub 저장소 `"owner/repo"`. 없으면 업데이트 끔 | 배포 파일 값      |
| `autoUpdate`           | 새 버전 자동 설치. `false`면 확인만 하고 설치는 관리 화면에서         | `true`            |
| `updateCheckHours`     | 새 버전 확인 주기 (시간, 1~576)                                       | `6`               |
| `dataDir`, `backupDir` | DB·로컬 백업 폴더                                                     | `data`, `backups` |
| `host`                 | 접속을 받을 주소                                                      | `0.0.0.0`         |
| `allowedHosts`         | IP 대신 이름으로 접속할 때 그 이름 목록 (예: `["leave-pc"]`)          | `[]`              |
| `logger`               | 서버 요청 로그 기록                                                   | `true`            |
