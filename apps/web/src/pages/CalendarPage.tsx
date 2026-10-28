import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { AbsencePanel } from "../components/leave/AbsencePanel.tsx";
import { EmployeeFilter, NO_FILTER } from "../components/form/EmployeeFilter.tsx";
import { LeaveCalendar, type EditorPrefill } from "../components/leave/LeaveCalendar.tsx";
import { LeaveDetailModal } from "../components/leave/LeaveDetailModal.tsx";
import { LeaveEditor, type EditorTarget } from "../components/leave/LeaveEditor.tsx";
import { Button, Checkbox } from "../components/ui/index.tsx";
import { qk } from "../lib/queries.ts";

const NARROW = "(max-width: 960px)";

/** 메인 화면: 휴가 달력 + 부재자 패널 */
export function CalendarPage() {
  const [editor, setEditor] = useState<{ key: number; target: EditorTarget } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  // 달력만 거름 (부재자 패널은 항상 전체)
  const [filter, setFilter] = useState(NO_FILTER);
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const editorSeq = useRef(0);
  const qc = useQueryClient();

  const openEditor = useCallback((target: EditorTarget) => {
    setDetailId(null);
    setEditor({ key: ++editorSeq.current, target });
  }, []);
  const onCreate = useCallback((prefill: EditorPrefill) => openEditor({ mode: "create", prefill }), [openEditor]);
  const onOpenRequest = useCallback((id: number) => {
    setDetailId(id);
    // 좁은 화면에서는 패널이 달력을 가리므로 닫음
    if (window.matchMedia(NARROW).matches) setPanelOpen(false);
  }, []);

  return (
    <div className="lf-cal-page">
      <LeaveCalendar
        showCancelled={showCancelled}
        filter={filter}
        onCreate={onCreate}
        onOpenRequest={onOpenRequest}
        actions={
          <>
            <EmployeeFilter value={filter} onChange={setFilter} />
            <Checkbox label="취소된 휴가 보기" checked={showCancelled} onChange={setShowCancelled} />
            <Button aria-pressed={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
              부재자
            </Button>
            <Button variant="primary" onClick={() => openEditor({ mode: "create" })}>
              휴가원 작성
            </Button>
          </>
        }
      />
      {panelOpen && <AbsencePanel onOpenRequest={onOpenRequest} onClose={() => setPanelOpen(false)} />}

      {editor && (
        <LeaveEditor
          key={editor.key}
          target={editor.target}
          onClose={() => setEditor(null)}
          onSaved={(request) => {
            setEditor(null);
            qc.setQueryData(qk.leaveRequest(request.id), request);
            // 저장 뒤 상세를 열어 바로 출력할 수 있게
            setDetailId(request.id);
          }}
        />
      )}
      {detailId !== null && (
        <LeaveDetailModal
          requestId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={(request) => openEditor({ mode: "edit", request })}
        />
      )}
    </div>
  );
}
