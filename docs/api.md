# leave-flow API 계약

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

---

## 직원 (`routes/employees.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/employees?includeInactive=1&includeDeleted=1` | | `Employee[]` (활성 먼저, 이름순). includeDeleted = 영구 삭제된 직원도 (남은 기록을 소속·구분으로 거를 때만, 고르는 목록에는 쓰지 않음) |
| POST | `/api/employees` | `employeeInput` | 201 `Employee` |
| PUT | `/api/employees/:id` | `employeeInput` | `Employee` |
| POST | `/api/employees/:id/deactivate` | | `Employee` |
| POST | `/api/employees/:id/activate` | | `Employee` |
| GET | `/api/employees/:id/delete-check` | | `DeleteCheck` |
| POST | `/api/employees/:id/delete` | `deleteInput` `{ confirmName }` | 204 |

- 이미 그 상태면 409.
- 영구 삭제(`services/purge.ts`): 활성 → 409. 기록(휴가원·시간외근무 신청서·부여·기존 잔여)이 있으면 `confirmName` = 이름이어야 함(아니면 400), 삭제 직전 `pre-delete` 백업. 휴가원·신청서가 있으면 행은 `deleted = 1`로 남기고 성명·연락처를 비움(소속·구분은 적용 대상 판단용으로 남김) (목록·조회에서 빠지고 `getEmployee`는 404). 휴가원이 있으면(`DeleteCheck.balanceKept`) 부여·기존 잔여·적용 대상 행은 지우지 않고 숨김 (`/grants`·`/opening-balances` 목록·단건, 엑셀, `LeaveType.target.employeeIds`에서 빠짐. 휴가 종류 적용 대상을 다시 저장해도 그 행은 유지) → 출력 데이터의 휴가현황은 삭제 전과 같음. `LeaveRequest.employeeDeleted`·`OvertimeTarget.employeeDeleted` = true인 문서는 수정·취소·복구 409.
- 직원 정보를 고쳐도 기존 휴가원(신청 시점 값 보관)은 바뀌지 않음.
- `approvalRoles`: 휴가원 결재칸, `"담당" | "팀장" | "센터장" | "대표"` 하나 이상 (없으면·그 밖의 값은 400). 저장할 때 중복을 빼고 이 순서로 정렬 (`employees.approval_roles` JSON, 기본 담당·센터장).

## 휴가 종류 (`routes/leaveTypes.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/leave-types?includeInactive=1` | | `LeaveType[]` (표시 순서, id) |
| POST | `/api/leave-types` | `leaveTypeInput` | 201 `LeaveType` |
| PUT | `/api/leave-types/:id` | `leaveTypeInput` | `LeaveType` |
| POST | `/api/leave-types/:id/deactivate` | | `LeaveType` |
| POST | `/api/leave-types/:id/activate` | | `LeaveType` |
| GET | `/api/leave-types/:id/delete-check` | | `DeleteCheck` |
| POST | `/api/leave-types/:id/delete` | `deleteInput` `{ confirmName }` | 204 |

- 활성 종류끼리 이름(관리 이름) 중복 → 409.
- `displayName`(표시 이름, 선택, 30자, 빈 값 = 관리 이름): 겹쳐도 됨. 보이는 이름 = `leaveTypeLabel(t)`. 휴가 종류 추가·수정·활성화, 직원 추가·수정·활성화 뒤 한 활성 직원에게 보이는 이름이 같은 활성 종류가 둘 이상 적용되면 409 (`services/displayNames.ts`, 저장 취소).
  - 보이는 이름 사용: `LeaveRequestItem.leaveTypeDisplayName`, 달력·부재 `leaveTypeName`, 출력 데이터의 `balanceTable[].name`·`checkboxes[].name`(양식 안에서 겹치면 관리 이름), 잔여 초과·기간 겹침 경고. `BalanceRow.displayName` 포함.
