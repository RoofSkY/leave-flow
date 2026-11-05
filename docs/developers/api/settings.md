# 설정 (`routes/settings.ts`)

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | `settingsInput` | `Settings` |

- 근무시간 기본값(`defaultWorkStart`·`defaultWorkEnd`, 기본 09:00~18:00)만 있음. 둘을 함께 보내야 하고 직원 근무시간과 같은 규칙으로 검사. 아무 항목도 없으면 400 `바꿀 설정이 없습니다.`
- 시간외근무 적립 종류는 설정에 없음 (신청서에서 대상자마다 고름, [시간외근무 신청서](overtime.md) 참고).

공통 규칙은 [API](index.md)를 보세요.
