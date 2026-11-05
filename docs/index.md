# leave-flow

웹 브라우저로 **휴가원**과 **시간외근무 신청서**를 작성·조회·출력하는 프로그램입니다.

- **[시작하기](getting-started/index.md)** - 설치부터 초기 설정까지

## 운영

| 문서                                             | 내용                                                  |
| ------------------------------------------------ | ----------------------------------------------------- |
| [설치](getting-started/installation.md)          | 설치 프로그램, 수동설치, 설치 폴더, 제거              |
| [처음 설정 순서](getting-started/first-setup.md) | 휴가 종류 → 설정 → 직원 → 기존 잔여량 → 부여 내역     |
| [실행과 트레이](general/running.md)              | 자동 실행, 트레이 아이콘, 끄고 다시 켜기              |
| [접속 주소와 네트워크](general/network.md)       | 접속 주소, 고정 IP, 방화벽                            |
| [영구 삭제](general/deletion.md)                 | 직원·휴가 종류·휴가원 영구 삭제                       |
| [설정 파일](configuration/index.md)              | `config.json`, `update-config.ps1`                    |
| [백업](backup/index.md)                          | 자동 백업, 백업 파일 이름, 엑셀 백업                  |
| [NAS 백업](backup/nas.md)                        | NAS 백업 폴더와 계정                                  |
| [복구](backup/restore.md)                        | 관리 화면에서 복구, 서버가 시작되지 않을 때 직접 복구 |
| [문제 해결](troubleshooting/index.md)            | 접속, 포트 충돌, 로그, 업데이트 실패, 이전 버전으로   |

## 개발자

| 문서                                                    | 내용                                  |
| ------------------------------------------------------- | ------------------------------------- |
| [개발 안내](developers/index.md)                        | 저장소 구조, 개발 명령                |
| [배포 구조와 자동 업데이트](developers/architecture.md) | 설치 폴더 구조, updater·launcher 동작 |
| [새 버전 배포](developers/publishing.md)                | 버전 올리기, 태그, GitHub Actions     |
| [API](developers/api/index.md)                          | 화면과 서버가 주고받는 API 계약       |
