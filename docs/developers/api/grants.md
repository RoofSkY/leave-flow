# 부여 내역 (`routes/grants.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/grants?employeeId=&leaveTypeId=&year=` | | `Grant[]` (부여일 내림차순) |
| POST | `/api/grants` | `grantInput` | 201 `Grant` |
| POST | `/api/grants/bulk` | `grantBulkInput` (여러 직원) | 201 `Grant[]` (직원마다 1건, 한 명이라도 문제가 있으면 아무것도 저장 안 함) |
| PUT | `/api/grants/:id` | `grantInput` | `Grant` |
| DELETE | `/api/grants/:id` | | 204 |

- 양은 `days`(정수) + `hours`(10분 단위까지) + `minutes`(선택, 10분 단위, 기본 0) → 직원마다 `minutes = days × 그 직원의 하루 근무시간 + hours × 60 + minutes` (일괄 부여도 직원마다 따로 계산). 모두 0이면 400. 직원·종류가 있어야 하고, 새로 만들 때 종류는 활성이어야 함.
- `source = overtime` 인 부여는 수정·삭제 → 409 `시간외근무 신청서로 적립된 부여는 시간외근무 화면에서 수정하세요.`
- 수정으로 직원을 바꿀 수 없음 → 400 `부여 내역의 직원은 바꿀 수 없습니다. 삭제 후 새로 추가하세요.`

공통 규칙은 [API](index.md)를 보세요.
