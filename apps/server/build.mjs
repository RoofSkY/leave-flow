// 서버를 server.mjs 한 파일로 묶는다. 버전은 루트 package.json에서 가져와 __APP_VERSION__으로 주입.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/server.mjs",
  sourcemap: true,
  legalComments: "none",
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
