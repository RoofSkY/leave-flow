# 휴가원 (`routes/leaveRequests.ts`)

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
- `reason`(휴가사유)·`emergencyContact`(비상연락처)는 필수 (앞뒤 공백을 빼고 비면 400 `휴가사유를 입력하세요.` / `비상연락처를 입력하세요.`). `handoverNote`는 비워도 됨. `noDeduct`(미차감, 기본 false): true면 이 휴가원의 사용은 잔여 계산(`getEmployeeBalances`)·다른 휴가원의 잔여 초과 확인에서 빠지고, 이 휴가원 저장·복구 때 `over_balance` 경고도 없음.
- 항목마다 `validateLeaveRange(start, end, 직원 현재 근무일정)` 통과해야 함 (400. 연도 2000~2100, 항목 하나의 기간 366일 이내 포함). 사용 시간은 `computeItemUsage`, 0분이면 400 `선택한 기간에 휴가로 계산되는 근무시간이 없습니다.`
- 새로 만들 때 직원·종류는 활성이어야 함. 수정 시에는 그 휴가원에 이미 있던 비활성 종류는 허용.
- `appliedOn = ctx.today()`, 성명·소속·근무 요일·근무시간을 신청 시점 값으로 저장. **수정하면 근무 요일·근무시간을 수정 시점 값으로 다시 저장**(성명·소속·신청일자는 유지).
- 취소된 휴가원 수정 → 409. 수정 창을 연 뒤 다른 사람이 먼저 저장했으면(`baseUpdatedAt` ≠ `updatedAt`) 409. 취소는 상태만 `cancelled` + `cancelled_at`. 복구는 `active`로 돌리고 저장된 근무일정으로 사용 시간 재계산.
- 낸 순서 기준 잔여: `over_balance`·preview 잔여·출력 휴가현황은 그 휴가원보다 먼저 낸(번호가 작은) 신청 상태 휴가원만 사용량에 넣음 (`getEmployeeBalances`의 `upToRequestId`. 출력은 자기 자신 포함, 수정·복구는 자기 자신 제외). 새로 낼 때는 기존 휴가원이 모두 먼저라 전체와 같음. `overlap_existing`과 잔여 현황·사용 현황은 전체.
- 경고(저장은 허용): `over_balance`(차감 종류 잔여가 음수가 되는 연도. 누적 종류는 이미 기록이 있는 뒤 연도도 확인), `overlap_existing`(같은 직원의 다른 신청 상태 휴가원과 시간 겹침), `overlap_items`(같은 휴가원 항목끼리 겹침).
- preview: 항목 오류는 던지지 않고 `items[i].error`에 메시지. `balancesBefore` = 이 신청 반영 전(수정 중이면 그 휴가원과 그 뒤에 낸 휴가원 제외), `balancesAfter` = 반영 후 (`noDeduct: true`면 `balancesBefore`와 같고 `over_balance` 없음). 연도는 첫 항목 시작 연도(없으면 올해).
- 다시 출력 필요: `needsReprint(r)` = 신청 상태이고 `updatedAt > lastPrintedAt` (출력 뒤 수정·복구). 출력은 `updatedAt`을 바꾸지 않고, 공휴일·휴무일 재계산(`recalcFutureRequests`)도 `updatedAt`을 바꾸지 않으므로 해당 없음.
- 출력: 취소된 휴가원 → 409. `submitDate = ctx.today()`. `year` = 첫 항목 시작 연도. `balanceTable` = `checkboxes`와 같은 종류(차감 여부 무관, 표시 순서), 각 행의 `currentMinutes` = 이 휴가원의 그 연도 사용분(미차감 휴가원은 0), `usedMinutes` = 누적사용(금회 포함, 이 휴가원까지 낸 휴가원만), `remainingMinutes` = 부여 − 누적사용. 차감 안 하는 종류는 `grantedMinutes`·`remainingMinutes` = null (양식에서 빈칸). `checkboxes` = 그 직원에게 적용되거나 기록이 있는 활성 종류(차감 여부 무관, 표시 순서. `hideWhenEmpty` 소진 종류는 `remainingMinutes` ≤ 0이면 뺌) + 이번에 사용한 종류(비활성·영구 삭제 포함), `checked` = 이번에 사용. `approvalRoles` = 출력할 때의 직원 결재칸 (영구 삭제된 직원도 남은 값).

공통 규칙은 [API](index.md)를 보세요.
