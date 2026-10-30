// API 입력 검사 (화면과 서버가 같은 규칙을 씀). 오류 메시지는 화면에 그대로 보여주므로 한국어로 작성.
import { z } from "zod";
import { APPROVAL_ROLES, dailyWorkMinutes } from "./leave.ts";
import {
  LEAVE_STEP_MINUTES,
  YEAR_RANGE_MESSAGE,
  isDateString,
  isDateTimeString,
  isInYearRange,
  isTimeString,
  parseTime,
} from "./time.ts";

// 아래 규칙에서 빠진 메시지(형식이 다른 값 등)도 한국어로 나오도록 기본 메시지를 한국어로
z.config(z.locales.ko());

const trimmed = (max: number, label: string) =>
  z.string().trim().max(max, `${label}은(는) ${max}자 이하로 입력하세요.`);

export const dateString = z
  .string()
  .refine(isDateString, "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)")
  .refine(isInYearRange, YEAR_RANGE_MESSAGE);
const timeString = z.string().refine(isTimeString, "시각 형식이 올바르지 않습니다. (HH:MM)");
export const dateTimeString = z
  .string()
  .refine(isDateTimeString, "일시 형식이 올바르지 않습니다. (YYYY-MM-DDTHH:MM)")
  .refine(isInYearRange, YEAR_RANGE_MESSAGE);
const idSchema = z.coerce
  .number({ error: "항목을 선택하세요." })
  .int("항목을 선택하세요.")
  .positive("항목을 선택하세요.");
