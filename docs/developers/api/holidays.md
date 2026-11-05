# 공휴일·휴무일 (`routes/holidays.ts`, `services/holidays.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/holidays?from=&to=&includeInactive=1` | | `Holiday[]` (날짜순) |
| POST | `/api/holidays` | `holidayInput` | 201 `HolidayChangeResult` |
| DELETE | `/api/holidays/:id` | | `HolidayChangeResult` (holiday = null) |
| POST | `/api/holidays/:id/restore` | | `HolidayChangeResult` (지웠던 자동 등록분 되살리기) |
| POST | `/api/holidays/sync` | | `{ added: number, recalculated: RecalcChange[] }` |

- 추가: `source='manual'`. 같은 (날짜, 구분, 이름)의 지워진 자동 등록분이 있으면 되살림.
- 삭제: 수동 등록분은 행 삭제, 자동 등록분은 `active=0` (재등록 방지).
- 추가·삭제·되살리기·동기화 후 `recalcFutureRequests(db, ctx.today(), ip, 이유)` 실행, 결과를 `recalculated`로 반환. 대상은 종료일(마지막 항목 종료일) ≥ 오늘인 신청 상태 휴가원의 **모든 항목**(이미 지난 항목 포함).
- 자동 등록(`insertAutoHolidays`): `date-holidays`의 KR `type === 'public'`만. 여러 날 공휴일은 `start`~`end`의 날마다 등록. **주의: date-holidays의 `설날`은 하루 밀려 있음** (2026년: 라이브러리 2/17~19, 실제 2/16~18) → 설날은 `date` 기준 전날·당일·다음날로 보정. 추석은 라이브러리 값이 맞음. 대체공휴일은 라이브러리 값 사용.

공통 규칙은 [API](index.md)를 보세요.
