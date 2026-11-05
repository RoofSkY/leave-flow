# 시스템 (`routes/system.ts`, `services/backup.ts`, `services/updater.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/system/info` | | `SystemInfo` |
| POST | `/api/system/update/check` | | `UpdateCheckResult` |
| POST | `/api/system/update/apply` | | `{ message }` 후 재시작(종료 코드 75) |
| PUT | `/api/system/nas-backup-dir` | `{ nasBackupDir }` (빈 문자열 = 끔) | `{ nasBackupDir }` (`string \| null`). 폴더에 시험 파일을 써 보고 실패하면 400. config.json 에 저장하고 재시작 없이 적용, 변경 이력(설정) |
| GET | `/api/backups` | | `BackupFile[]` (최근순, 로컬 + NAS) |
| POST | `/api/backups` | | 201 `BackupFile` (지금 백업) |
| POST | `/api/backups/restore` | `{ name, location }` | `{ message }` 후 재시작(종료 코드 76) |
| GET | `/api/export.xlsx` | | 엑셀 파일 다운로드 |
| POST | `/api/export/table.xlsx` | `tableExportInput` `{ title, subtitle, head, body }` | 화면 표(잔여 현황·사용 현황)를 그대로 엑셀로. 1줄 제목, 2줄 부제목, 3줄부터 머리글(`head` 칸의 `colSpan`·`rowSpan` → 셀 병합)과 본문(문자열). 머리글·첫 열 고정, A4 가로·너비 한 장, 머리글 줄 반복 인쇄 |

공통 규칙은 [API](index.md)를 보세요.