const colorString = z.string().regex(/^#[0-9a-fA-F]{6}$/, "색상 형식이 올바르지 않습니다. (#RRGGBB)");

/** 10분 단위 시간(분) */
const stepMinutes = (label: string) =>
  z
    .number({ error: `${label}을(를) 숫자로 입력하세요.` })
    .int(`${label}은(는) 10분 단위로 입력하세요.`)
    .min(LEAVE_STEP_MINUTES, `${label}은(는) 10분 이상이어야 합니다.`)
    .refine((v) => v % LEAVE_STEP_MINUTES === 0, `${label}은(는) 10분 단위로 입력하세요.`);

/**
 * 근무시간 검사 (직원 근무시간, 설정의 근무시간 기본값 공통).
 * 시각 형식이 틀리면 각 필드 자체 오류로 알리고 여기서는 건너뜀. 종료 ≤ 시작이면 그 메시지 하나만.
 */
function addWorkHourIssues(
  start: string,
  end: string,
  ctx: z.RefinementCtx,
  startPath: string,
  endPath: string,
): void {
  if (!isTimeString(start) || !isTimeString(end)) return;
  if (parseTime(end) <= parseTime(start)) {
    ctx.addIssue({ code: "custom", message: "근무 종료시각은 시작시각보다 뒤여야 합니다.", path: [endPath] });
    return;
  }
  if (parseTime(start) % LEAVE_STEP_MINUTES !== 0 || parseTime(end) % LEAVE_STEP_MINUTES !== 0) {
    ctx.addIssue({ code: "custom", message: "근무시간은 10분 단위로 입력하세요.", path: [startPath] });
  }
  if (dailyWorkMinutes({ workStart: start, workEnd: end }) <= 0) {
    ctx.addIssue({ code: "custom", message: "점심시간(12:00~13:00)을 빼면 근무시간이 없습니다.", path: [endPath] });
  }
}

export const employeeInput = z
  .object({
    name: trimmed(50, "성명").min(1, "성명을 입력하세요."),
    department: trimmed(50, "소속"),
    color: colorString,
    workDays: z
      .array(
        z
          .number({ error: "근무 요일이 올바르지 않습니다." })
          .int("근무 요일이 올바르지 않습니다.")
          .min(0, "근무 요일이 올바르지 않습니다.")
          .max(6, "근무 요일이 올바르지 않습니다."),
      )
      .min(1, "근무 요일을 하나 이상 선택하세요.")
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    workStart: timeString,
    workEnd: timeString,
    emergencyContact: trimmed(50, "비상연락처"),
    approvalRoles: z
      .array(z.enum(APPROVAL_ROLES, { error: "결재칸이 올바르지 않습니다." }))
      .min(1, "결재칸을 하나 이상 선택하세요.")
      .transform((roles) => APPROVAL_ROLES.filter((r) => roles.includes(r))),
    category: trimmed(30, "구분"),
  })
  .superRefine((v, ctx) => addWorkHourIssues(v.workStart, v.workEnd, ctx, "workStart", "workEnd"));
export type EmployeeInput = z.infer<typeof employeeInput>;

const optionalInt = z.number({ error: "숫자로 입력하세요." }).int("정수로 입력하세요.").nullable().optional();

export const leaveTypeInput = z
  .object({
    name: trimmed(30, "휴가 종류 이름").min(1, "휴가 종류 이름을 입력하세요."),
    /** 표시 이름 (선택, 빈 값 = 이름 그대로) */
    displayName: trimmed(30, "표시 이름").default(""),
    deducts: z.boolean(),
    balanceMode: z.enum(["yearly", "cumulative", "expire_date", "grant_period", "used_up"], {
      error: "잔여 방식을 선택하세요.",
    }),
    /** 정한 날짜 소멸: 소멸일 (월·일) */
    expireMonth: optionalInt,
    expireDay: optionalInt,
    /** 부여 후 기간 소멸: 부여일부터 쓸 수 있는 개월 수 (1~120) */
    validMonths: optionalInt,
    /** 소진: 잔여가 0 이하인 직원의 휴가원 작성 목록·휴가원 양식에서 숨김 (생략하면 숨김) */
    hideWhenEmpty: z.boolean().optional(),
    /** 적용 대상 (규칙은 leaveTypeAppliesTo). null(또는 생략) = 전체 직원 */
    target: z
      .object({
        departments: z
          .array(z.string().trim().min(1).max(30), { error: "소속을 선택하세요." })
          .max(100, "소속이 너무 많습니다.")
          .refine((v) => new Set(v).size === v.length, "같은 소속이 중복 선택되었습니다.")
          .default([]),
        categories: z
          .array(z.string().trim().min(1).max(30), { error: "구분을 선택하세요." })
          .max(100, "구분이 너무 많습니다.")
          .refine((v) => new Set(v).size === v.length, "같은 구분이 중복 선택되었습니다.")
          .default([]),
        employeeIds: z
          .array(idSchema, { error: "직원을 선택하세요." })
          .max(500, "적용 대상 직원이 너무 많습니다.")
          .refine((ids) => new Set(ids).size === ids.length, "같은 직원이 중복 선택되었습니다.")
          .default([]),
      })
      .refine((t) => t.departments.length + t.categories.length + t.employeeIds.length > 0, {
        error: "적용 대상으로 소속·구분·직원 중 하나 이상을 고르세요.",
      })
      .nullish(),
    sortOrder: z
      .number({ error: "표시 순서를 숫자로 입력하세요." })
      .int("표시 순서는 정수로 입력하세요.")
      .min(0, "표시 순서는 0~9999 사이로 입력하세요.")
      .max(9999, "표시 순서는 0~9999 사이로 입력하세요."),
  })
  .superRefine((v, ctx) => {
    if (v.balanceMode === "expire_date") {
      const m = v.expireMonth ?? 0;
      if (m < 1 || m > 12) {
        ctx.addIssue({ code: "custom", message: "소멸일의 월을 1~12로 입력하세요.", path: ["expireMonth"] });
        return;
      }
      const last = new Date(Date.UTC(2000, m, 0)).getUTCDate(); // 2월은 29일까지 (윤년이 아니면 말일로 봄)
      const d = v.expireDay ?? 0;
      if (d < 1 || d > last) {
        ctx.addIssue({ code: "custom", message: `소멸일의 일을 1~${last}로 입력하세요.`, path: ["expireDay"] });
      }
    }
    if (v.balanceMode === "grant_period") {
      const n = v.validMonths ?? 0;
      if (n < 1 || n > 120) {
        ctx.addIssue({ code: "custom", message: "쓸 수 있는 기간을 1~120개월로 입력하세요.", path: ["validMonths"] });
      }
    }
    // 잔여가 있어야 다 썼는지 알 수 있음
    if (v.balanceMode === "used_up" && !v.deducts) {
      ctx.addIssue({
        code: "custom",
        message: "소진은 잔여에서 차감하는 종류만 고를 수 있습니다.",
        path: ["balanceMode"],
      });
    }
  })
  // 방식에 쓰지 않는 값은 비움
  .transform((v) => ({
    ...v,
    expireMonth: v.balanceMode === "expire_date" ? (v.expireMonth ?? null) : null,
    expireDay: v.balanceMode === "expire_date" ? (v.expireDay ?? null) : null,
    validMonths: v.balanceMode === "grant_period" ? (v.validMonths ?? null) : null,
    hideWhenEmpty: v.balanceMode === "used_up" ? (v.hideWhenEmpty ?? true) : false,
    target: v.target
      ? {
          departments: v.target.departments,
          categories: v.target.categories,
          employeeIds: [...v.target.employeeIds].sort((a, b) => a - b),
        }
      : null,
  }));
export type LeaveTypeInput = z.infer<typeof leaveTypeInput>;

/**
 * 관리 화면에서 직접 입력하는 부여량: 일 + 시간.
 * 서버가 직원마다 "1일 = 그 직원의 하루 근무시간"으로 분으로 바꿔 저장한다.
 * 시간은 10분 단위까지 (수정 화면에서 남은 분이 있을 때).
 */
const grantAmountFields = {
  leaveTypeId: idSchema,
  grantDate: dateString,
  days: z
    .number({ error: "부여량(일)을 숫자로 입력하세요." })
    .int("부여량(일)은 정수로 입력하세요.")
    .min(0, "부여량은 0 이상이어야 합니다.")
    .max(9999, "부여량(일)은 9999 이하로 입력하세요."),
  hours: z
    .number({ error: "부여량(시간)을 숫자로 입력하세요." })
    .min(0, "부여량은 0 이상이어야 합니다.")
    .max(99999, "부여량(시간)이 너무 큽니다.")
    .refine((h) => Number.isInteger(Math.round(h * 6 * 1000) / 1000), "부여량(시간)은 10분 단위까지 입력할 수 있습니다."),
  note: trimmed(200, "비고"),
};
const grantAmountPositive = (v: { days: number; hours: number }) => v.days > 0 || v.hours > 0;
const GRANT_AMOUNT_REQUIRED = { error: "부여량을 입력하세요.", path: ["days"] };

export const grantInput = z.object({ employeeId: idSchema, ...grantAmountFields }).refine(grantAmountPositive, GRANT_AMOUNT_REQUIRED);
export type GrantInput = z.infer<typeof grantInput>;

/** 여러 직원에게 같은 부여를 한 번에 (직원마다 그 사람의 1일로 계산) */
export const grantBulkInput = z
  .object({
    employeeIds: z
      .array(idSchema, { error: "직원을 선택하세요." })
      .min(1, "직원을 한 명 이상 선택하세요.")
      .max(200, "한 번에 200명까지 부여할 수 있습니다.")
      .refine((ids) => new Set(ids).size === ids.length, "같은 직원이 중복 선택되었습니다."),
    ...grantAmountFields,
  })
  .refine(grantAmountPositive, GRANT_AMOUNT_REQUIRED);
export type GrantBulkInput = z.infer<typeof grantBulkInput>;

/** 영구 삭제: 기록이 있으면 확인용으로 이름을 그대로 입력 */
export const deleteInput = z.object({
  confirmName: z.string().trim().max(100).default(""),
});

export const openingBalanceInput = z
  .object({
    employeeId: idSchema,
    leaveTypeId: idSchema,
    year: z
      .number({ error: "연도를 숫자로 입력하세요." })
      .int("연도는 2000~2100 사이로 입력하세요.")
      .min(2000, "연도는 2000~2100 사이로 입력하세요.")
      .max(2100, "연도는 2000~2100 사이로 입력하세요."),
    baseDate: dateString,
    /** 올해 총 부여량(분, 10분 단위). 화면에서 그 직원의 1일 기준으로 일·시간을 분으로 바꿔 보냄 */
    totalGrantedMinutes: z
      .number({ error: "총 부여량을 숫자로 입력하세요." })
      .int("총 부여량은 10분 단위로 입력하세요.")
      .min(0, "총 부여량은 0 이상이어야 합니다.")
      .max(9999 * 24 * 60, "총 부여량이 너무 큽니다.")
      .refine((v) => v % LEAVE_STEP_MINUTES === 0, "총 부여량은 10분 단위로 입력하세요."),
    /** 현재 잔여량(분, 10분 단위) */
    remainingMinutes: z
      .number({ error: "잔여량을 숫자로 입력하세요." })
      .int("잔여량은 10분 단위로 입력하세요.")
      .min(0, "잔여량은 0 이상이어야 합니다.")
      .refine((v) => v % LEAVE_STEP_MINUTES === 0, "잔여량은 10분 단위로 입력하세요."),
  })
  .refine((v) => Number(v.baseDate.slice(0, 4)) === v.year, {
    error: "기준일자는 해당 연도 안의 날짜여야 합니다.",
    path: ["baseDate"],
  });
export type OpeningBalanceInput = z.infer<typeof openingBalanceInput>;

/** 설정 저장. 보낸 항목만 바꿈 (화면의 섹션별 저장) */
export const settingsInput = z
  .object({
    /** 직원 추가 시 근무시간 기본값 */
    defaultWorkStart: timeString.optional(),
    defaultWorkEnd: timeString.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.defaultWorkStart === undefined) !== (v.defaultWorkEnd === undefined)) {
      ctx.addIssue({ code: "custom", message: "근무 시작·종료 기본값을 함께 입력하세요.", path: ["defaultWorkEnd"] });
      return;
    }
    if (v.defaultWorkStart !== undefined && v.defaultWorkEnd !== undefined) {
      addWorkHourIssues(v.defaultWorkStart, v.defaultWorkEnd, ctx, "defaultWorkStart", "defaultWorkEnd");
    }
  });

