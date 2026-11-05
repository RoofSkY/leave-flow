# 구분 (`routes/categories.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/categories` | | `Category[]` (표시 순서, 이름순) |
| POST | `/api/categories` | `categoryInput` `{ name, socialServiceAgent, sortOrder }` | 201 `Category` |
| PUT | `/api/categories/:id` | `categoryInput` | `Category` |
| DELETE | `/api/categories/:id` | | 204 |

- 소속과 같은 규칙: 이름 중복 409, 이름을 바꾸면 직원(`employees.category`, 영구 삭제된 직원 포함)과 휴가 종류 적용 대상(`target.categories`)도 함께, 그 구분인 직원(영구 삭제 제외)이 있거나 적용 대상으로 쓰이면 삭제 409.
- `socialServiceAgent`: 이 구분인 직원의 `Employee.isSocialServiceAgent`(저장하지 않고 조회 때 계산) → 사회복무요원 특별휴가·특별휴가(시상) 신청서 대상.
- 직원 저장 시 `category`는 빈 값이거나 구분 목록에 있어야 함 (수정 시 원래 구분 유지는 허용) → 아니면 400.

공통 규칙은 [API](index.md)를 보세요.