- `inUse`(부여·사용·기존잔여 기록 있음)인 종류는 `balanceMode`·`expireMonth`·`expireDay`·`validMonths` 변경 → 409 `부여·사용 기록이 있는 휴가 종류는 잔여 방식(소멸일·기간 포함)을 바꿀 수 없습니다.`
- `balanceMode`: `yearly` | `cumulative` | `expire_date`(필수 `expireMonth` 1~12·`expireDay` 그 달 일수) | `grant_period`(필수 `validMonths` 1~120) | `used_up`(소진: 잔여 계산은 `cumulative`와 같음, `deducts: true`만 가능 → 아니면 400). 방식에 쓰지 않는 값은 null로 저장.
- `hideWhenEmpty`(선택): 소진 종류의 "남은 양이 없으면 휴가원에서 숨김". 생략하면 true, 소진이 아니면 늘 false로 저장 (`leave_types.hide_when_empty`). 기록이 있어도 바꿀 수 있음. 켜면 잔여가 0 이하인 직원의 휴가원 작성 목록(화면에서 처리)과 출력 데이터의 `balanceTable`·`checkboxes`에서 빠짐 (이번 휴가원에서 쓴 종류는 남음).
- `target`: `{ departments: string[], categories: string[], employeeIds: number[] }` 또는 null(생략 포함) = 전체 직원. 대상 = 따로 고른 직원 + 소속·구분 조건에 맞는 직원 (`leaveTypeAppliesTo`: 고른 칸끼리는 모두 맞아야, 칸 안에서는 하나만. 예: 아동사업부 + 직원 → 아동사업부의 직원). 셋 다 비면 400, 중복 400, 목록에 없는 소속·구분, 없는 직원 → 400. 응답의 `employeeIds`는 오름차순. 소속·구분은 `leave_types.target_departments`·`target_categories`(JSON), 직원은 `leave_type_employees`.
  - 대상이 아닌 직원에게 그 종류로 휴가원 저장(항목 오류 `이 직원에게 적용되지 않는 휴가 종류입니다. (이름)`)·부여(일괄 포함)·기존 잔여 새로 입력 → 400, 시간외근무 적립 → 400 (대상 이름 나열). 수정 중인 휴가원·부여에 이미 있던 종류, 이미 적립된 직원은 허용.
  - 잔여(`BalanceRow`)·휴가원 출력 데이터에는 대상이 아니고 기록도 없는 종류는 빠짐.
- `BalanceRow`에 `periodStart`·`periodEnd`(연도별·정한 날짜 소멸의 계산 기간), `asOf`(부여 후 기간: 이 날 쓸 수 있는 양) 포함
- 영구 삭제: 직원과 같은 규칙. 추가로 그 종류를 고른 시간외근무 신청서가 있으면 409(`DeleteCheck.blockedReason`). 휴가원 항목이 있으면 `deleted = 1`로 이름만 남김 (`LeaveRequestItem.leaveTypeDeleted`, 잔여 계산 제외, 그 휴가원 수정 409).

## 부여 내역 (`routes/grants.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/grants?employeeId=&leaveTypeId=&year=` | | `Grant[]` (부여일 내림차순) |
| POST | `/api/grants` | `grantInput` | 201 `Grant` |
| POST | `/api/grants/bulk` | `grantBulkInput` (여러 직원) | 201 `Grant[]` (직원마다 1건, 한 명이라도 문제가 있으면 아무것도 저장 안 함) |
| PUT | `/api/grants/:id` | `grantInput` | `Grant` |
| DELETE | `/api/grants/:id` | | 204 |

- 양은 `days`(정수) + `hours`(10분 단위까지) → 직원마다 `minutes = days × 그 직원의 하루 근무시간 + hours × 60` (일괄 부여도 직원마다 따로 계산). 둘 다 0이면 400. 직원·종류가 있어야 하고, 새로 만들 때 종류는 활성이어야 함.
- `source = overtime` 인 부여는 수정·삭제 → 409 `시간외근무 신청서로 적립된 부여는 시간외근무 화면에서 수정하세요.`
- 수정으로 직원을 바꿀 수 없음 → 400 `부여 내역의 직원은 바꿀 수 없습니다. 삭제 후 새로 추가하세요.`

## 기존 잔여량 (`routes/openingBalances.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/opening-balances?year=&employeeId=` | | `OpeningBalance[]` |
| PUT | `/api/opening-balances` | `openingBalanceInput` | `OpeningBalance` (직원·종류·연도 기준 upsert) |
| DELETE | `/api/opening-balances/:id` | | 204 |

- `totalGrantedMinutes`는 분(10분 단위, 화면이 그 직원의 1일 기준으로 환산). `usedMinutes = totalGrantedMinutes − remainingMinutes`. 잔여가 총 부여보다 크면 400.

## 설정 (`routes/settings.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | `settingsInput` | `Settings` |

- 근무시간 기본값(`defaultWorkStart`·`defaultWorkEnd`, 기본 09:00~18:00)만 있음. 둘을 함께 보내야 하고 직원 근무시간과 같은 규칙으로 검사. 아무 항목도 없으면 400 `바꿀 설정이 없습니다.`
- 시간외근무 적립 종류는 설정에 없음 (신청서에서 대상자마다 고름, 아래 시간외근무 신청서 참고).

