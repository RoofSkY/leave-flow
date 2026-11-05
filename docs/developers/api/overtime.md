# 시간외근무 신청서 (`routes/overtime.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/overtime?kind=general\|soldier\|award&status=active\|cancelled\|all&year=` | | `OvertimeRequest[]` (최근 작성순). year: 일반 = 근무 시작 연도, 요원·시상 = 지급 연도 |
| GET | `/api/overtime/:id` | | `OvertimeRequest` |
| POST | `/api/overtime` | `overtimeInput` | 201 `OvertimeRequest` |
| PUT | `/api/overtime/:id` | `overtimeInput` (kind 같아야 함) + `baseUpdatedAt` | `OvertimeRequest` |
| POST | `/api/overtime/:id/cancel` | | `OvertimeRequest` |
| POST | `/api/overtime/:id/restore` | | `OvertimeRequest` |
| GET | `/api/overtime/:id/print-data` | | `OvertimePrintData` (기록·적립 안 함) |
| POST | `/api/overtime/:id/print` | | `OvertimePrintData` (출력 기록, 일반은 첫 출력 시 제출·적립) |

적립 규칙 (부여 내역 `source='overtime'`, `overtime_request_id` 연결, 대상자마다 1건):
- 입력: 일반 `targets: { employeeId, leaveTypeId }[]`, 요원 `targets: { employeeId, leaveTypeId, days, month }[]`, 시상 `targets: { employeeId, leaveTypeId, days }[]`.
- 적립 종류: **신청서에서 대상자마다 고름** (`leaveTypeId`, 필수). 저장할 때 대상자마다 `overtime_targets.leave_type_id`에 기록하고 적립·재적립(수정·복구)에 그 종류 사용. 수정으로 종류를 바꾸면 적립된 부여도 바꾼 종류로 다시 만듦. `OvertimeTarget.leaveTypeId` = 고른 종류.
- 고른 종류 검사 (저장 400, 아무것도 저장 안 함): 비었으면 `적립할 휴가 종류를 선택하세요.`, 없는 종류 `선택한 휴가 종류를 찾을 수 없습니다.`, 비활성 `비활성화된 휴가 종류(이름)는 고를 수 없습니다.`, 그 직원에게 적용되지 않음 `홍길동님에게 적용되지 않는 휴가 종류입니다. (이름)`. 수정 중 그 대상자가 원래 고른 종류는 비활성이거나 적용 대상에서 빠졌어도 허용.
- 적립 직전(첫 출력·복구)에 아직 적립되지 않은 대상자의 종류가 더는 그 직원에게 적용되지 않으면 400 `고른 휴가 종류가 적용되지 않는 직원이 있습니다: 홍길동(A 적용 안 됨). …` (제출·적립 안 함). 이미 적립된 대상자는 허용.
- **일반**: 저장 시 적립 안 함(미제출). **처음 출력할 때** `submitted_on = ctx.today()`로 고정하고 적립(부여일 = 제출일, 양 = 금일발생). 다시 출력해도 제출일·적립 그대로. 대상 직원은 활성이어야 함(새로 만들 때).
- **요원**: 저장할 때 바로 적립 (부여일 = 지급일자, 양 = 일수 × 그 요원의 하루 근무시간, 대상에 `days` 기록). 대상은 구분이 사회복무요원 특별휴가 대상(`Employee.isSocialServiceAgent`)인 활성 직원.
- **시상**(`kind: "award"`): 요원과 같고 대상에 발생 월이 없음(`month` = null), `category`는 `award` 하나(생략 가능). 적립 부여 비고 `사회복무요원 특별휴가(시상)`.
- 수정: 적립되어 있으면 연결된 부여를 지우고 새 값으로 다시 만듦 (같은 트랜잭션).
- 취소: 연결된 부여 삭제(회수), 상태 `cancelled`. 미제출 일반은 회수할 것 없음. 복구: `active`로 돌리고, 요원·시상이거나 제출된 일반이면 다시 적립.
- 출력 데이터: 일반 `submitDate` = 제출일(미제출이면 미리보기로 오늘), `year` = 제출 연도(미제출이면 올해). 요원·시상 `submitDate` = 오늘, `year` = 지급 연도. 취소된 신청서 출력 → 409.

공통 규칙은 [API](index.md)를 보세요.