/** NAS 백업 폴더 저장. 빈 값 = NAS 백업 끔 */
export const nasBackupDirInput = z.object({
  nasBackupDir: trimmed(260, "NAS 백업 폴더").refine(
    (v) => v === "" || /^(?:[\\/]{2}[^\\/]+[\\/][^\\/]+|[A-Za-z]:[\\/])/.test(v),
    "NAS 백업 폴더는 \\\\NAS주소\\공유폴더 형식으로 입력하세요.",
  ),
});

export const departmentInput = z.object({
  name: trimmed(50, "소속 이름").min(1, "소속 이름을 입력하세요."),
  sortOrder: z
    .number({ error: "표시 순서를 숫자로 입력하세요." })
    .int("표시 순서는 정수로 입력하세요.")
    .min(0, "표시 순서는 0~9999 사이로 입력하세요.")
    .max(9999, "표시 순서는 0~9999 사이로 입력하세요."),
});

export const categoryInput = z.object({
  name: trimmed(30, "구분 이름").min(1, "구분 이름을 입력하세요."),
  /** 이 구분인 직원이 사회복무요원 특별휴가 신청서의 대상 */
  socialServiceAgent: z.boolean(),
  sortOrder: z
    .number({ error: "표시 순서를 숫자로 입력하세요." })
    .int("표시 순서는 정수로 입력하세요.")
    .min(0, "표시 순서는 0~9999 사이로 입력하세요.")
    .max(9999, "표시 순서는 0~9999 사이로 입력하세요."),
});

