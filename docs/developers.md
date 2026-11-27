# 개발

> 공개 저장소입니다. DB, 백업, 직원 정보, `config.json`은 커밋하지 않습니다. 커밋 규칙은 [AGENTS.md](../AGENTS.md)를 따릅니다.

## 구조와 명령

TypeScript 모노레포 (Node 24).

| 폴더              | 내용                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `packages/shared` | 화면·서버 공용 타입(`types.ts`), 입력 검사(`schemas.ts`), 휴가·잔여 계산 |
| `apps/server`     | API 서버 (Fastify, `node:sqlite`)                                     |
| `apps/web`        | 화면 (React, Vite)                                                    |
| `launcher/`       | 설치 PC에서 서버를 띄우고 감시하는 launcher와 트레이                  |
| `scripts/`        | 개발 실행, 배포 파일 만들기, Windows 설치 스크립트                    |

| 명령                             | 하는 일                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`                    | API 서버(3000)와 화면(5173)을 함께 띄움. 하나만 띄우려면 `dev:server`·`dev:web`. API 포트는 `LEAVE_FLOW_PORT`로 바꿈 |
| `npm test` / `npm run typecheck` | 테스트 / 타입 검사                                                                               |
| `npm run package`                | 빌드 후 `release/`에 zip·sha256 (Inno Setup 6이 있으면 설치 프로그램도)                          |

개발 서버의 DB·설정은 `apps/server/data`, `apps/server/config.json`에 있습니다 (`LEAVE_FLOW_HOME`으로 다른 폴더 지정).

## 배포 구조와 자동 업데이트

- 설치 폴더에서 트레이(`tray.ps1`)가 `launcher.mjs`를 실행하고, launcher가 `versions\<current>\server.mjs`를 띄웁니다. 실행할 버전은 `state.json`(`current`·`previous`·`pending`·`failedVersion`)에 있습니다.
- **업데이트**(`apps/server/src/services/updater.ts`): 서버 시작 2분 뒤와 `updateCheckHours`마다 `updateRepo`의 최신 Release를 확인합니다. 새 버전이면 zip·sha256을 받아 확인 → DB 백업(`pre-update`) → `versions\<버전>\`에 풀기 → `pending` 기록 → 종료 코드 75. `autoUpdate=false`면 확인만 하고, 개발 실행이거나 `updateRepo`가 없으면 끕니다.
- **launcher**(`launcher/launcher.mjs`): 종료 코드 75면 새 버전을 시험 기동하고, 60초 안에 `/api/health`가 새 버전으로 답하지 않으면 이전 버전과 업데이트 전 DB로 되돌리고 `failedVersion`에 기록합니다 (자동 업데이트에서 건너뜀). 정상 기동하면 새 버전의 launcher·트레이 파일로 바꿔 둡니다. 76은 재시작(복구), 0은 종료, 그 밖은 2~60초 뒤 재시작.
- **복구**: 고른 백업(목록 또는 올린 파일)을 검사(leave-flow DB인지, 더 새 마이그레이션이 아닌지)한 뒤 `data\restore-pending.db`로 두고 종료 코드 76 → 다음 시작 때 DB를 바꿔 끼웁니다.
- **마이그레이션**: `apps/server/src/db/migrations.ts`. 배포된 마이그레이션은 고치지 말고 새 버전을 추가합니다.

## 새 버전 배포

1. `npm test`, `npm run typecheck`로 확인합니다.
2. 루트 `package.json`의 `version`을 올리고(`npm version patch --no-git-tag-version`) 커밋합니다.
3. 같은 버전의 태그를 push 합니다: `git tag v<버전> && git push && git push --tags`
4. GitHub Actions(`release`)가 테스트·빌드 후 Release에 zip·sha256·설치 프로그램을 올립니다. 태그와 `package.json` 버전이 다르면 실패합니다.
5. 사무실 서버는 다음 확인 때 자동으로 설치합니다. 바로 적용하려면 관리 → 백업·업데이트 → **지금 업데이트**.
