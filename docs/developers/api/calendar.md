# 달력·부재자 (`routes/calendar.ts`)

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD&includeCancelled=1` | `CalendarEvent[]` (항목 단위, [from, to] 날짜와 겹치는 것, 휴가원에 저장된 근무 일정 포함. `department`·`category` = 직원의 지금 소속·구분, 화면 필터용) |
| GET | `/api/absences?date=YYYY-MM-DD` | `Absences` (date 기본 오늘. today = 그날 사용 시간이 있는 항목, week = 그 주 월~일) |

공통 규칙은 [API](index.md)를 보세요.