const leaveRequestItemInput = z.object({
  leaveTypeId: idSchema,
  startAt: dateTimeString,
  endAt: dateTimeString,
});
export type LeaveRequestItemInput = z.infer<typeof leaveRequestItemInput>;

export const leaveRequestInput = z.object({
  employeeId: idSchema,
  items: z
    .array(leaveRequestItemInput)
    .min(1, "휴가 항목을 하나 이상 추가하세요.")
    .max(20, "휴가 항목은 20개까지 추가할 수 있습니다."),
  reason: trimmed(500, "휴가사유").min(1, "휴가사유를 입력하세요."),
  emergencyContact: trimmed(50, "비상연락처").min(1, "비상연락처를 입력하세요."),
  handoverNote: trimmed(2000, "업무인계 및 기타사항"),
});

/**
 * 수정 저장(휴가원·시간외근무 신청서)에 함께 보내는 값: 수정을 시작할 때 본 문서의 updatedAt.
 * 그 사이 다른 사람이 고쳤으면(updatedAt 이 달라졌으면) 덮어쓰지 않고 거절함
 */
export const editBaseInput = z.object({
  baseUpdatedAt: z
    .string({ error: "수정을 시작한 시점 정보가 없습니다. 창을 닫고 다시 열어 주세요." })
    .min(1, "수정을 시작한 시점 정보가 없습니다. 창을 닫고 다시 열어 주세요."),
});

