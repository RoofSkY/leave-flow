// 개발용: API 서버(3000)와 화면(5173)을 함께 띄우고, 하나가 꺼지면 나머지도 끈다.
// 사용: npm run dev  (VS Code Code Runner ▶ 버튼도 이 명령을 실행)
//       npm run dev:server / npm run dev:web  (하나만 띄움. 포트는 같음)
// API 포트는 LEAVE_FLOW_PORT 로 바꿀 수 있고, 화면의 /api 전달(apps/web/vite.config.ts)도 같은 값을 따른다.
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = Number(process.env.LEAVE_FLOW_PORT ?? 3000);
/** "server" | "web" | undefined(둘 다) */
const only = process.argv[2];
// 서버 기본 포트(8082)가 아니라 개발용 포트로 띄움
const env = { ...process.env, LEAVE_FLOW_PORT: String(PORT) };

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

if (only !== "web" && (await portInUse(PORT))) {
  console.error(`[dev] ${PORT} 포트를 이미 다른 프로그램이 쓰고 있습니다. 이전에 띄운 서버를 끄고 다시 실행하세요.`);
  console.error(`[dev] 확인: netstat -ano | findstr :${PORT}   끄기: Stop-Process -Id <PID>`);
  process.exit(1);
}

const children = [];
let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") {
      // shell 아래의 node 프로세스까지 끄려면 프로세스 트리 전체를 종료해야 한다
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 500);
}

function start(command) {
  const child = spawn(command, { shell: true, stdio: "inherit", env });
  children.push(child);
  child.on("exit", (code) => stopAll(code ?? 0));
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

if (only !== "web") start("npm run dev -w @leave-flow/server");

if (only !== "server") {
  // 서버가 뜨기 전에 화면이 열리면 첫 API 요청이 ECONNREFUSED 로 실패하므로 서버를 기다린다
  const startedAt = Date.now();
  while (only !== "web" && !stopping && !(await portInUse(PORT))) {
    if (Date.now() - startedAt > 60_000) {
      console.error(`[dev] 60초가 지나도 API 서버(${PORT})가 뜨지 않았지만 화면을 엽니다. 위의 서버 오류를 확인하세요.`);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  // --open: 화면이 준비되면 브라우저를 자동으로 연다
  if (!stopping) start("npm run dev -w @leave-flow/web -- --open");
}
