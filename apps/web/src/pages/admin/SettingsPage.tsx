import { CategoriesCard } from "../../components/masters/CategoriesCard.tsx";
import { DepartmentsCard } from "../../components/masters/DepartmentsCard.tsx";
import { WorkHoursDefaultsCard } from "../../components/masters/WorkHoursDefaultsCard.tsx";
import { ErrorText, PageHeader, Spinner } from "../../components/ui/index.tsx";
import { useSettings } from "../../lib/queries.ts";
import "./masters.css";

export function SettingsPage() {
  const settings = useSettings();

  return (
    <div>
      <PageHeader title="설정" description="근무시간 기본값, 소속·구분 목록을 정합니다." />

      {settings.isPending ? (
        <Spinner />
      ) : settings.error ? (
        <ErrorText error={settings.error} />
      ) : (
        <div className="stack settings-card">
          <WorkHoursDefaultsCard settings={settings.data} />
          <DepartmentsCard />
          <CategoriesCard />
        </div>
      )}
    </div>
  );
}
