import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppContext } from "./context.ts";
import { ApiError } from "./lib/errors.ts";
import { registerAuditLogRoutes } from "./routes/auditLogs.ts";
import { registerBalanceRoutes } from "./routes/balances.ts";
import { registerCalendarRoutes } from "./routes/calendar.ts";
import { registerEmployeeRoutes } from "./routes/employees.ts";
import { registerGrantRoutes } from "./routes/grants.ts";
import { registerHolidayRoutes } from "./routes/holidays.ts";
import { registerLeaveRequestRoutes } from "./routes/leaveRequests.ts";
import { registerLeaveTypeRoutes } from "./routes/leaveTypes.ts";
import { registerOpeningBalanceRoutes } from "./routes/openingBalances.ts";
import { registerOvertimeRoutes } from "./routes/overtime.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerCategoryRoutes } from "./routes/categories.ts";
import { registerDepartmentRoutes } from "./routes/departments.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerUsageRoutes } from "./routes/usage.ts";

export interface BuildAppOptions {
  /** 서버를 종료(재시작)해야 할 때 호출 (업데이트·백업 복구) */
  requestExit: (code: number) => void;
}

/** 데이터베이스 제약 오류를 사용자용 메시지로 */
function sqliteMessage(err: Error): { status: number; message: string } | null {
  const msg = err.message ?? "";
  if (msg.includes("UNIQUE constraint failed")) return { status: 409, message: "이미 등록된 항목입니다." };
  if (msg.includes("FOREIGN KEY constraint failed")) {
    return { status: 409, message: "다른 데이터에서 사용 중이라 처리할 수 없습니다." };
  }
  if (msg.includes("database is locked")) {
    return { status: 503, message: "잠시 후 다시 시도하세요. (데이터베이스 사용 중)" };
  }
  return null;
}

/** Host 헤더에서 포트·IPv6 괄호를 뺀 소문자 호스트 이름 ("192.168.0.10:8080" → "192.168.0.10") */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.lastIndexOf(":");
  return (colon >= 0 ? h.slice(0, colon) : h).replace(/\.$/, "");
}

/**
 * 로그인 없는 사무실 LAN 서버를 다른 사이트에서 조작하지 못하게 막는 API 요청 검사.
 * 실패하면 화면에 보여줄 { status, error }, 통과하면 null.
 * 1) Host: IP 주소·localhost·이 PC 이름·config allowedHosts 만 허용 (DNS 리바인딩 차단)
 * 2) 변경 요청(POST 등)에 Origin 이 있으면 Host 와 같아야 함 (다른 사이트의 폼·fetch 차단)
 * 3) 본문을 보내는 변경 요청은 application/json 만 (text/plain 폼 전송 차단)
 */
export function checkApiRequest(
  req: Pick<FastifyRequest, "method" | "headers">,
  allowedHosts: ReadonlySet<string>,
): { status: number; error: string } | null {
  const host = req.headers.host;
  if (host !== undefined) {
    const name = hostnameOf(host);
    if (!(isIP(name) !== 0 || name === "localhost" || allowedHosts.has(name))) {
      return { status: 403, error: "허용되지 않은 주소로 접속했습니다. 출결 PC의 IP 주소로 접속하세요." };
    }
  }

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    let sameOrigin = false;
    if (origin !== "null" && host !== undefined) {
      try {
        sameOrigin = new URL(origin).host === host.trim().toLowerCase();
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin) return { status: 403, error: "다른 사이트에서 보낸 요청은 처리하지 않습니다." };
  }

  const contentType = req.headers["content-type"];
  if (
    (method === "POST" || method === "PUT" || method === "PATCH") &&
    contentType !== undefined &&
    !contentType.trim().toLowerCase().startsWith("application/json")
  ) {
    return { status: 415, error: "요청 형식이 올바르지 않습니다." };
  }
  return null;
}

export async function buildApp(ctx: AppContext, opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.logger ? { level: "info" } : false,
    bodyLimit: 2 * 1024 * 1024,
    // 같은 사무실 PC에서만 접속하므로 프록시 없음
    trustProxy: false,
  });

  app.setErrorHandler((err: FastifyError | ApiError | Error, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: err.message, details: err.details });
    }
    const sqlite = sqliteMessage(err);
    if (sqlite) return reply.status(sqlite.status).send({ error: sqlite.message });
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const message =
        (err as FastifyError).code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        (err as FastifyError).code === "FST_ERR_CTP_EMPTY_JSON_BODY"
          ? "요청 형식이 올바르지 않습니다."
          : err.message;
      return reply.status(status).send({ error: message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "서버 오류가 발생했습니다. 잠시 후 다시 시도하세요." });
  });

  // 모든 응답(화면 파일·API·오류): 다른 사이트가 이 화면을 iframe 으로 겹쳐 띄워 클릭을 유도하지 못하게 (클릭재킹),
  // 내려받은 파일을 형식대로만 해석하게. 앱 자신도 iframe 을 쓰지 않으므로 어디서도 못 띄우게 함
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
  });

  // 다른 사이트·다른 주소에서 온 API 요청 차단 (화면 파일은 검사하지 않음)
  const allowedHosts = new Set(
    [...ctx.config.allowedHosts, os.hostname()].map((h) => h.trim().toLowerCase()).filter(Boolean),
  );
  app.addHook("onRequest", async (req, reply) => {
    if (!(req.url === "/api" || req.url.startsWith("/api/") || req.url.startsWith("/api?"))) return;
    const rejected = checkApiRequest(req, allowedHosts);
    if (rejected) return reply.status(rejected.status).send({ error: rejected.error });
  });

  await app.register(
    async (api) => {
      api.get("/health", async () => ({ ok: true, version: ctx.version }));
      registerEmployeeRoutes(api, ctx);
      registerLeaveTypeRoutes(api, ctx);
      registerGrantRoutes(api, ctx);
      registerOpeningBalanceRoutes(api, ctx);
      registerSettingsRoutes(api, ctx);
      registerDepartmentRoutes(api, ctx);
      registerCategoryRoutes(api, ctx);
      registerBalanceRoutes(api, ctx);
      registerLeaveRequestRoutes(api, ctx);
      registerCalendarRoutes(api, ctx);
      registerOvertimeRoutes(api, ctx);
      registerHolidayRoutes(api, ctx);
      registerUsageRoutes(api, ctx);
      registerAuditLogRoutes(api, ctx);
      registerSystemRoutes(api, ctx, opts.requestExit);
    },
    { prefix: "/api" },
  );

  const webDir = ctx.config.webDir;
  if (webDir) {
    await app.register(fastifyStatic, {
      root: path.resolve(webDir),
      prefix: "/",
      wildcard: false,
      setHeaders(res, filePath) {
        // 해시가 붙은 빌드 파일은 오래 캐시, index.html 은 항상 새로
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.header("Cache-Control", "no-cache");
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/api") {
      return reply.status(404).send({ error: "요청한 API가 없습니다." });
    }
    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // 화면 주소(/calendar, /admin/... 등)는 모두 index.html 로 (SPA)
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return reply.status(404).send({ error: "페이지를 찾을 수 없습니다." });
  });

  return app;
}