## 구분 (`routes/categories.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/categories` | | `Category[]` (표시 순서, 이름순) |
| POST | `/api/categories` | `categoryInput` `{ name, socialServiceAgent, sortOrder }` | 201 `Category` |
| PUT | `/api/categories/:id` | `categoryInput` | `Category` |
| DELETE | `/api/categories/:id` | | 204 |

- 소속과 같은 규칙: 이름 중복 409, 이름을 바꾸면 직원(`employees.category`, 영구 삭제된 직원 포함)과 휴가 종류 적용 대상(`target.categories`)도 함께, 그 구분인 직원(영구 삭제 제외)이 있거나 적용 대상으로 쓰이면 삭제 409.
- `socialServiceAgent`: 이 구분인 직원의 `Employee.isSocialServiceAgent`(저장하지 않고 조회 때 계산) → 사회복무요원 특별휴가·특별휴가(시상) 신청서 대상.
- 직원 저장 시 `category`는 빈 값이거나 구분 목록에 있어야 함 (수정 시 원래 구분 유지는 허용) → 아니면 400.

## 소속 (`routes/departments.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/departments` | | `Department[]` (표시 순서, 이름순) |
| POST | `/api/departments` | `departmentInput` | 201 `Department` |
| PUT | `/api/departments/:id` | `departmentInput` | `Department` |
| DELETE | `/api/departments/:id` | | 204 |

- 이름 중복 → 409. 이름을 바꾸면 그 소속인 직원(`employees.department`)도 함께 바뀜 (휴가원의 신청 시점 소속은 그대로).
- 휴가 종류 적용 대상(`target.departments`)의 소속 이름도 함께 바뀜.
- 그 소속인 직원(비활성 포함, 영구 삭제 제외)이 있거나 휴가 종류 적용 대상으로 쓰이면 삭제 → 409.
- 직원 저장 시 소속은 빈 값이거나 소속 목록에 있어야 함 (수정 시 원래 소속을 그대로 두는 것은 허용) → 아니면 400.

## 잔여 (`routes/balances.ts`)

- GET `/api/balances?employeeId=&year=` → `BalanceRow[]` (활성 종류, 표시 순서)
- 기존 잔여량 입력이 있는 (종류, 연도)는 **기준일자까지(당일 포함)의 부여·사용이 총 부여량·기존 사용량에 이미 들어 있으므로**, 그 해 부여 내역은 기준일자 뒤의 것만, 휴가원 사용은 기준일자 뒤 날짜의 사용만 더한다 (`computeBalances`, 날짜별 사용 `BalanceUsage.byDate`). 기준일자에 걸친 항목은 뒤쪽 날짜만 반영.
- `getEmployeeBalances(..., { extraUsage })`로 아직 저장하지 않은 사용을 더할 때는 `minutesByYear`와 함께 `byDate`(계산 결과의 날짜별 사용)도 넘겨야 같은 기준일자 규칙이 적용된다.
- 저장된 휴가원의 날짜별 사용은 **저장할 때 계산해 둔 값**(`leave_request_items.minutes_by_date`, `{"2026-10-06": 480}`)을 쓴다. 사용 시간·연도별과 함께 저장·수정·복구·공휴일 재계산 때만 바뀌므로, 지난 날짜의 공휴일·휴무일을 나중에 바꿔도(지난 휴가는 다시 계산하지 않음) 잔여(정한 날짜 소멸·부여 후 기간 소멸·기준일자 나누기)와 부재자가 휴가원의 사용 시간과 어긋나지 않는다.

---

## 휴가원 (`routes/leaveRequests.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/leave-requests?employeeId=&status=active\|cancelled\|all&from=&to=` | | `LeaveRequest[]` (첫 항목 시작 내림차순). status 기본 active. from/to는 항목 기간이 겹치는 것 |
| GET | `/api/leave-requests/:id` | | `LeaveRequest` |
| POST | `/api/leave-requests/preview` | `leavePreviewInput` | `LeavePreview` |
| POST | `/api/leave-requests` | `leaveRequestInput` | 201 `LeaveSaveResult` |
| PUT | `/api/leave-requests/:id` | `leaveRequestInput` + `baseUpdatedAt` | `LeaveSaveResult` |
| POST | `/api/leave-requests/:id/cancel` | | `LeaveSaveResult` (warnings 빈 배열) |
| POST | `/api/leave-requests/:id/restore` | | `LeaveSaveResult` |
| POST | `/api/leave-requests/:id/delete` | | 204 (영구 삭제: 취소된 휴가원 또는 영구 삭제된 직원의 휴가원, 아니면 409. 지우기 직전 `pre-delete` 백업, 출력 기록 삭제, 더 이상 가리키는 문서가 없는 삭제된 직원·종류 번호 정리) |
| GET | `/api/leave-requests/:id/print-data` | | `LeavePrintData` (기록 안 함, 미리보기) |
| POST | `/api/leave-requests/:id/print` | | `LeavePrintData` (출력 기록 + 변경 이력) |

