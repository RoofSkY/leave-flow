import { Button } from "../ui/index.tsx";

/**
 * 이 화면이 열려 있을 때만 적용되는 인쇄 규칙: A4 가로, 메뉴·도구줄 숨김, 표 전체가 나오게 스크롤·고정 칸 해제.
 * 휴가원 양식의 A4 세로 @page 보다 뒤에 있어 이 화면에서는 가로가 이김
 */
const PRINT_CSS = `
@page { size: A4 landscape; margin: 10mm; }
.report-print-header { display: none; }
@media print {
  html, body, #root, .app { height: auto !important; background: #fff; }
  .app-main { overflow: visible !important; }
  .topbar, .admin-nav, .page-header, .no-print, .toast-stack { display: none !important; }
  .admin { display: block; }
  .page { max-width: none; padding: 0; }
  .table-wrap { overflow: visible !important; border: none; }
  .table th, .table td { position: static !important; }
  .report-print-header { display: block; margin-bottom: 8px; color: #000; }
  .report-print-header h1 { margin: 0; font-size: 15pt; }
  .report-print-header p { margin: 2px 0 0; font-size: 9pt; }
}
`;

/** 잔여 현황·사용 현황의 [인쇄]. disabled: 불러오는 중·빈 표 */
export function ReportActions({ disabled }: { disabled: boolean }) {
  return (
    <>
      <style>{PRINT_CSS}</style>
      <Button onClick={() => window.print()} disabled={disabled}>
        인쇄
      </Button>
    </>
  );
}

/** 인쇄할 때만 보이는 제목 (화면의 머리글 대신) */
export function ReportPrintHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="report-print-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}
