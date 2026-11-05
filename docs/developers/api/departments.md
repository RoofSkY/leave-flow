# 소속 (`routes/departments.ts`)

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

공통 규칙은 [API](index.md)를 보세요.
