import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 개발 중: 화면은 Vite(5173), API는 서버(3000 또는 LEAVE_FLOW_PORT — scripts/dev.mjs 가 정함)로 전달
const apiPort = Number(process.env.LEAVE_FLOW_PORT ?? 3000);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 문자열로만 쓰면 Vite가 Host를 127.0.0.1:<API 포트> 로 바꿔
      // 서버의 Origin 검사(다른 사이트 요청 차단)에 걸리므로 Host를 그대로 넘김
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
