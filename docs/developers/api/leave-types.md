# 휴가 종류 (`routes/leaveTypes.ts`)

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

공통 규칙은 [API](index.md)를 보세요.
