# API

화면(`apps/web`)과 서버(`apps/server`)가 주고받는 API. 응답 타입은 `packages/shared/src/types.ts`, 입력 검사는 `packages/shared/src/schemas.ts`.

## 공통 규칙

- 모든 API는 `/api` 아래, JSON. 날짜 `YYYY-MM-DD`, 일시 `YYYY-MM-DDTHH:MM`, 기록 일시 `YYYY-MM-DD HH:MM:SS` (모두 로컬 시각, 시간대 없음).
- 시간 양은 모두 **분** 단위 정수. 1일 = 그 직원의 하루 근무시간(`dayMinutesOf`, 점심 제외, 알 수 없으면 480분). 표시할 때만 `formatLeaveMinutes(minutes, dayMinutes)` → `0일 0시간 0분` 중 0인 부분은 빼고 표시 (예: `12일 10분`, `2시간 30분`, 전부 0이면 `0일`).
- 오류: `{ "error": "화면에 그대로 보여줄 한국어 메시지", "details"?: ... }`
  - 400 입력 오류 (`parseInput(schema, body)` 사용), 404 없음, 409 상태상 불가 (취소된 문서 수정, 다른 사람이 먼저 수정 등)
- 문서 수정(휴가원·시간외근무 신청서 PUT)은 본문에 `baseUpdatedAt`(`editBaseInput`, 수정 창을 열 때 본 문서의 `updatedAt`)을 함께 보냄. 저장된 `updatedAt`과 다르면 덮어쓰지 않고 409 `다른 사람이 이 휴가원(신청서)을 먼저 수정했습니다. 창을 닫고 다시 열어 바뀐 내용을 확인한 뒤 수정하세요.`, 없으면 400. 화면은 409를 받으면 `invalidateLeaveData`로 다시 불러옴
- 생성은 201, 삭제는 204.
- 날짜·일시는 2000~2100년만 (`dateString`/`dateTimeString`, 벗어나면 400 `2000~2100년 사이의 날짜를 입력하세요.`). 숫자 범위 등 모든 입력 규칙에 한국어 메시지를 붙이고, 빠진 것도 `z.config(z.locales.ko())`로 한국어.
- 로그인이 없으므로 `/api` 요청은 `app.ts`의 `checkApiRequest`가 먼저 검사한다 (다른 사이트에서의 조작·DNS 리바인딩 차단):
  - Host가 IP 주소·`localhost`·이 PC 이름·`config.json`의 `allowedHosts`가 아니면 403 `허용되지 않은 주소로 접속했습니다. 출결 PC의 IP 주소로 접속하세요.`
  - GET/HEAD/OPTIONS 외의 요청에 `Origin`이 있으면 Host와 같아야 함 (`null`·다른 주소 → 403 `다른 사이트에서 보낸 요청은 처리하지 않습니다.`)
  - POST/PUT/PATCH에 `Content-Type`이 있으면 `application/json`이어야 함 (아니면 415 `요청 형식이 올바르지 않습니다.`). 본문 없는 요청은 Content-Type 없이 보내도 됨.
- 모든 응답(화면 파일·API·오류)에 `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` (`app.ts` onSend 훅). 다른 사이트가 화면을 iframe으로 겹쳐 띄워 클릭을 유도하는 것(클릭재킹)을 막음. 앱도 iframe을 쓰지 않음
- **모든 데이터 변경은 `transaction()` 안에서 하고, 같은 트랜잭션에서 `writeAudit()`으로 변경 이력을 남긴다.** `summary`는 사람이 읽는 한 줄(예: `홍길동 휴가원 취소 (2026.10.01. 10:00 ~ 19:00)`), 관련 직원이 있으면 `employeeId`를 채운다.
- 오늘 날짜·지금 시각은 반드시 `ctx.today()` / `ctx.now()` 사용 (테스트에서 바꿀 수 있게).
- 화면 쪽: 휴가·부여·잔여에 영향을 주는 변경 후에는 `invalidateLeaveData(queryClient)` 호출.
- 휴가 종류 이름에 의존하는 코드 금지 (처음 설치 시 휴가 종류는 0개, 관리자가 모두 등록).

## 목록

| 문서 | 경로 |
|---|---|
| [직원](employees.md) | `/api/employees` |
| [휴가 종류](leave-types.md) | `/api/leave-types` |
| [부여 내역](grants.md) | `/api/grants` |
| [기존 잔여량](opening-balances.md) | `/api/opening-balances` |
| [설정](settings.md) | `/api/settings` |
| [구분](categories.md) | `/api/categories` |
| [소속](departments.md) | `/api/departments` |
| [잔여](balances.md) | `/api/balances` |
| [휴가원](leave-requests.md) | `/api/leave-requests` |
| [달력·부재자](calendar.md) | `/api/calendar/events`, `/api/absences` |
| [시간외근무 신청서](overtime.md) | `/api/overtime` |
| [공휴일·휴무일](holidays.md) | `/api/holidays` |
| [사용 현황·변경 이력](reports.md) | `/api/usage`, `/api/audit-logs` |
| [시스템](system.md) | `/api/system`, `/api/backups`, `/api/export` |
