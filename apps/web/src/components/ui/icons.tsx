// 공통 아이콘 (색은 글자색을 따름). 글자 화살표는 Windows에서 그림 문자로 보일 수 있어 SVG 사용

const CHEVRON = { up: "M4 10l4-4 4 4", down: "M4 6l4 4 4-4", right: "M6 4l4 4-4 4" };

/** 오늘로 돌아가기 (U턴 화살표) */
export function ReturnIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3L3 6l3 3M3 6h6.5a3.5 3.5 0 0 1 0 7H7" />
    </svg>
  );
}

export function ChevronIcon({ dir, size = 16 }: { dir: "up" | "down" | "right"; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={CHEVRON[dir]} />
    </svg>
  );
}

/** 취소된 휴가 (달력에 ×) */
export function CalendarXIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3M6.2 8.7l3.6 3.6M9.8 8.7l-3.6 3.6" />
    </svg>
  );
}

/** 보임 / 숨김(off: 눈에 빗금) */
export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 2.5l11 11" />}
    </svg>
  );
}

/** 옆 패널 열고 닫기 (side 쪽에 칸막이) */
export function SidebarIcon({ side }: { side: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d={side === "left" ? "M6 3v10" : "M10 3v10"} />
    </svg>
  );
}
