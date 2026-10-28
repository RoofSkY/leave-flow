import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button, useToast } from "../ui/index.tsx";
import { errorMessage } from "../../lib/api.ts";
import "./print.css";

/**
 * A4 출력 화면 틀.
 * onBeforePrint: 인쇄 직전에 호출 (출력일시 기록·적립 등). 실패하면 인쇄하지 않음, false 를 돌려주면 조용히 그만둠.
 * [인쇄] 버튼(또는 Ctrl+P)으로 기록한 뒤에만 양식이 인쇄되고,
 * 브라우저 메뉴로 바로 인쇄하면 양식 대신 안내문이 인쇄됨 (기록·제출 없이 출력되는 것을 막음).
 */
export function PrintShell({
  title,
  onBeforePrint,
  toolbarExtra,
  children,
}: {
  title: string;
  onBeforePrint: () => Promise<void | boolean>;
  toolbarExtra?: ReactNode;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  // 기록 없이 인쇄해도 되는 상태 (방금 기록을 마침)
  const [armed, setArmed] = useState(false);
  const toast = useToast();
  const busyRef = useRef(false);

  const print = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if ((await onBeforePrint()) === false) return;
      flushSync(() => setArmed(true));
      // 기록 후 화면이 갱신될 시간을 준 뒤 인쇄
      await new Promise((r) => setTimeout(r, 50));
      window.print();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const printRef = useRef(print);
  printRef.current = print;

  useEffect(() => {
    // 인쇄가 끝나면 다시 잠금 (다음 인쇄도 기록을 거치도록)
    const onAfterPrint = () => setArmed(false);
    // Ctrl+P 도 [인쇄] 버튼과 같은 과정으로 (한글 입력 상태에서도 잡히도록 e.code 도 확인)
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (String(e.key).toLowerCase() !== "p" && e.code !== "KeyP")) return;
      e.preventDefault();
      void printRef.current();
    };
    window.addEventListener("afterprint", onAfterPrint);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("afterprint", onAfterPrint);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return (
    <div className={armed ? "print-root print-armed" : "print-root"}>
      <div className="print-toolbar">
        <Button onClick={() => (window.history.length > 1 ? window.history.back() : window.close())}>← 돌아가기</Button>
        <strong style={{ marginLeft: 8 }}>{title}</strong>
        <span className="spacer" />
        {toolbarExtra}
        <Button variant="primary" onClick={print} disabled={busy}>
          {busy ? "준비 중…" : "인쇄"}
        </Button>
      </div>
      <div className="print-blocked">상단의 [인쇄] 버튼으로 출력하세요. (출력 기록·제출을 위해 필요합니다)</div>
      {children}
    </div>
  );
}

/** A4 한 장 */
export function PrintSheet({ children }: { children: ReactNode }) {
  return <div className="print-sheet">{children}</div>;
}

/** 결재란 — 항상 빈 칸. roles 기본값은 시간외근무 양식의 담당 / 팀장 / 센터장 (휴가원은 직원마다 고른 칸) */
export function ApprovalBox({ roles = ["담 당", "팀 장", "센터장"] }: { roles?: string[] }) {
  return (
    <table className="approval">
      <tbody>
        <tr>
          <td className="approval-head" rowSpan={2}>
            결<br />
            <br />재
          </td>
          {roles.map((role) => (
            <th key={role}>{role}</th>
          ))}
        </tr>
        <tr>
          {roles.map((role) => (
            <td key={role} className="sign" />
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/** 하단 로고 (원본 양식의 이미지) */
export function DocFooterLogo() {
  return (
    <div className="doc-footer">
      <img src="/logo.jpg" alt="(사)난치병아동돕기운동본부 희망세움터" />
    </div>
  );
}

/** 체크박스 표시: √ 또는 □ (▢는 Windows에서 컬러 이모지로 보여 □ 사용) */
export function DocCheck({ checked, label }: { checked: boolean; label: string }) {
  return (
    <span>
      {checked ? "√" : "□"}
      {label}
    </span>
  );
}
