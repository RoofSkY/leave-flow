# 직원 (`routes/employees.ts`)

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

공통 규칙은 [API](index.md)를 보세요.
