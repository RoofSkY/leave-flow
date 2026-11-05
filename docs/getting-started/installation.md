# 설치

1. `leave-flow-setup-<버전>.exe`를 실행합니다.

- "이 앱이 디바이스를 변경하도록 허용하시겠어요?"가 나오면 **예**를 누릅니다.
- "Windows의 PC 보호" 창이 나오면 **추가 정보** → **실행**을 누릅니다 (서명하지 않은 프로그램이라 나오는 안내입니다).

2. 출결 PC의 IP를 확인하고([네트워크 설정](../general/network.md)), 다른 PC의 브라우저에서 `http://<출결 PC IP>:8080`으로 접속되는지 확인합니다.

설치 폴더는 설치하는 계정의 **문서 폴더 안 `leave-flow`**(예: `C:\Users\<계정>\Documents\leave-flow`)가 기본이며, 설치할 때 바꿀 수 있습니다.
문서 폴더가 OneDrive와 동기화되고 있으면 DB 파일이 동기화되면서 문제가 생길 수 있으니 OneDrive 밖의 폴더(예: `C:\leave-flow`)를 고르세요.
NAS 백업 폴더는 설치한 뒤 관리 → **설정**의 **NAS 백업 폴더**에서 지정할 수 있습니다 ([NAS 백업](../backup/nas.md)).

설치가 끝나면 [처음 설정 순서](first-setup.md)대로 입력합니다.

## 수동설치 (zip)

다른 포트·폴더를 쓰거나 인터넷이 안 될 때는 배포 파일 `leave-flow-<버전>.zip`의 압축을 풀고
`scripts\install.cmd`를 더블클릭하거나(검은 창에 진행 상황이 나옴), 아래처럼 **관리자 PowerShell**에서 옵션을 주어 실행합니다.
(시작 메뉴에서 PowerShell을 오른쪽 클릭 → "관리자 권한으로 실행")

```powershell
cd "압축을 푼 폴더"
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Port 8090 -NasBackupDir "\\NAS주소\backup\leave-flow"
```

| 옵션               | 뜻                                                          | 기본값                                       |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------- |
| `-InstallDir`      | 설치 폴더                                                   | 이미 설치된 폴더, 처음이면 `문서\leave-flow` |
| `-Port`            | 접속 포트 (5000번은 사용 불가)                              | `8080`                                       |
| `-NasBackupDir`    | NAS 백업 폴더                                               | 없음                                         |
| `-UpdateRepo`      | 자동 업데이트할 GitHub 저장소 `owner/repo`                  | 배포 파일에 적힌 저장소                      |
| `-ReleaseZip`      | 배포 파일 경로                                              | 스크립트가 있는 폴더                         |
| `-NodeZip`         | 미리 받아 둔 `node-v24.x.x-win-x64.zip` (인터넷이 안 될 때) | nodejs.org에서 받음                          |
| `-NoAutoStart`     | Windows 로그인 시 자동 실행하지 않음                        | 자동 실행함                                  |
| `-DesktopShortcut` | 바탕화면 바로가기 만들기 (주지 않으면 있던 바로가기를 지움) | 만들지 않음                                  |

## 재설치·버전 바꾸기

같은 설치 프로그램(또는 다른 버전의 설치 프로그램·zip)을 다시 실행하면 이미 설치된 폴더에 덮어 설치합니다.
낮은 버전으로 바꾸는 방법은 [문제 해결 — 이전 버전으로 돌아가고 싶을 때](../troubleshooting/index.md#새-버전에-문제가-있어-이전-버전으로-돌아가고-싶을-때)를 보세요.

## 설치 폴더

```
<설치 폴더>\     (기본: 문서\leave-flow)
  node\            전용 Node.js
  tray.ps1         트레이 아이콘 (로그인 시 자동 실행 대상, launcher.mjs 를 실행)
  leave-flow.ico   트레이·바로가기 아이콘
  launcher.mjs     서버를 실행하고 감시하는 프로그램
  versions\0.1.0\  프로그램 (버전별)
  state.json       지금 실행할 버전 기록 (직접 고치지 마세요)
  config.json      설정
  data\            DB (leave-flow.db)  ← 가장 중요한 데이터
  backups\         로컬 백업
  logs\            로그
  updates\         내려받은 업데이트 파일
```

## 제거

Windows **설정 → 앱 → 설치된 앱**에서 **leave-flow 휴가원 관리**를 제거합니다 (zip으로 설치했으면 `scripts\uninstall.cmd`를 더블클릭).
자동 실행·바로가기·방화벽 규칙·프로그램 파일을 지우고 **데이터와 백업은 남깁니다.**
설치 폴더까지 모두 지우려면 관리자 PowerShell에서 `uninstall.ps1 -RemoveData`를 실행합니다 (확인을 위해 '삭제'를 입력해야 합니다).