export const leavePreviewInput = z.object({
  employeeId: idSchema,
  items: z.array(leaveRequestItemInput).max(20, "휴가 항목은 20개까지 추가할 수 있습니다."),
  /** 수정 중인 휴가원 (잔여·겹침 계산에서 제외) */
  excludeRequestId: idSchema.nullable().optional(),
});

/** 시간외근무 적립 휴가 종류 (신청서에서 대상자마다 고름) */
const accrualLeaveTypeId = z.coerce
  .number({ error: "적립할 휴가 종류를 선택하세요." })
  .int("적립할 휴가 종류를 선택하세요.")
  .positive("적립할 휴가 종류를 선택하세요.");

export const overtimeGeneralInput = z
  .object({
    kind: z.literal("general"),
    targets: z
      .array(z.object({ employeeId: idSchema, leaveTypeId: accrualLeaveTypeId }))
      .min(1, "대상 직원을 한 명 이상 선택하세요.")
      .max(50, "대상은 50명까지 선택할 수 있습니다."),
    workStartAt: dateTimeString,
    workEndAt: dateTimeString,
    /** 금일발생(분, 10분 단위, 대상 전원 동일) */
    minutes: stepMinutes("금일발생"),
    cumulativeNote: trimmed(100, "누적"),
    category: z.enum(["official_event", "special_work"], { error: "상세내용을 선택하세요." }),
    workDetails: trimmed(3000, "근무내역"),
  })
  .refine((v) => v.workEndAt > v.workStartAt, {
    error: "근무 종료일시는 시작일시보다 뒤여야 합니다.",
    path: ["workEndAt"],
  })
  .refine((v) => new Set(v.targets.map((t) => t.employeeId)).size === v.targets.length, {
    error: "같은 직원이 중복 선택되었습니다.",
    path: ["targets"],
  });
export type OvertimeGeneralInput = z.infer<typeof overtimeGeneralInput>;

export const overtimeSoldierInput = z
  .object({
    kind: z.literal("soldier"),
    targets: z
      .array(
        z.object({
          employeeId: idSchema,
          leaveTypeId: accrualLeaveTypeId,
          /** 발생 일수 (기본 1) */
          days: z
            .number({ error: "발생 일수를 숫자로 입력하세요." })
            .int("발생 일수는 정수로 입력하세요.")
            .min(1, "발생 일수는 1~31 사이로 입력하세요.")
            .max(31, "발생 일수는 1~31 사이로 입력하세요."),
          /** 발생 월 1~12 */
          month: z
            .number({ error: "발생 월을 숫자로 입력하세요." })
            .int("발생 월은 1~12 사이로 입력하세요.")
            .min(1, "발생 월은 1~12 사이로 입력하세요.")
            .max(12, "발생 월은 1~12 사이로 입력하세요."),
        }),
      )
      .min(1, "대상 요원을 한 명 이상 선택하세요.")
      .max(50, "대상은 50명까지 선택할 수 있습니다."),
    paidOn: dateString,
    category: z.enum(["official_event", "special_leave"], { error: "상세내용을 선택하세요." }),
    workDetails: trimmed(3000, "근무내역"),
  })
  .refine((v) => new Set(v.targets.map((t) => t.employeeId)).size === v.targets.length, {
    error: "같은 요원이 중복 선택되었습니다.",
    path: ["targets"],
  });