저장 규칙:
- `reason`(휴가사유)·`emergencyContact`(비상연락처)는 필수 (앞뒤 공백을 빼고 비면 400 `휴가사유를 입력하세요.` / `비상연락처를 입력하세요.`). `handoverNote`는 비워도 됨.
- 항목마다 `validateLeaveRange(start, end, 직원 현재 근무일정)` 통과해야 함 (400. 연도 2000~2100, 항목 하나의 기간 366일 이내 포함). 사용 시간은 `computeItemUsage`, 0분이면 400 `선택한 기간에 휴가로 계산되는 근무시간이 없습니다.`
- 새로 만들 때 직원·종류는 활성이어야 함. 수정 시에는 그 휴가원에 이미 있던 비활성 종류는 허용.
- `appliedOn = ctx.today()`, 성명·소속·근무 요일·근무시간을 신청 시점 값으로 저장. **수정하면 근무 요일·근무시간을 수정 시점 값으로 다시 저장**(성명·소속·신청일자는 유지).
- 취소된 휴가원 수정 → 409. 수정 창을 연 뒤 다른 사람이 먼저 저장했으면(`baseUpdatedAt` ≠ `updatedAt`) 409. 취소는 상태만 `cancelled` + `cancelled_at`. 복구는 `active`로 돌리고 저장된 근무일정으로 사용 시간 재계산.
- 경고(저장은 허용): `over_balance`(차감 종류 잔여가 음수가 되는 연도. 누적 종류는 이미 기록이 있는 뒤 연도도 확인), `overlap_existing`(같은 직원의 다른 신청 상태 휴가원과 시간 겹침), `overlap_items`(같은 휴가원 항목끼리 겹침).
- preview: 항목 오류는 던지지 않고 `items[i].error`에 메시지. `balancesBefore` = 이 신청 반영 전(수정 중이면 그 휴가원 제외), `balancesAfter` = 반영 후. 연도는 첫 항목 시작 연도(없으면 올해).
- 다시 출력 필요: `needsReprint(r)` = 신청 상태이고 `updatedAt > lastPrintedAt` (출력 뒤 수정·복구). 출력은 `updatedAt`을 바꾸지 않고, 공휴일·휴무일 재계산(`recalcFutureRequests`)도 `updatedAt`을 바꾸지 않으므로 해당 없음.
- 출력: 취소된 휴가원 → 409. `submitDate = ctx.today()`. `year` = 첫 항목 시작 연도. `balanceTable` = `checkboxes`와 같은 종류(차감 여부 무관, 표시 순서), 각 행의 `currentMinutes` = 이 휴가원의 그 연도 사용분, `usedMinutes` = 누적사용(금회 포함), `remainingMinutes` = 부여 − 누적사용. 차감 안 하는 종류는 `grantedMinutes`·`remainingMinutes` = null (양식에서 빈칸). `checkboxes` = 그 직원에게 적용되거나 기록이 있는 활성 종류(차감 여부 무관, 표시 순서. `hideWhenEmpty` 소진 종류는 `remainingMinutes` ≤ 0이면 뺌) + 이번에 사용한 종류(비활성·영구 삭제 포함), `checked` = 이번에 사용. `approvalRoles` = 출력할 때의 직원 결재칸 (영구 삭제된 직원도 남은 값).

