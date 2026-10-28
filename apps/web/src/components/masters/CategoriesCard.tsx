import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { categoryInput, type Category } from "@leave-flow/shared";
import { Button, Checkbox, EmptyState, ErrorText, Spinner, TextInput, useConfirm, useToast } from "../ui/index.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { qk, useCategories } from "../../lib/queries.ts";
import { Chevron } from "./DepartmentsCard.tsx";

/** 구분 이름 검사 (서버와 같은 규칙) */
function nameError(name: string): string | null {
  const r = categoryInput.shape.name.safeParse(name);
  return r.success ? null : (r.error.issues[0]?.message ?? "구분 이름을 확인하세요.");
}

/** 설정: 직원 등록 화면에서 고를 구분 목록 (사회복무요원 특별휴가 대상 여부 포함) */
export function CategoriesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const categories = useCategories();
  const list = categories.data ?? [];
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.categories() }),
      // 이름·특별휴가 대상을 바꾸면 직원 구분과 휴가 종류 적용 대상도 바뀜
      qc.invalidateQueries({ queryKey: ["employees"] }),
      qc.invalidateQueries({ queryKey: ["leave-types"] }),
    ]);

  const add = useMutation({
    mutationFn: (name: string) =>
      api.post<Category>("/api/categories", {
        name,
        socialServiceAgent: false,
        sortOrder: list.reduce((max, c) => Math.max(max, c.sortOrder), 0) + 1,
      }),
    onSuccess: async (c) => {
      setNewName("");
      toast(`'${c.name}' 구분을 추가했습니다.`);
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const update = useMutation({
    mutationFn: (c: Pick<Category, "id" | "name" | "socialServiceAgent" | "sortOrder">) =>
      api.put<Category>(`/api/categories/${c.id}`, {
        name: c.name,
        socialServiceAgent: c.socialServiceAgent,
        sortOrder: c.sortOrder,
      }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del<void>(`/api/categories/${id}`),
    onSuccess: async () => {
      toast("구분을 삭제했습니다.");
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

  const saveEdit = async (c: Category) => {
    if (!editing) return;
    const name = editing.name.trim();
    const err = nameError(name);
    if (err) return toast(err, "error");
    if (name === c.name) return setEditing(null);
    if (
      c.employeeCount > 0 &&
      !(await confirm({
        title: "구분 이름 바꾸기",
        message: `'${c.name}' → '${name}'\n이 구분인 직원 ${c.employeeCount}명의 구분도 함께 바뀝니다.`,
        confirmLabel: "바꾸기",
      }))
    ) {
      return;
    }
    update.mutate({ ...c, name });
  };

  const toggleAgent = async (c: Category, on: boolean) => {
    if (
      c.employeeCount > 0 &&
      !(await confirm({
        title: on ? "사회복무요원 특별휴가 대상으로" : "사회복무요원 특별휴가 대상에서 빼기",
        message: on
          ? `'${c.name}' 구분인 직원 ${c.employeeCount}명을 사회복무요원 특별휴가 신청서의 대상자 목록에 넣습니다.`
          : `'${c.name}' 구분인 직원 ${c.employeeCount}명이 사회복무요원 특별휴가 신청서의 대상자 목록에서 빠집니다.\n이미 작성한 신청서는 그대로 남습니다.`,
        confirmLabel: on ? "넣기" : "빼기",
      }))
    ) {
      return;
    }
    update.mutate({ ...c, socialServiceAgent: on });
  };

  /** 위·아래로 순서 바꾸기 */
  const move = (index: number, dir: -1 | 1) => {
    const a = list[index];
    const b = list[index + dir];
    if (!a || !b) return;
    // 같은 순서 값이면 자리 번호로 다시 매김
    const orderA = a.sortOrder === b.sortOrder ? index : a.sortOrder;
    const orderB = a.sortOrder === b.sortOrder ? index + dir : b.sortOrder;
    update.mutate({ ...a, sortOrder: orderB });
    update.mutate({ ...b, sortOrder: orderA });
  };

  const askRemove = async (c: Category) => {
    const ok = await confirm({
      title: "구분 삭제",
      message: `'${c.name}' 구분을 목록에서 삭제할까요?`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (ok) remove.mutate(c.id);
  };

  return (
    <section className="card">
      <h2 className="section-title">구분</h2>
      <p className="settings-item-desc">
        직원을 등록할 때 고르는 구분 목록입니다 (예: 정규직, 계약직, 사회복무요원). &apos;사회복무요원 특별휴가 대상&apos;을
        켠 구분의 직원만 사회복무요원 특별휴가 신청서의 대상자로 고를 수 있습니다. 이름을 바꾸면 그 구분인 직원의 구분도
        함께 바뀝니다. 직원이 있거나 휴가 종류 적용 대상으로 쓰는 구분은 삭제할 수 없습니다.
      </p>

      <form className="row" onSubmit={submitNew} style={{ marginBottom: 12 }}>
        <TextInput
          value={newName}
          placeholder="새 구분 이름 (예: 계약직)"
          aria-label="새 구분 이름"
          maxLength={30}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={add.isPending || !newName.trim()}>
          추가
        </Button>
      </form>

      {categories.isPending ? (
        <Spinner />
      ) : categories.error ? (
        <ErrorText error={categories.error} />
      ) : list.length === 0 ? (
        <EmptyState title="등록된 구분이 없습니다.">위에서 구분을 추가하세요.</EmptyState>
      ) : (
        <ul className="dept-list">
          {list.map((c, i) => (
            <li key={c.id} className="dept-row">
              {editing?.id === c.id ? (
                <form
                  className="row dept-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit(c);
                  }}
                >
                  <TextInput
                    autoFocus
                    value={editing.name}
                    maxLength={30}
                    aria-label="구분 이름"
                    onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
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
                  <span className="dept-name">{c.name}</span>
                  <span className="muted dept-count">직원 {c.employeeCount}명</span>
                  <span className="spacer" />
                  <Checkbox
                    label="사회복무요원 특별휴가 대상"
                    checked={c.socialServiceAgent}
                    disabled={update.isPending}
                    onChange={(on) => void toggleAgent(c, on)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    title="위로"
                    aria-label={`${c.name} 위로`}
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
                    aria-label={`${c.name} 아래로`}
                    disabled={i === list.length - 1 || update.isPending}
                    onClick={() => move(i, 1)}
                  >
                    <Chevron />
                  </Button>
                  <Button size="sm" onClick={() => setEditing({ id: c.id, name: c.name })}>
                    이름 바꾸기
                  </Button>
                  <Button
                    size="sm"
                    disabled={c.employeeCount > 0 || remove.isPending}
                    title={c.employeeCount > 0 ? "이 구분인 직원이 있어 삭제할 수 없습니다." : undefined}
                    onClick={() => void askRemove(c)}
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
