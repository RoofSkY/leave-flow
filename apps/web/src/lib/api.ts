// 서버 API 호출. 실패하면 서버가 보낸 한국어 메시지를 담은 ApiRequestError 를 던짐.

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function send(method: string, url: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, "서버에 연결할 수 없습니다. 출결 PC가 켜져 있는지 확인하세요.");
  }
  if (!res.ok) {
    let message = `요청을 처리하지 못했습니다. (${res.status})`;
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: string; details?: unknown };
      if (j.error) message = j.error;
      details = j.details;
    } catch {
      // 본문 없음
    }
    throw new ApiRequestError(res.status, message, details);
  }
  return res;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

/** POST 로 받은 파일을 filename 으로 내려받기 (화면 표 → 엑셀) */
export async function downloadFile(url: string, body: unknown, filename: string): Promise<void> {
  const res = await send("POST", url, body);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** 쿼리스트링 만들기 (undefined·null·"" 은 제외) */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  /** 본문이 없으면 {} 를 보냄 */
  post: <T>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
