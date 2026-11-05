# 기존 잔여량 (`routes/openingBalances.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/opening-balances?year=&employeeId=` | | `OpeningBalance[]` |
| PUT | `/api/opening-balances` | `openingBalanceInput` | `OpeningBalance` (직원·종류·연도 기준 upsert) |
| DELETE | `/api/opening-balances/:id` | | 204 |

- `totalGrantedMinutes`는 분(10분 단위, 화면이 그 직원의 1일 기준으로 환산). `usedMinutes = totalGrantedMinutes − remainingMinutes`. 잔여가 총 부여보다 크면 400.

공통 규칙은 [API](index.md)를 보세요.
