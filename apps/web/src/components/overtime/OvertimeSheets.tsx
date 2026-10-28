// 시간외근무 신청서 A4 양식 (원본 HWP 양식 재현). 표는 CSS grid 로 그려 상세내용 칸이 남은 높이를 채움 → 항상 한 장.
import {
  SOLDIER_FORM_DEPARTMENT,
  formatHoursMinutes,
  formatPeriod,
  type OvertimeCategory,
  type OvertimePrintData,
} from "@leave-flow/shared";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApprovalBox, DocCheck, DocFooterLogo, PrintSheet } from "../print/PrintShell.tsx";
import { dotDate, targetDays } from "./labels.ts";
import "./overtimePrint.css";

function Cell({
  col,
  row,
  head,
  className,
  children,
}: {
  col: string;
  row: string;
  head?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={["otp-cell", head && "otp-head", className].filter(Boolean).join(" ")}
      style={{ gridColumn: col, gridRow: row }}
    >
      {children}
    </div>
  );
}

/** 근무내역 점선 상자. 글이 넘치면 아래 빈 공간까지 늘리고, 그래도 넘치면 글자를 조금씩 줄여 칸 안에 맞춤 */
function WorkDetailsBox({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const overflows = () => el.scrollHeight > el.clientHeight + 1;
    let size = 9.5;
    el.style.fontSize = `${size}pt`;
    el.style.flexGrow = "0";
    if (overflows()) el.style.flexGrow = "1";
    while (overflows() && size > 6.5) {
      size -= 0.5;
      el.style.fontSize = `${size}pt`;
    }
    setClipped(overflows());
  }, [text]);
  return (
    <>
      <div ref={ref} className="doc-box otp-box">
        {text}
      </div>
      {clipped && <div className="otp-clipped">근무내역이 길어 일부가 인쇄되지 않습니다. 내용을 줄여 주세요.</div>}
    </>
  );
}

function DetailBody({
  category,
  options,
  text,
  closing,
}: {
  category: OvertimeCategory;
  options: readonly [OvertimeCategory, string][];
  text: string;
  closing: string;
}) {
  return (
    <>
      <div className="doc-check-hint">(해당 부분에 √체크해 주세요.)</div>
      <div className="doc-checks otp-checks">
        {options.map(([c, label]) => (
          <DocCheck key={c} checked={category === c} label={label} />
        ))}
      </div>
      <div className="otp-label">● 근무내역</div>
      <WorkDetailsBox text={text} />
      <div className="doc-closing otp-closing">{closing}</div>
    </>
  );
}

/** 일반 시간외근무 신청서. 누적은 출력하지 않음 */
export function GeneralOvertimeSheet({ data }: { data: OvertimePrintData }) {
  const r = data.request;
  return (
    <PrintSheet>
      <div className="otp">
        <div className="doc-caption">[{data.year}시간외근무신청서]</div>
        <h1 className="doc-title otp-title">시간외 근무 신청서</h1>
        <ApprovalBox />
        <div className="otp-grid otp-general">
          <Cell col="1" row="1" head>
            성&emsp;&emsp;명
          </Cell>
          <Cell col="2 / span 4" row="1">
            {r.targets.map((t) => t.employeeName).join(", ")}
          </Cell>
          <Cell col="1" row="2" head>
            근무시간
          </Cell>
          <Cell col="2 / span 2" row="2">
            {r.workStartAt && r.workEndAt ? formatPeriod(r.workStartAt, r.workEndAt) : ""}
          </Cell>
          <Cell col="4" row="2" head>
            제출일자
          </Cell>
          <Cell col="5" row="2">
            {dotDate(data.submitDate)}
          </Cell>
          <Cell col="1" row="3 / span 2" head>
            대체휴가
            <br />
            발생현황
          </Cell>
          <Cell col="2" row="3" className="otp-strong">
            {data.year}년도
          </Cell>
          <Cell col="3 / span 3" row="3" className="otp-small otp-strong">
            금일발생
          </Cell>
          <Cell col="2" row="4" className="otp-strong">
            대체휴가
          </Cell>
          <Cell col="3 / span 3" row="4" className="otp-small">
            {formatHoursMinutes(r.minutes ?? 0)}
          </Cell>
          <Cell col="1" row="5" head>
            상세내용
          </Cell>
          <Cell col="2 / span 4" row="5" className="otp-detail">
            <DetailBody
              category={r.category}
              options={[
                ["official_event", " 공식행사"],
                ["special_work", " 특별근무"],
              ]}
              text={r.workDetails}
              closing="상기와 같이 시간 외 근무를 신청합니다."
            />
          </Cell>
        </div>
      </div>
      <DocFooterLogo />
    </PrintSheet>
  );
}

