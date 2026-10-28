import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { departmentInput, type Department } from "@leave-flow/shared";
import { Button, EmptyState, ErrorText, Spinner, TextInput, useConfirm, useToast } from "../ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { qk, useDepartments } from "../../lib/queries.ts";

/** 위·아래 화살표 (글자 화살표는 Windows에서 그림 문자로 보일 수 있어 SVG 사용) */
export function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={up ? { transform: "rotate(180deg)" } : undefined}>
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 소속 이름 검사 (서버와 같은 규칙) */
function nameError(name: string): string | null {
  const r = departmentInput.shape.name.safeParse(name);
  return r.success ? null : (r.error.issues[0]?.message ?? "소속 이름을 확인하세요.");
}

/** 설정: 직원 등록 화면에서 고를 소속 목록 */
export function DepartmentsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const departments = useDepartments();
  const list = departments.data ?? [];
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.departments() }),
      // 이름을 바꾸면 직원 소속도 바뀜
      qc.invalidateQueries({ queryKey: ["employees"] }),
    ]);

  const add = useMutation({
    mutationFn: (name: string) =>
      api.post<Department>("/api/departments", {
        name,
        sortOrder: list.reduce((max, d) => Math.max(max, d.sortOrder), 0) + 1,
      }),
    onSuccess: async (d) => {
      setNewName("");
      toast(`'${d.name}' 소속을 추가했습니다.`);
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const update = useMutation({
    mutationFn: (d: { id: number; name: string; sortOrder: number }) =>
      api.put<Department>(`/api/departments/${d.id}`, { name: d.name, sortOrder: d.sortOrder }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del<void>(`/api/departments/${id}`),
    onSuccess: async () => {
      toast("소속을 삭제했습니다.");
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    const err = nameError(name);
    if (err) return toast(err, "error");
    add.mutate(name);
  };

  const saveEdit = async (d: Department) => {
    if (!editing) return;
    const name = editing.name.trim();
    const err = nameError(name);
    if (err) return toast(err, "error");
    if (name === d.name) return setEditing(null);
    if (
      d.employeeCount > 0 &&
      !(await confirm({
        title: "소속 이름 바꾸기",
        message: `'${d.name}' → '${name}'\n이 소속인 직원 ${d.employeeCount}명의 소속도 함께 바뀝니다.\n이미 작성한 휴가원에는 작성할 때의 소속이 그대로 남습니다.`,
        confirmLabel: "바꾸기",
      }))
    ) {
      return;
    }
    update.mutate({ id: d.id, name, sortOrder: d.sortOrder });
  };

  /** 위·아래로 순서 바꾸기 */
  const move = (index: number, dir: -1 | 1) => {
    const a = list[index];
    const b = list[index + dir];
    if (!a || !b) return;
    // 같은 순서 값이면 자리 번호로 다시 매김
    const orderA = a.sortOrder === b.sortOrder ? index : a.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? index + dir : b.sortOrder;
    update.mutate({ id: a.id, name: a.name, sortOrder: orderB });
    update.mutate({ id: b.id, name: b.name, sortOrder: orderA });
  };

  const askRemove = async (d: Department) => {
    const ok = await confirm({
      title: "소속 삭제",
      message: `'${d.name}' 소속을 목록에서 삭제할까요?`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (ok) remove.mutate(d.id);
  };

  return (
    <section className="card">
      <h2 className="section-title">소속</h2>
      <p className="settings-item-desc">
        직원을 등록할 때 고르는 소속 목록입니다. 이름을 바꾸면 그 소속인 직원의 소속도 함께 바뀝니다. 직원이 있거나
        휴가 종류 적용 대상으로 쓰는 소속은 삭제할 수 없습니다.
      </p>

      <form className="row" onSubmit={submitNew} style={{ marginBottom: 12 }}>
        <TextInput
          value={newName}
          placeholder="새 소속 이름 (예: 아동사업부)"
          aria-label="새 소속 이름"
          maxLength={50}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={add.isPending || !newName.trim()}>
          추가
        </Button>
      </form>

      {departments.isPending ? (
        <Spinner />
      ) : departments.error ? (
        <ErrorText error={departments.error} />
      ) : list.length === 0 ? (
        <EmptyState title="등록된 소속이 없습니다.">위에서 소속을 추가하세요.</EmptyState>
      ) : (
        <ul className="dept-list">
          {list.map((d, i) => (
            <li key={d.id} className="dept-row">
              {editing?.id === d.id ? (
                <form
                  className="row dept-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit(d);
                  }}
                >
                  <TextInput
                    autoFocus
                    value={editing.name}
                    maxLength={50}
                    aria-label="소속 이름"
                    onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
                    저장
                  </Button>
                  <Button size="sm" onClick={() => setEditing(null)}>
                    취소
                  </Button>
                </form>
              ) : (
                <>
                  <span className="dept-name">{d.name}</span>
                  <span className="muted dept-count">직원 {d.employeeCount}명</span>
                  <span className="spacer" />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    title="위로"
                    aria-label={`${d.name} 위로`}
                    disabled={i === 0 || update.isPending}
                    onClick={() => move(i, -1)}
                  >
                    <Chevron up />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    title="아래로"
                    aria-label={`${d.name} 아래로`}
                    disabled={i === list.length - 1 || update.isPending}
                    onClick={() => move(i, 1)}
                  >
                    <Chevron />
                  </Button>
                  <Button size="sm" onClick={() => setEditing({ id: d.id, name: d.name })}>
                    이름 바꾸기
                  </Button>
                  <Button
                    size="sm"
                    disabled={d.employeeCount > 0 || remove.isPending}
                    title={d.employeeCount > 0 ? "이 소속인 직원이 있어 삭제할 수 없습니다." : undefined}
                    onClick={() => void askRemove(d)}
                  >
                    삭제
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