export type OvertimeSoldierInput = z.infer<typeof overtimeSoldierInput>;

/** 사회복무요원 특별휴가(시상): 요원 특별휴가와 같고 발생 월이 없음. 상세내용은 시상 하나 */
export const overtimeAwardInput = z
  .object({
    kind: z.literal("award"),
    targets: z
      .array(
        z.object({
          employeeId: idSchema,
          leaveTypeId: accrualLeaveTypeId,
          /** 발생 일수 (기본 1) */
          days: z
            .number({ error: "발생 일수를 숫자로 입력하세요." })
            .int("발생 일수는 정수로 입력하세요.")
            .min(1, "발생 일수는 1~31 사이로 입력하세요.")
            .max(31, "발생 일수는 1~31 사이로 입력하세요."),
        }),
      )
      .min(1, "대상 요원을 한 명 이상 선택하세요.")
      .max(50, "대상은 50명까지 선택할 수 있습니다."),
    paidOn: dateString,
    category: z.literal("award").default("award"),
    workDetails: trimmed(3000, "근무내역"),
  })
  .refine((v) => new Set(v.targets.map((t) => t.employeeId)).size === v.targets.length, {
    error: "같은 요원이 중복 선택되었습니다.",
    path: ["targets"],
  });
export type OvertimeAwardInput = z.infer<typeof overtimeAwardInput>;

const overtimeInput = z.union([overtimeGeneralInput, overtimeSoldierInput, overtimeAwardInput]);
export type OvertimeInput = z.infer<typeof overtimeInput>;

/** 화면 표를 엑셀로 (잔여 현황·사용 현황): 화면에 보이는 그대로 보내면 서버가 .xlsx 로 만듦 */
const tableExportText = z.string().max(1000, "칸 내용이 너무 깁니다.");
export const tableExportInput = z.object({
  /** 첫 줄 제목, 시트 이름 */
  title: trimmed(100, "제목").min(1, "제목을 입력하세요."),
  /** 둘째 줄 (필터·출력일 등) */
  subtitle: trimmed(500, "부제목"),
  /** 머리글 줄들. 칸은 HTML 표처럼 colSpan·rowSpan */
  head: z
    .array(
      z
        .array(
          z.object({
            text: tableExportText,
            colSpan: z.number().int().min(1).max(500).optional(),
            rowSpan: z.number().int().min(1).max(5).optional(),
          }),
        )
        .max(500),
    )
    .min(1)
    .max(5),
  body: z.array(z.array(tableExportText).max(500)).max(5000),
});
export type TableExportInput = z.infer<typeof tableExportInput>;

export const holidayInput = z.object({
  date: dateString,
  name: trimmed(50, "이름").min(1, "이름을 입력하세요."),
  kind: z.enum(["public", "center"], { error: "구분을 선택하세요." }),
});
export type HolidayInput = z.infer<typeof holidayInput>;

/** 사회복무요원 특별휴가 근무내역 기본 문구 */
const SOLDIER_WORK_DETAILS_INTRO =
  "사회복지사업법 제 2조 4호에 따른 사회복지시설에서 근무하는 사회복무요원에게 월 1회 특별휴가 (연10일의) 특별휴가를 부여함.(시행일 25년 2월)";

export function soldierWorkDetails(targets: { name: string; month: number; days: number }[]): string {
  const lines = targets.map((t) => `- ${t.name} ${t.month}월 총 ${t.days}개 발생`);
  return [SOLDIER_WORK_DETAILS_INTRO, "", ...lines].join("\n");
}

/** 사회복무요원 특별휴가(시상) 근무내역 기본 문구 */
export function awardWorkDetails(targets: { name: string; days: number }[]): string {
  return targets.map((t) => `- ${t.name} 시상 특별휴가 ${t.days}일 지급`).join("\n");
}

/** 사회복무요원 특별휴가·특별휴가(시상) 양식 부서명 (고정) */
export const SOLDIER_FORM_DEPARTMENT = "희망세움지역아동센터";
