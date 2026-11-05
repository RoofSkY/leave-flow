# 설정 파일 (config.json)

`<설치 폴더>\config.json` — 설치할 때 만들어집니다. 메모장으로 고칠 수 있고, 고친 뒤에는 **다시 시작**해야 적용됩니다 ([끄고 다시 켜기](../general/running.md#끄고-다시-켜기)).
가장 쉬운 방법은 관리자 PowerShell에서 `update-config.ps1`을 쓰는 것입니다 (값 바꾸기 + 다시 시작을 한 번에).

## update-config.ps1

```powershell
cd <설치 폴더>\versions\<버전>\scripts
powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -NasBackupDir "\\NAS주소\backup\leave-flow"
powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -Port 8090      # 방화벽 규칙도 함께 바뀜
powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -AutoUpdate off # 자동 설치 끄기 (확인은 계속)
powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -DisableNas     # NAS 백업 끄기
powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -DisableUpdates # 업데이트 기능 끄기 (updateRepo를 null로)
```

| 옵션                             | 뜻                                           |
| -------------------------------- | -------------------------------------------- |
| `-Port`                          | 접속 포트 (방화벽 규칙도 함께 바뀜)          |
| `-NasBackupDir`                  | NAS 백업 폴더                                |
| `-DisableNas`                    | NAS 백업 끄기 (`nasBackupDir`을 `null`로)    |
| `-UpdateRepo`                    | 업데이트 저장소 `owner/repo`                 |
| `-DisableUpdates`                | 업데이트 기능 끄기 (`updateRepo`를 `null`로) |
| `-AutoUpdate on` / `off`         | 새 버전 자동 설치 켜기/끄기                  |
| `-BackupTime`, `-BackupKeepDays` | 자동 백업 시각, 보관 일수                    |

> 관리자 PowerShell(5.1)에서는 `-NasBackupDir ""`처럼 **빈 값을 넘기면 오류**가 납니다. 끌 때는 `-DisableNas`, `-DisableUpdates`를 쓰세요.
> (`-NasBackupDir none`, `-UpdateRepo none`도 같은 뜻입니다.)

## 항목

| 항목                   | 뜻                                                                                                                                                                                                              | 기본값            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `port`                 | 접속 포트. **5000 사용 불가**                                                                                                                                                                                   | `80`              |
| `nasBackupDir`         | NAS 백업 폴더 (예: `"\\\\NAS주소\\backup\\leave-flow"` — JSON에서는 `\`를 두 번 씀). 없으면 `null`                                                                                                              | `null`            |
| `backupTime`           | 매일 자동 백업 시각 `"HH:MM"`                                                                                                                                                                                   | `"12:30"`         |
| `backupKeepDays`       | 백업 보관 일수 (로컬·NAS 모두)                                                                                                                                                                                  | `30`              |
| `updateRepo`           | 자동 업데이트할 공개 GitHub 저장소 `"owner/repo"`. 없으면 업데이트 기능 꺼짐                                                                                                                                    | 배포 파일 값      |
| `autoUpdate`           | 새 버전을 자동으로 설치할지. `false`면 확인만 하고 설치는 관리 화면에서 직접                                                                                                                                    | `true`            |
| `updateCheckHours`     | 새 버전 확인 주기(시간). 1 ~ 576(24일) 사이로 쓰고, 그보다 크면 576시간, 숫자가 아니면 6시간으로 확인                                                                                                           | `6`               |
| `dataDir`, `backupDir` | DB·로컬 백업 폴더 (보통 바꾸지 않음)                                                                                                                                                                            | `data`, `backups` |
| `host`                 | 접속을 받을 주소 (보통 바꾸지 않음). 특정 IP로 정하면 launcher·설치 스크립트도 그 주소로 서버 상태를 확인                                                                                                       | `0.0.0.0`         |
| `allowedHosts`         | IP 대신 이름으로 접속하게 할 때 그 이름 목록 (예: `["leave-pc"]`). IP 주소·`localhost`·출결 PC 이름은 항상 허용되고, 그 밖의 이름으로 접속하면 "허용되지 않은 주소" 안내가 나옴. 직원들은 보통 IP로 접속하면 됨 | `[]`              |
