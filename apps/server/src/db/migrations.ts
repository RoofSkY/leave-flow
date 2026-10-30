// DB 구조 변경은 여기에 버전을 하나씩 추가한다. 이미 배포된 버전의 SQL은 절대 수정하지 않는다.
// 시각은 시간대 없는 로컬 문자열("YYYY-MM-DD", "HH:MM", "YYYY-MM-DDTHH:MM"),
// 기록용 일시(created_at 등)는 로컬 "YYYY-MM-DD HH:MM:SS".
// 처음 설치 시 모든 테이블은 비어 있다 (휴가 종류도 미리 넣지 않음). 법정공휴일만 서버 시작 시 자동 등록.

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
-- 영구 삭제(deleted = 1): 휴가원·시간외근무 신청서가 가리키고 있어 행을 지울 수 없을 때 번호만 남김.
-- 직원은 이름·연락처를 비우고, 휴가 종류는 휴가원 항목에 보일 이름만 남김. 어디에도 나오지 않음
CREATE TABLE employees (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  department        TEXT    NOT NULL DEFAULT '',
  category          TEXT    NOT NULL DEFAULT '',
  color             TEXT    NOT NULL DEFAULT '#4f7cff',
  work_days         TEXT    NOT NULL DEFAULT '[1,2,3,4,5]', -- JSON 배열, 0=일 … 6=토
  work_start        TEXT    NOT NULL DEFAULT '09:00',
  work_end          TEXT    NOT NULL DEFAULT '18:00',
  emergency_contact TEXT    NOT NULL DEFAULT '',
  approval_roles    TEXT    NOT NULL DEFAULT '["담당","센터장"]', -- 휴가원 결재칸 JSON 배열 (담당·팀장·센터장·대표 중)
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  deleted           INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

-- 소속·구분 목록 (관리 > 설정에서 추가·수정). 직원·휴가원·적용 대상에는 이름(문자열)을 그대로 저장
CREATE TABLE departments (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE categories (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT    NOT NULL UNIQUE,
  social_service_agent INTEGER NOT NULL DEFAULT 0 CHECK (social_service_agent IN (0, 1)), -- 사회복무요원 특별휴가 대상
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

-- 관리 이름(name)은 활성 종류끼리 겹치면 안 되지만 표시 이름은 겹쳐도 됨 (예: 연차(직원)·연차(강사) → 둘 다 "연차")
CREATE TABLE leave_types (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  display_name       TEXT    NOT NULL DEFAULT '',  -- 휴가원 작성·양식·목록·달력에 보이는 이름 (빈 값 = 관리 이름)
  deducts            INTEGER NOT NULL DEFAULT 1 CHECK (deducts IN (0, 1)),   -- 잔여에서 차감 여부
  balance_mode       TEXT    NOT NULL
                     CHECK (balance_mode IN ('yearly', 'cumulative', 'expire_date', 'grant_period', 'used_up')),
  expire_month       INTEGER CHECK (expire_month BETWEEN 1 AND 12),        -- expire_date: 소멸일 월
  expire_day         INTEGER CHECK (expire_day BETWEEN 1 AND 31),          -- expire_date: 소멸일 일
  valid_months       INTEGER CHECK (valid_months BETWEEN 1 AND 120),       -- grant_period: 부여일부터 쓸 수 있는 개월 수
  -- used_up(소진): 잔여가 0 이하인 직원의 휴가원 작성 목록·휴가원 양식에서 숨김. 다른 방식은 0
  hide_when_empty    INTEGER NOT NULL DEFAULT 0 CHECK (hide_when_empty IN (0, 1)),
  target_departments TEXT    NOT NULL DEFAULT '[]', -- 적용 대상 소속 이름 JSON 배열
  target_categories  TEXT    NOT NULL DEFAULT '[]', -- 적용 대상 구분 이름 JSON 배열
  sort_order         INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  deleted            INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

-- 적용 대상으로 고른 직원
CREATE TABLE leave_type_employees (
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  PRIMARY KEY (leave_type_id, employee_id)
) WITHOUT ROWID;

CREATE TABLE overtime_requests (
  id              INTEGER PRIMARY KEY,
  -- general = 일반, soldier = 사회복무요원 특별휴가, award = 사회복무요원 특별휴가(시상)
  kind            TEXT    NOT NULL CHECK (kind IN ('general', 'soldier', 'award')),
  work_start_at   TEXT,                       -- 일반: 근무 시작일시
  work_end_at     TEXT,                       -- 일반: 근무 종료일시
  minutes         INTEGER,                    -- 일반: 금일발생(분, 대상 전원 동일)
  cumulative_note TEXT    NOT NULL DEFAULT '',-- 일반: 누적 (선택, 출력 안 함)
  category        TEXT    NOT NULL CHECK (category IN ('official_event', 'special_work', 'special_leave', 'award')),
  work_details    TEXT    NOT NULL DEFAULT '',
  paid_on         TEXT,                       -- 요원·시상: 지급일자
  submitted_on    TEXT,                       -- 일반: 제출일 = 처음 출력한 날 (NULL = 미제출·미적립)
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_at    TEXT,
  last_printed_at TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE overtime_targets (
  id                  INTEGER PRIMARY KEY,
  overtime_request_id INTEGER NOT NULL REFERENCES overtime_requests(id) ON DELETE CASCADE,
  employee_id         INTEGER NOT NULL REFERENCES employees(id),
  employee_name       TEXT    NOT NULL,       -- 작성 시점 값
  minutes             INTEGER NOT NULL,       -- 적립량(분). 요원 = 일수 × 그 요원의 하루 근무시간
  days                INTEGER,                -- 요원: 발생 일수
  month               INTEGER,                -- 요원: 발생 월
  leave_type_id       INTEGER REFERENCES leave_types(id), -- 적립한 휴가 종류 (처음 적립할 때 기록)
  sort_order          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX overtime_targets_request ON overtime_targets (overtime_request_id);

-- 부여 내역 (분 단위). source = overtime 이면 시간외근무 신청서가 관리 (직접 수정·삭제 불가)
CREATE TABLE leave_grants (
  id                  INTEGER PRIMARY KEY,
  employee_id         INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id       INTEGER NOT NULL REFERENCES leave_types(id),
  grant_date          TEXT    NOT NULL,
  minutes             INTEGER NOT NULL,
  note                TEXT    NOT NULL DEFAULT '',
  source              TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'overtime')),
  overtime_request_id INTEGER REFERENCES overtime_requests(id) ON DELETE CASCADE,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK ((source = 'overtime') = (overtime_request_id IS NOT NULL))
);
CREATE INDEX leave_grants_employee ON leave_grants (employee_id, leave_type_id, grant_date);
CREATE INDEX leave_grants_overtime ON leave_grants (overtime_request_id);

-- 도입 시 기존 잔여량. 총 부여량은 부여로, (총 부여량 − 현재 잔여량)은 기존 사용량으로 반영
CREATE TABLE opening_balances (
  id                    INTEGER PRIMARY KEY,
  employee_id           INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id         INTEGER NOT NULL REFERENCES leave_types(id),
  year                  INTEGER NOT NULL,
  base_date             TEXT    NOT NULL,
  total_granted_minutes INTEGER NOT NULL,     -- 총 부여량(분)
  remaining_minutes     INTEGER NOT NULL,     -- 입력 당시 잔여(분)
  used_minutes          INTEGER NOT NULL,     -- 기존 사용량(분)
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  UNIQUE (employee_id, leave_type_id, year)
);

CREATE TABLE leave_requests (
  id                INTEGER PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  employee_name     TEXT    NOT NULL,         -- 신청 시점 값
  department        TEXT    NOT NULL,         -- 신청 시점 값
  applied_on        TEXT    NOT NULL,         -- 신청일자
  work_days         TEXT    NOT NULL,         -- 신청(수정) 시점 근무 요일 JSON (재계산 기준)
  work_start        TEXT    NOT NULL,
  work_end          TEXT    NOT NULL,
  reason            TEXT    NOT NULL DEFAULT '',
  emergency_contact TEXT    NOT NULL DEFAULT '',
  handover_note     TEXT    NOT NULL DEFAULT '',
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_at      TEXT,
  last_printed_at   TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX leave_requests_employee ON leave_requests (employee_id, status);

-- 휴가원 항목: 한 휴가원에 여러 종류를 섞을 수 있음
CREATE TABLE leave_request_items (
  id              INTEGER PRIMARY KEY,
  request_id      INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  leave_type_id   INTEGER NOT NULL REFERENCES leave_types(id),
  start_at        TEXT    NOT NULL,
  end_at          TEXT    NOT NULL,
  minutes         INTEGER NOT NULL,           -- 계산된 사용 시간(분)
  minutes_by_year TEXT    NOT NULL DEFAULT '{}', -- JSON {"2026": 480}
  -- 날짜별 사용 시간(분) JSON {"2026-10-06": 480}. 저장할 때 계산해 두고 잔여(정한 날짜 소멸·부여 후 기간 소멸·
  -- 기존 잔여 기준일자 나누기)와 부재자가 씀. 지난 날짜의 공휴일·휴무일이 바뀌어도 사용 시간과 잔여가 어긋나지 않게
  minutes_by_date TEXT    NOT NULL DEFAULT '{}',
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX leave_request_items_request ON leave_request_items (request_id);
CREATE INDEX leave_request_items_range ON leave_request_items (start_at, end_at);

-- 출력 기록 (휴가원·시간외근무 신청서 공통)
CREATE TABLE print_logs (
  id         INTEGER PRIMARY KEY,
  doc_type   TEXT    NOT NULL CHECK (doc_type IN ('leave', 'overtime')),
  doc_id     INTEGER NOT NULL,
  printed_at TEXT    NOT NULL
);
CREATE INDEX print_logs_doc ON print_logs (doc_type, doc_id);

-- 법정공휴일(public) + 센터 휴무일(center). source: auto = 라이브러리 자동 등록, manual = 관리자 입력
CREATE TABLE holidays (
  id         INTEGER PRIMARY KEY,
  date       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('public', 'center')),
  source     TEXT    NOT NULL CHECK (source IN ('auto', 'manual')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), -- 자동 등록분을 지우면 0 (재등록 방지)
  created_at TEXT    NOT NULL,
  UNIQUE (date, kind, name)
);
CREATE INDEX holidays_date ON holidays (date, active);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY,
  at          TEXT    NOT NULL,
  ip          TEXT    NOT NULL DEFAULT '',
  entity      TEXT    NOT NULL,
  entity_id   INTEGER,
  employee_id INTEGER,                        -- 관련 직원 (필터용)
  action      TEXT    NOT NULL,
  summary     TEXT    NOT NULL DEFAULT '',    -- 사람이 읽는 한 줄 설명
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX audit_logs_at ON audit_logs (at);
CREATE INDEX audit_logs_entity ON audit_logs (entity, entity_id);
CREATE INDEX audit_logs_employee ON audit_logs (employee_id);

-- 설정·시스템 값 (key → JSON)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
