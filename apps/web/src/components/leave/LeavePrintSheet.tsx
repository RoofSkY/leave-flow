import { dayMinutesOf, formatDotDate, formatLeaveMinutes, formatPeriod, type LeavePrintData } from "@leave-flow/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { ApprovalBox, DocCheck, DocFooterLogo, PrintSheet } from "../print/PrintShell.tsx";
import { requestPeriods } from "./leaveQueries.ts";
import "./leavePrint.css";


/** CSS 1in = 96px = 25.4mm */
const PX_PER_MM = 96 / 25.4;
const A4_HEIGHT_PX = 297 * PX_PER_MM;

/** 표 아래 끝과 로고 사이 간격 */
const FOOTER_GAP_MM = 4;
/** 업무인계 상자 기본 높이 (원본 32.5mm) */
const BOX_MM = 32;

/**
 * 한 장에 맞추는 단계: 0 재기 → 1 남는 공간만큼 상세내용 칸을 늘리거나 넘친 만큼 업무인계 칸을 줄임,
 * 그래도 넘치면 2 글자·줄 간격·행 높이를 줄여 다시 재기 → 3 같은 방법으로 맞춤
 */
const MAX_FIT_LEVEL = 3;

/** 원본 HWP 표의 열 너비 비율(%). 휴가현황의 연도·종류·총휴가일 … 칸과 윗줄 칸 경계를 맞추려고 9열 */
const COLUMNS = [11.9, 7.5, 9.3, 10.2, 14.5, 14.5, 2.4, 12.1, 17.6];

/**
 * 표 아래 끝부터 표가 내려올 수 있는 곳(종이 아래 여백·로고·간격 위)까지 남은 높이(px). 음수면 넘침
 */
function roomBelow(table: HTMLElement): number {
  const sheet = table.closest<HTMLElement>(".print-sheet");
  const footer = sheet?.lastElementChild;
  if (!sheet || !(footer instanceof HTMLElement)) return 0;
  const limit =
    sheet.getBoundingClientRect().top +
    A4_HEIGHT_PX -
    parseFloat(getComputedStyle(sheet).paddingBottom) -
    footer.offsetHeight -
    FOOTER_GAP_MM * PX_PER_MM;
  return limit - table.getBoundingClientRect().bottom;
}

/** 결재칸 이름: 두 글자는 원본처럼 띄어 씀 (담당 → 담 당) */
const roleLabel = (role: string) => (role.length === 2 ? `${role[0]} ${role[1]}` : role);

/** "13일 5시간 30분": 칸이 좁으면 "13일" / "5시간 30분" 사이에서만 줄바꿈 */
function DocAmount({ minutes, dayMinutes }: { minutes: number; dayMinutes: number }) {
  const text = formatLeaveMinutes(minutes, dayMinutes);
  const cut = text.indexOf("일 ");
  if (cut < 0) return <span>{text}</span>;
  return (
    <>
      <span>{text.slice(0, cut + 1)}</span> <span>{text.slice(cut + 2)}</span>
    </>
  );
}

/**
 * 휴가원 양식 (A4 한 장, 원본: .dev/2026 휴가원 양식.hwp).
 * 원본처럼 표가 아래 로고 위까지 오도록 상세내용 칸을 늘리고, 내용이 넘치면 업무인계 칸 → 글자·줄 간격 순서로 줄임.
 * 그래도 넘치면 onOverflow(true)로 알림 (그때는 잘리지 않고 다음 장으로 이어서 출력).
 */