/** 요원·시상 양식에서 다른 글자 (배치는 같음) */
const AGENT_FORM = {
  soldier: {
    title: "시간외 근무 신청서(특별휴가/요원)",
    leaveName: "특별휴가 지급",
    accrualName: "대체휴가",
    options: [
      ["official_event", "공식행사"],
      ["special_leave", "특별휴가"],
    ],
  },
  award: {
    title: "시간외 근무 신청서(특별휴가/시상)",
    leaveName: "시상 특별휴가 지급",
    accrualName: "시상휴가",
    options: [["award", "시상"]],
  },
} satisfies Record<"soldier" | "award", { title: string; leaveName: string; accrualName: string; options: [OvertimeCategory, string][] }>;

/** 사회복무요원 특별휴가·특별휴가(시상) 신청서 */
export function SoldierOvertimeSheet({ data }: { data: OvertimePrintData }) {
  const r = data.request;
  const form = AGENT_FORM[r.kind === "award" ? "award" : "soldier"];
  const paidOn = r.paidOn ?? data.submitDate;
  const lines = r.targets.map((t) => `${t.employeeName} – ${targetDays(t)}일`);
  return (
    <PrintSheet>
      <div className="otp">
        <div className="doc-caption">[{data.year} 시간외근무신청서]</div>
        <h1 className="doc-title otp-title otp-title-soldier">{form.title}</h1>
        <ApprovalBox />
        <div className="otp-grid otp-soldier">
          <Cell col="1" row="1" head className="otp-spaced">
            휴 가 명
          </Cell>
          <Cell col="2 / span 2" row="1">
            사회복지시설 근무기관
            <br />
            {form.leaveName}
            <br />({paidOn.slice(5, 7)}월 {paidOn.slice(8, 10)}일)
          </Cell>
          <Cell col="4" row="1" head className="otp-spaced">
            부 서 명
          </Cell>
          <Cell col="5" row="1" className="otp-small">
            {SOLDIER_FORM_DEPARTMENT}
          </Cell>
          <Cell col="1" row="2" head>
            근무시간
          </Cell>
          <Cell col="2 / span 4" row="2" className="otp-lines">
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </Cell>
          <Cell col="1" row="3 / span 2" head>
            {form.accrualName}
            <br />
            발생현황
          </Cell>
          <Cell col="2" row="3 / span 2" className="otp-strong">
            {data.year}년도
            <br />
            {form.accrualName}
          </Cell>
          <Cell col="3 / span 2" row="3" className="otp-small otp-strong">
            금일발생
          </Cell>
          <Cell col="5" row="3" className="otp-small otp-strong">
            연가현황 담당확인
          </Cell>
          <Cell col="3 / span 2" row="4" className="otp-small otp-lines">
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </Cell>
          <Cell col="5" row="4" className="otp-stamp">
            <span className="doc-stamp">(인)</span>
          </Cell>
          <Cell col="1" row="5" head>
            상세내용
          </Cell>
          <Cell col="2 / span 4" row="5" className="otp-detail">
            <DetailBody
              category={r.category}
              options={form.options}
              text={r.workDetails}
              closing="상기와 같이 시간외 근무를 신청합니다."
            />
          </Cell>
        </div>
      </div>
      <DocFooterLogo />
    </PrintSheet>
  );
}
