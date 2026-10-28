import { Link, NavLink, Outlet } from "react-router";
import "./layout.css";

export function AppLayout() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/calendar" className="brand">
          <span className="brand-mark" aria-hidden />
          휴가원 관리
        </Link>
        <nav className="row" style={{ gap: 2 }}>
          <NavLink to="/calendar" className="nav-link">
            달력
          </NavLink>
          <NavLink to="/leave-requests" className="nav-link">
            휴가원 목록
          </NavLink>
          <NavLink to="/balances" className="nav-link">
            잔여 현황
          </NavLink>
          <NavLink to="/overtime" className="nav-link">
            시간외근무
          </NavLink>
          <NavLink to="/admin" className="nav-link">
            관리
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

const ADMIN_MENU: { group: string; items: { to: string; label: string }[] }[] = [
  {
    group: "기준 정보",
    items: [
      { to: "/admin/employees", label: "직원" },
      { to: "/admin/leave-types", label: "휴가 종류" },
      { to: "/admin/grants", label: "부여 내역" },
      { to: "/admin/opening-balances", label: "기존 잔여량" },
      { to: "/admin/holidays", label: "공휴일·휴무일" },
      { to: "/admin/settings", label: "설정" },
    ],
  },
  {
    group: "조회",
    items: [
      { to: "/admin/usage", label: "사용 현황" },
      { to: "/admin/audit-logs", label: "변경 이력" },
    ],
  },
  {
    group: "시스템",
    items: [{ to: "/admin/system", label: "백업·업데이트" }],
  },
];

export function AdminLayout() {
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="관리 메뉴">
        {ADMIN_MENU.map((g) => (
          <div key={g.group} style={{ display: "contents" }}>
            <div className="admin-nav-group">{g.group}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} className="nav-link">
                {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="admin-content">
        <div className="page">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
