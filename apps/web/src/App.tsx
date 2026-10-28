import { Navigate, Route, Routes } from "react-router";
import { AdminLayout, AppLayout } from "./layout/AppLayout.tsx";
import { CalendarPage } from "./pages/CalendarPage.tsx";
import { LeaveListPage } from "./pages/LeaveListPage.tsx";
import { BalancesPage } from "./pages/BalancesPage.tsx";
import { AuditLogPage } from "./pages/admin/AuditLogPage.tsx";
import { EmployeesPage } from "./pages/admin/EmployeesPage.tsx";
import { GrantsPage } from "./pages/admin/GrantsPage.tsx";
import { HolidaysPage } from "./pages/admin/HolidaysPage.tsx";
import { LeaveTypesPage } from "./pages/admin/LeaveTypesPage.tsx";
import { OpeningBalancesPage } from "./pages/admin/OpeningBalancesPage.tsx";
import { SettingsPage } from "./pages/admin/SettingsPage.tsx";
import { SystemPage } from "./pages/admin/SystemPage.tsx";
import { UsagePage } from "./pages/admin/UsagePage.tsx";
import { OvertimePage } from "./pages/overtime/OvertimePage.tsx";
import { LeavePrintPage } from "./pages/print/LeavePrintPage.tsx";
import { OvertimePrintPage } from "./pages/print/OvertimePrintPage.tsx";
import { EmptyState } from "./components/ui/index.tsx";

export function App() {
  return (
    <Routes>
      {/* 출력 화면은 메뉴 없이 A4 양식만 */}
      <Route path="/print/leave/:id" element={<LeavePrintPage />} />
      <Route path="/print/overtime/:id" element={<OvertimePrintPage />} />

      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/calendar" replace />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/leave-requests" element={<LeaveListPage />} />
        <Route path="/balances" element={<BalancesPage />} />
        <Route path="/overtime" element={<OvertimePage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/employees" replace />} />
          <Route path="employees" element={<EmployeesPage />} />
          <Route path="leave-types" element={<LeaveTypesPage />} />
          <Route path="grants" element={<GrantsPage />} />
          <Route path="opening-balances" element={<OpeningBalancesPage />} />
          <Route path="holidays" element={<HolidaysPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit-logs" element={<AuditLogPage />} />
          <Route path="system" element={<SystemPage />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="page">
              <EmptyState title="페이지를 찾을 수 없습니다." />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