## 달력·부재자 (`routes/calendar.ts`)

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD&includeCancelled=1` | `CalendarEvent[]` (항목 단위, [from, to] 날짜와 겹치는 것, 휴가원에 저장된 근무 일정 포함. `department`·`category` = 직원의 지금 소속·구분, 화면 필터용) |
| GET | `/api/absences?date=YYYY-MM-DD` | `Absences` (date 기본 오늘. today = 그날 사용 시간이 있는 항목, week = 그 주 월~일) |

---

## 시간외근무 신청서 (`routes/overtime.ts`)

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

---

## 공휴일·휴무일 (`routes/holidays.ts`, `services/holidays.ts`)

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

## 사용 현황·변경 이력 (`routes/usage.ts`, `routes/auditLogs.ts`)

- GET `/api/usage?year=` → `UsageReport` (활성 직원 + 그 해 기록이 있는 비활성 직원, 활성 휴가 종류)
- GET `/api/audit-logs?from=&to=&entity=&employeeId=&action=&page=1&pageSize=50` → `AuditLogPage` (최근순). `employeeId`는 대상이 여러 명인 시간외근무 신청서 이력(employee_id 없음)도 현재 대상 또는 변경 전·후 `targets`에 그 직원이 있으면 찾음

---

## 시스템 (`routes/system.ts`, `services/backup.ts`, `services/updater.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/system/info` | | `SystemInfo` |
| POST | `/api/system/update/check` | | `UpdateCheckResult` |
| POST | `/api/system/update/apply` | | `{ message }` 후 재시작(종료 코드 75) |
| GET | `/api/backups` | | `BackupFile[]` (최근순, 로컬 + NAS) |
| POST | `/api/backups` | | 201 `BackupFile` (지금 백업) |
| POST | `/api/backups/restore` | `{ name, location }` | `{ message }` 후 재시작(종료 코드 76) |
| GET | `/api/export.xlsx` | | 엑셀 파일 다운로드 |
| POST | `/api/export/table.xlsx` | `tableExportInput` `{ title, subtitle, head, body }` | 화면 표(잔여 현황·사용 현황)를 그대로 엑셀로. 1줄 제목, 2줄 부제목, 3줄부터 머리글(`head` 칸의 `colSpan`·`rowSpan` → 셀 병합)과 본문(문자열). 머리글·첫 열 고정, A4 가로·너비 한 장, 머리글 줄 반복 인쇄 |

### 배포 구조와 자동 업데이트

```
C:\leave-flow\              ← 설치 폴더 (LEAVE_FLOW_HOME)
  node\node.exe            ← 전용 포터블 Node 24 (PC의 다른 Node·Python과 무관)
  launcher.mjs             ← 서비스가 실행하는 프로그램. 서버를 띄우고 감시
  versions\0.1.0\server.mjs, web\ …
  state.json               ← {"current":"0.1.0","previous":null,"pending":null, ...}
  config.json              ← 포트, NAS 백업 폴더, 업데이트 저장소 등 (config.ts 참고)
  data\leave-flow.db       ← DB (+ restore-pending.db: 복구 대기)
  backups\                 ← 로컬 백업
  logs\                    ← 서버 로그 (launcher가 기록)
  updates\                 ← 내려받은 업데이트 파일
```

- 릴리스 자산: `leave-flow-<버전>.zip`(안에 `server.mjs`, `web/`, `launcher.mjs`, `scripts/`) + `leave-flow-<버전>.zip.sha256`. GitHub 태그 `v<버전>`.
- 서버(updater): `https://api.github.com/repos/<repo>/releases/latest` 확인 → 새 버전이면 zip·sha256 다운로드 → SHA-256 확인 → **DB 백업** → `versions/<버전>/`에 압축 해제(경로 탈출 방지) → `state.json`의 `pending` 기록 → 종료 코드 75.
- launcher: 종료 코드 75면 `pending`을 `current`로 바꾸고(이전 값은 `previous`) 새 버전 실행 → 60초 안에 `/api/health`의 version이 새 버전이 아니면 `previous`로 되돌리고 실패 기록. 종료 코드 76(백업 복구)은 그냥 재시작. 그 밖의 비정상 종료는 잠시 뒤 재시작. 0이면 launcher도 종료.
- 백업 복구: 지금 DB를 백업 → 고를 백업을 `data/restore-pending.db`로 복사 → 종료 코드 76 → 서버 시작 시 `applyPendingRestore(config)`가 DB를 바꿔 끼움(index.ts에서 DB 열기 전에 호출).
- 개발 실행(`APP_VERSION === "dev"`)이나 `updateRepo`가 없으면 업데이트 기능은 꺼짐.
- 새 버전 확인은 `autoUpdate=false`여도 주기적으로 함 (`autoUpdate`는 자동 설치 여부만 정함). `updateCheckHours`는 1~576으로 보정.
- `state.json`의 `failedVersion`은 되돌린 버전(설치 스크립트로 낮은 버전을 다시 설치한 경우 포함) → 자동 업데이트에서 건너뜀. launcher의 시험 기동 확인은 `config.host`(0.0.0.0·:: 이면 127.0.0.1) 사용.