export function LeavePrintSheet({
  data,
  onOverflow,
}: {
  data: LeavePrintData;
  onOverflow?: (overflow: boolean) => void;
}) {
  const { request: r, year, balanceTable, checkboxes } = data;
  // 1일 = 휴가원에 저장된 근무시간 기준
  const dayMinutes = dayMinutesOf(r);
  const tableRef = useRef<HTMLTableElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [fitData, setFitData] = useState(data);
  const [level, setLevel] = useState(0);
  /** 재는 단계(0, 2)는 기본 크기로 그림 */
  const measuring = level % 2 === 0;
  /** 1·3단계에서 정한 상세내용 칸 높이(px)와 업무인계 칸 최소 높이(mm) */
  const [fit, setFit] = useState({ detailPx: 0, boxMm: BOX_MM });
  const [overflow, setOverflow] = useState(false);
  // 데이터가 바뀌면 기본 크기부터 다시 맞춤
  if (fitData !== data) {
    setFitData(data);
    setLevel(0);
    setFit({ detailPx: 0, boxMm: BOX_MM });
    setOverflow(false);
  }

  // 그려진 뒤(화면에 보이기 전) 남는 공간을 재고 한 단계씩 맞춤
  useLayoutEffect(() => {
    const table = tableRef.current;
    const detail = detailRef.current;
    if (!table || !detail) return;
    const room = roomBelow(table);
    if (measuring) {
      // 남으면 그만큼 상세내용 칸을 늘리고, 모자라면 그만큼 업무인계 칸을 줄임
      // (표 행 높이는 px 단위로 반올림되므로 1mm 덜 늘림)
      setFit({
        detailPx: Math.max(0, detail.getBoundingClientRect().height + room - PX_PER_MM),
        boxMm: Math.max(0, Math.min(BOX_MM, BOX_MM + room / PX_PER_MM)),
      });
      setLevel(level + 1);
      return;
    }
    const over = room < -1;
    if (over && level < MAX_FIT_LEVEL) {
      setLevel(level + 1);
      return;
    }
    setOverflow(over);
    onOverflow?.(over);
  }, [data, level, measuring, onOverflow]);

  // 이어지는 항목은 한 구간으로. 구간이 많으면 휴가기간을 두 줄씩
  const periods = requestPeriods(r);
  const twoColumns = periods.length > 4;
  const boxMm = measuring ? BOX_MM : fit.boxMm;

  return (
    <PrintSheet>
      <div className="doc-caption">
        [{year}휴가원 – 희망세움터 / {r.department}]
      </div>
      <h1 className={["doc-title lf-doc-title", level >= 2 && "is-compact"].filter(Boolean).join(" ")}>휴가원</h1>
      <ApprovalBox roles={data.approvalRoles.map(roleLabel)} />

      <table
        ref={tableRef}
        className={["doc-table lf-doc", level >= 2 && "is-compact", overflow && "is-overflow"]
          .filter(Boolean)
          .join(" ")}
      >
        <colgroup>
          {COLUMNS.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <tbody>
          <tr className="lf-doc-row-name">
            <th>성&emsp;&emsp;명</th>
            <td colSpan={3} className="lf-doc-name">
              {r.employeeName}&emsp;(인)
            </td>
            <th colSpan={3}>제출일자</th>
            <td colSpan={2} className="lf-doc-small">
              {formatDotDate(data.submitDate).replace(/\.$/, "")}
            </td>
          </tr>
          <tr>
            <th>휴가기간</th>
            <td colSpan={8} className="lf-doc-periods">
              <div className={twoColumns ? "lf-doc-periods-grid" : undefined}>
                {periods.map((p) => (
                  <div key={p.key}>{formatPeriod(p.startAt, p.endAt).replace(" ~ ", "~")}</div>
                ))}
              </div>
            </td>
          </tr>
          <tr className="lf-doc-balance-head">
            <th rowSpan={balanceTable.length + 1}>휴가현황</th>
            <th className="lf-doc-year">연도</th>
            <th colSpan={2}>총휴가일</th>
            <th>금회사용일</th>
            <th>누적사용일</th>
            <th colSpan={2}>잔여일</th>
            <th>비고</th>
          </tr>
          {balanceTable.map((b, idx) => (
            <tr key={b.leaveTypeId} className="lf-doc-balance-row">
              {idx === 0 && (
                <th rowSpan={balanceTable.length} className="lf-doc-year">
                  {year}
                </th>
              )}
              <td className="lf-doc-type">{b.name}</td>
              <td className="lf-doc-amount">
                {b.grantedMinutes !== null && <DocAmount minutes={b.grantedMinutes} dayMinutes={dayMinutes} />}
              </td>
              {/* 금회사용: 이번에 쓴 종류만 */}
              <td className="lf-doc-amount">
                {b.currentMinutes > 0 && <DocAmount minutes={b.currentMinutes} dayMinutes={dayMinutes} />}
              </td>
              <td className="lf-doc-amount">
                <DocAmount minutes={b.usedMinutes} dayMinutes={dayMinutes} />
              </td>
              <td colSpan={2} className="lf-doc-amount">
                {b.remainingMinutes !== null && <DocAmount minutes={b.remainingMinutes} dayMinutes={dayMinutes} />}
              </td>
              <td />
            </tr>
          ))}
          <tr>
            <th className="lf-doc-detail-head">상세내용</th>
            <td colSpan={8} className="lf-doc-detail">
              <div ref={detailRef} style={measuring ? undefined : { minHeight: fit.detailPx }}>
                <div className="doc-check-hint">(해당 부분에 √체크해 주세요.)</div>
                <div className="doc-checks">
                  {checkboxes.map((c) => (
                    <DocCheck key={c.leaveTypeId} checked={c.checked} label={c.name} />
                  ))}
                </div>
                <div className="lf-doc-line">① 휴가사유: {r.reason}</div>
                <div className="lf-doc-line">② 비상연락: {r.emergencyContact}</div>
                <div className="lf-doc-line">
                  ③ 업무인계 및 기타사항<span className="lf-doc-faint">(해당사항 있을 시 기재)</span>
                </div>
                <div className="doc-box lf-doc-box" style={{ minHeight: `${boxMm}mm` }}>
                  {r.handoverNote}
                </div>
                <div className="doc-closing">상기와 같이 휴가원을 제출합니다.</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <DocFooterLogo />
    </PrintSheet>
  );
}
