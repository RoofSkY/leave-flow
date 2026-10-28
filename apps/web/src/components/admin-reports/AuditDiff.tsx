import "./admin-reports.css";

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** 보기 좋은 JSON. 숫자·문자열만 든 짧은 배열은 한 줄로 ([1, 2, 3]) */
const pretty = (v: unknown) =>
  (JSON.stringify(v, null, 2) ?? "null").replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (match, inner: string) => {
    const line = inner.split(/,\n\s*/).join(", ");
    return line.length <= 60 ? `[${line}]` : match;
  });

/** 줄바꿈된 JSON 의 둘째 줄부터 들여쓰기 (객체 안에 넣을 때) */
const indent = (text: string) => text.replace(/\n/g, "\n  ");

/** 한쪽 값을 보기 좋은 JSON 으로. 양쪽이 모두 객체면 바뀐 최상위 항목을 강조 */
function JsonPane({ title, value, other }: { title: string; value: unknown; other: unknown }) {
  let body;
  if (value === null || value === undefined) {
    body = <div className="audit-json-empty">없음</div>;
  } else if (!isObject(value)) {
    body = <pre className="audit-json">{pretty(value)}</pre>;
  } else {
    const keys = Object.keys(value);
    const compare = isObject(other);
    body = (
      <pre className="audit-json">
        {"{"}
        {keys.map((k, i) => {
          const changed = compare && JSON.stringify(value[k]) !== JSON.stringify(other[k]);
          return (
            <span key={k} className={changed ? "audit-json-line audit-json-changed" : "audit-json-line"}>
              {`  ${JSON.stringify(k)}: ${indent(pretty(value[k]))}${i < keys.length - 1 ? "," : ""}`}
            </span>
          );
        })}
        {"}"}
      </pre>
    );
  }
  return (
    <div className="audit-pane">
      <div className="audit-pane-title">{title}</div>
      {body}
    </div>
  );
}

/** 변경 이력의 변경 전·후 값을 나란히 */
export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const none = (v: unknown) => v === null || v === undefined;
  if (none(before) && none(after)) return <div className="muted">기록된 값이 없습니다.</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="audit-diff">
        <JsonPane title="변경 전" value={before} other={after} />
        <JsonPane title="변경 후" value={after} other={before} />
      </div>
      {isObject(before) && isObject(after) && <div className="faint audit-diff-hint">바뀐 항목은 색으로 표시됩니다.</div>}
    </div>
  );
}
