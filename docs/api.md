# API

화면(`apps/web`)과 서버(`apps/server/src/routes`)가 주고받는 API입니다. 응답 타입은 `packages/shared/src/types.ts`, 입력 검사는 `packages/shared/src/schemas.ts`가 기준입니다.

## 공통 규칙

- 모든 API는 `/api` 아래 JSON입니다. 날짜 `YYYY-MM-DD`, 일시 `YYYY-MM-DDTHH:MM`, 기록 일시 `YYYY-MM-DD HH:MM:SS` (모두 로컬 시각, 2000~2100년).
- 시간 양은 모두 **분** 단위 정수입니다. 1일 = 그 직원의 하루 근무시간 (`dayMinutesOf`, 점심 제외).
- 오류는 `{ "error": "화면에 그대로 보여 줄 한국어 메시지" }`입니다. 400 입력 오류, 404 없음, 409 상태상 불가(취소된 문서 수정 등).
- 생성은 201, 삭제는 204입니다 (공휴일 삭제는 재계산 결과와 함께 200).
- 휴가원·시간외근무 신청서 수정(PUT)은 수정 창을 열 때의 `updatedAt`을 `baseUpdatedAt`으로 보냅니다. 그 사이 다른 사람이 저장했으면 409, 없으면 400.
- 로그인이 없으므로 `app.ts`의 `checkApiRequest`가 요청을 먼저 검사합니다.
  - Host가 IP 주소·`localhost`·이 PC 이름·`allowedHosts`가 아니면 403
  - GET 외 요청의 `Origin`이 Host와 다르면 403
  - POST·PUT·PATCH 본문은 JSON만 받음 (415). 백업 파일 올리기만 `application/octet-stream`
- 서버 코드: 데이터 변경은 `transaction()` 안에서 `writeAudit()`(변경 이력)과 함께 하고, 오늘·지금은 `ctx.today()`·`ctx.now()`를 씁니다. 휴가 종류 이름에 의존하는 코드는 쓰지 않습니다 (처음 설치 시 종류는 0개).
- 화면 코드: 휴가·부여·잔여에 영향을 주는 변경 뒤에는 `invalidateLeaveData()`를 부릅니다.

## 경로

| 영역              | 경로                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 상태              | `GET /api/health` → `{ ok, version }`                                                                                                                                                                             |
| 직원              | `GET /api/employees?includeInactive&includeDeleted`, `POST /api/employees`, `PUT /api/employees/:id`, `POST …/:id/deactivate`·`/activate`, `GET …/:id/delete-check`, `POST …/:id/delete` (`{ confirmName }`)    |
| 휴가 종류         | `GET /api/leave-types?includeInactive`, `POST`, `PUT …/:id`, `POST …/:id/deactivate`·`/activate`, `GET …/:id/delete-check`, `POST …/:id/delete`                                                                  |
| 부여 내역         | `GET /api/grants?employeeId&leaveTypeId&year`, `POST /api/grants`, `POST /api/grants/bulk`, `PUT …/:id`, `DELETE …/:id`                                                                                          |
| 기존 잔여량       | `GET /api/opening-balances?year&employeeId`, `PUT /api/opening-balances` (직원·종류·연도로 저장), `DELETE …/:id`                                                                                                  |
| 잔여              | `GET /api/balances?employeeId&year` → `BalanceRow[]`                                                                                                                                                              |
| 휴가원            | `GET /api/leave-requests?employeeId&department&category&status&from&to&limit&offset`, `GET …/:id`, `POST …/preview`, `POST /api/leave-requests`, `PUT …/:id`, `POST …/:id/cancel`·`/restore`·`/delete`, `GET …/:id/print-data`, `POST …/:id/print` |
| 달력·부재자       | `GET /api/calendar/events?from&to&includeCancelled`, `GET /api/absences?date`                                                                                                                                     |
| 시간외근무 신청서 | `GET /api/overtime?kind&status&year`, `POST /api/overtime`, `PUT …/:id`, `POST …/:id/cancel`·`/restore`, `GET …/:id/print-data`, `POST …/:id/print`                                                              |
| 공휴일·휴무일     | `GET /api/holidays?from&to&includeInactive`, `POST /api/holidays`, `DELETE …/:id`, `POST …/:id/restore`                                                                                                          |
| 설정·소속·구분    | `GET`·`PUT /api/settings`, `/api/departments`·`/api/categories` (`GET`, `POST`, `PUT …/:id`, `DELETE …/:id`)                                                                                                      |
| 사용 현황·이력    | `GET /api/usage?year`, `GET /api/audit-logs?from&to&entity&employeeId&action&page&pageSize`                                                                                                                       |
| 시스템            | `GET /api/system/info`, `POST /api/system/update/check`·`/apply`, `PUT /api/system/nas-backup-dir`, `GET`·`POST /api/backups`, `POST /api/backups/restore`, `POST /api/backups/upload?name`, `GET /api/export.xlsx`, `POST /api/export/table.xlsx` |

## 핵심 규칙

- **휴가원**: 휴가사유·비상연락처는 필수입니다. 잔여 초과·기간 겹침은 경고만 하고 저장합니다. 잔여는 그 휴가원보다 먼저 낸 휴가원까지만 셉니다 (뒤에 낸 휴가원이 앞 휴가원의 잔여를 바꾸지 않음). 미차감(`noDeduct`)은 잔여에서 빼지 않고, 항목의 `manualMinutes`는 직접 입력한 사용 시간입니다.
- **시간외근무**: 적립할 휴가 종류는 대상자마다 고릅니다(`leaveTypeId`). 일반은 처음 출력할 때, 사회복무요원·시상은 저장할 때 부여 내역으로 적립하고, 취소하면 회수합니다. 적립된 부여는 부여 내역 API로 고칠 수 없습니다 (409).
- **공휴일·휴무일**: 추가·삭제·되살리기 뒤 아직 끝나지 않은 휴가원을 다시 계산해 `recalculated`로 돌려줍니다. 공휴일은 직접 추가만 하며, `source='auto'`는 예전 버전이 자동 등록한 행입니다 (지우면 숨김, 되살리기 가능).
- **휴가 종류**: 기록이 있으면 잔여 방식을 바꿀 수 없습니다 (409). 한 직원에게 보이는 이름이 같은 종류가 둘 이상 적용되면 409.
- **영구 삭제**: 비활성인 직원·휴가 종류, 취소된 휴가원(삭제된 직원의 휴가원은 상태와 관계없이)만 지울 수 있습니다. 기록이 있으면 `confirmName`이 이름과 같아야 하고, 지우기 직전에 `pre-delete` 백업을 만듭니다.
- **복구**: `restore`·`upload` 모두 지금 데이터를 백업한 뒤 서버를 다시 시작합니다 (종료 코드 76). leave-flow DB가 아니거나 더 새 버전의 DB면 400.
