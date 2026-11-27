import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AbsencePanel } from "../components/leave/AbsencePanel.tsx";
import { MonthCalendar } from "../components/form/DatePicker.tsx";
import { CalendarFilterPanel, NOTHING_HIDDEN, type FilterItem } from "../components/leave/CalendarFilter.tsx";
import { FilterLeaveList } from "../components/leave/FilterLeaveList.tsx";
import { SidebarIcon } from "../components/ui/icons.tsx";
import { LeaveCalendar, ShortcutGuide, type CalendarFocus, type EditorPrefill } from "../components/leave/LeaveCalendar.tsx";
import { LeaveDetailModal } from "../components/leave/LeaveDetailModal.tsx";
import { LeaveEditor, type EditorTarget } from "../components/leave/LeaveEditor.tsx";
import { Button } from "../components/ui/index.tsx";
import { localToday } from "../lib/format.ts";
import { qk } from "../lib/queries.ts";

const NARROW = "(max-width: 960px)";
const isNarrow = () => window.matchMedia(NARROW).matches;

function PanelClose({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="sm" icon className="lf-side-close" title="패널 닫기" aria-label="패널 닫기" onClick={onClose}>
      ✕
    </Button>
  );
}

/** 메인 화면: 왼쪽 축소판·필터 + 휴가 달력 + 오른쪽 단축키·부재자 */
export function CalendarPage() {
  const [editor, setEditor] = useState<{ key: number; target: EditorTarget } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  // 달력만 거름 (부재자 패널은 항상 전체)
  const [hidden, setHidden] = useState(NOTHING_HIDDEN);
  // 필터에서 이름을 누른 항목: 왼쪽 패널 옆에 그 휴가원 목록 (달력 위에 겹쳐 뜸)
  // 닫을 때는 들어가는 애니메이션이 끝난 뒤에 뗌
  const [listItem, setListItem] = useState<FilterItem | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const openList = useCallback((item: FilterItem | null) => {
    if (item) setListItem(item);
    setListOpen(item !== null);
  }, []);
  const [leftOpen, setLeftOpen] = useState(() => !isNarrow());
  const [rightOpen, setRightOpen] = useState(() => !isNarrow());
  const [focus, setFocus] = useState<CalendarFocus | null>(null);
  // 달력 제목의 달. 축소판이 따라가되 축소판만 따로 넘겨 볼 수도 있음
  const [viewMonth, setViewMonth] = useState(() => localToday().slice(0, 7));
  const [miniMonth, setMiniMonth] = useState(viewMonth);
  const editorSeq = useRef(0);
  const focusSeq = useRef(0);
  const qc = useQueryClient();

  useEffect(() => setMiniMonth(viewMonth), [viewMonth]);

  const openEditor = useCallback((target: EditorTarget) => {
    setDetailId(null);
    setEditor({ key: ++editorSeq.current, target });
  }, []);
  const onCreate = useCallback((prefill: EditorPrefill) => openEditor({ mode: "create", prefill }), [openEditor]);
  const onOpenRequest = useCallback((id: number) => {
    setDetailId(id);
    // 좁은 화면에서는 패널이 달력을 가리므로 닫음
    if (isNarrow()) setRightOpen(false);
  }, []);
  const onFocusClear = useCallback(() => setFocus(null), []);
  const pickDate = (date: string) => {
    setFocus({ date, seq: ++focusSeq.current });
    if (isNarrow()) setLeftOpen(false);
  };

  return (
    <div className="lf-cal-page">
      {leftOpen && (
        <aside className="lf-side is-left" aria-label="날짜 이동·필터">
          <PanelClose onClose={() => setLeftOpen(false)} />
          <MonthCalendar
            className="lf-mini"
            mini
            // ↩: 축소판만 이번 달로 (큰 달력은 그대로)
            onToday={() => setMiniMonth(localToday().slice(0, 7))}
            month={miniMonth}
            onMonthChange={setMiniMonth}
            // 고른 날은 축소판에 표시하지 않음 (큰 달력 칸만 잠깐 강조)
            selected={null}
            onPick={pickDate}
          />
          <CalendarFilterPanel
            hidden={hidden}
            onChange={setHidden}
            showCancelled={showCancelled}
            onShowCancelledChange={setShowCancelled}
            openItem={listOpen ? listItem : null}
            onOpenItem={openList}
          />
        </aside>
      )}
      {leftOpen && listItem && (
        <FilterLeaveList
          item={listItem}
          closing={!listOpen}
          onClosed={() => setListItem(null)}
          showCancelled={showCancelled}
          onClose={() => openList(null)}
          onOpenRequest={onOpenRequest}
        />
      )}
      <LeaveCalendar
        showCancelled={showCancelled}
        hidden={hidden}
        focus={focus}
        onFocusClear={onFocusClear}
        onMonthChange={setViewMonth}
        onCreate={onCreate}
        onOpenRequest={onOpenRequest}
        headerStart={
          <Button
            variant="ghost"
            icon
            title="왼쪽 패널 (날짜 이동·필터)"
            aria-label="왼쪽 패널"
            aria-pressed={leftOpen}
            onClick={() => setLeftOpen((v) => !v)}
          >
            <SidebarIcon side="left" />
          </Button>
        }
        actions={
          <Button variant="primary" onClick={() => openEditor({ mode: "create" })}>
            휴가원 작성
          </Button>
        }
        headerEnd={
          <Button
            variant="ghost"
            icon
            title="오른쪽 패널 (단축키·부재자)"
            aria-label="오른쪽 패널"
            aria-pressed={rightOpen}
            onClick={() => setRightOpen((v) => !v)}
          >
            <SidebarIcon side="right" />
          </Button>
        }
      />
      {rightOpen && (
        <aside className="lf-side is-right" aria-label="단축키·부재자">
          <PanelClose onClose={() => setRightOpen(false)} />
          <ShortcutGuide />
          <AbsencePanel onOpenRequest={onOpenRequest} />
        </aside>
      )}

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
