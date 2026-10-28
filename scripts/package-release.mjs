// 배포 파일 만들기: npm run build → release/leave-flow-<버전>/ 조립 → release/leave-flow-<버전>.zip + .sha256
// 사용: npm run package   (이미 빌드했으면 node scripts/package-release.mjs --no-build)
// zip 안 (최상위): server.mjs(.map), web/, launcher.mjs, state.mjs, scripts/(.ps1·.cmd), README.md, docs/운영가이드.md, config.example.json, release.json
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const name = `leave-flow-${version}`;
const releaseDir = path.join(root, "release");
const outDir = path.join(releaseDir, name);

function fail(message) {
  console.error(`\n[package] ${message}`);
  process.exit(1);
}

/** 자동 업데이트 저장소 "owner/repo": LEAVE_FLOW_UPDATE_REPO, GitHub Actions 의 GITHUB_REPOSITORY, package.json repository 순 */
function updateRepo() {
  const fromEnv = process.env.LEAVE_FLOW_UPDATE_REPO ?? process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const r = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const m = r && /github(?:\.com[/:]|:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(r);
  return m ? m[1] : null;
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) fail(`package.json 버전 형식이 올바르지 않습니다: ${version}`);

if (!process.argv.includes("--no-build")) {
  console.log("[package] npm run build");
  // Windows 에서 npm 은 npm.cmd 라서 셸로 실행
  const r = spawnSync("npm run build", { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) fail("빌드에 실패했습니다.");
}

const serverDist = path.join(root, "apps/server/dist");
const webDist = path.join(root, "apps/web/dist");
if (!existsSync(path.join(serverDist, "server.mjs"))) fail("apps/server/dist/server.mjs 가 없습니다. 먼저 빌드하세요.");
if (!existsSync(path.join(webDist, "index.html"))) fail("apps/web/dist/index.html 이 없습니다. 먼저 빌드하세요.");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const copy = (from, to = path.basename(from)) => cpSync(path.join(root, from), path.join(outDir, to), { recursive: true });

copy("apps/server/dist/server.mjs", "server.mjs");
if (existsSync(path.join(serverDist, "server.mjs.map"))) copy("apps/server/dist/server.mjs.map", "server.mjs.map");
copy("apps/web/dist", "web");
copy("launcher/launcher.mjs", "launcher.mjs");
copy("launcher/state.mjs", "state.mjs");
copy("scripts/windows", "scripts");
copy("README.md");
copy("docs/운영가이드.md", "docs/운영가이드.md");

const repo = updateRepo();
writeFileSync(path.join(outDir, "release.json"), `${JSON.stringify({ version, repo }, null, 2)}\n`);
writeFileSync(
  path.join(outDir, "config.example.json"),
  `${JSON.stringify(
    {
      port: 8080,
      nasBackupDir: "\\\\NAS주소\\backup\\leave-flow",
      backupTime: "12:30",
      backupKeepDays: 30,
      updateRepo: repo ?? "owner/leave-flow",
      autoUpdate: true,
      updateCheckHours: 6,
    },
    null,
    2,
  )}\n`,
);

/** 폴더 안 모든 파일 → { "web/index.html": 내용 } (zip 안 경로는 / 로) */
function collect(dir, prefix = "", out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, rel, out);
    else out[rel] = new Uint8Array(readFileSync(full));
  }
  return out;
}

const files = collect(outDir);
const zip = zipSync(files, { level: 9 });
const zipPath = path.join(releaseDir, `${name}.zip`);
writeFileSync(zipPath, zip);
const sha = createHash("sha256").update(zip).digest("hex");
writeFileSync(`${zipPath}.sha256`, `${sha}  ${name}.zip\n`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`\n[package] ${name}`);
console.log(`  파일 ${Object.keys(files).length}개, zip ${mb(statSync(zipPath).size)}`);
console.log(`  ${path.relative(root, zipPath)}`);
console.log(`  ${path.relative(root, zipPath)}.sha256  ${sha}`);
console.log(`  업데이트 저장소: ${repo ?? "(없음 — config.json 의 updateRepo 를 직접 설정)"}`);
