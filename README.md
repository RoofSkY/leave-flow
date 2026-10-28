# leave-flow

희망세움터 직원(약 20명)이 사무실 LAN 안에서 웹 브라우저로 **휴가원**과 **시간외근무 신청서**를 작성·조회·출력하는 프로그램입니다.

- 사무실 출결 PC(Windows 11) 한 대에서 실행, 직원 PC에는 설치 없음 (`http://<출결 PC IP>:8080`)
- 로그인·결재 기능 없음 (출력한 종이에 서명)
- 휴가는 10분 단위, 1일 = 직원별 하루 근무시간, 점심시간·근무하지 않는 날·공휴일·센터 휴무일 제외
- 매일 DB 백업(로컬 + NAS), 엑셀 내려받기, GitHub Releases 자동 업데이트

자세한 요구사항은 [spec.md](spec.md), API는 [docs/api.md](docs/api.md), 설치·운영은 [docs/운영가이드.md](docs/운영가이드.md)를 보세요.

## 구조

| 폴더 | 내용 |
|---|---|
| `packages/shared` | 휴가 시간 계산, 입력 검사(Zod), 공통 타입 (화면·서버 공용) |
| `apps/server` | Fastify API + 빌드된 화면 제공, SQLite(`node:sqlite`) |
| `apps/web` | React + Vite 화면 (FullCalendar) |
| `launcher` | 설치 PC에서 서버를 띄우고 감시하는 프로그램 (업데이트·되돌림·재시작) |
| `scripts` | 배포 파일 만들기, Windows 설치 스크립트 |

## 개발

Node.js 24 이상이 필요합니다.

```sh
npm install
npm run dev          # 서버 + 화면을 함께 실행하고 브라우저를 엶 (VS Code Code Runner ▶ 버튼도 같음)
npm run dev:server   # API 서버 (http://127.0.0.1:8080, 데이터는 현재 폴더의 data/)
npm run dev:web      # 화면 (http://localhost:5173, /api 는 8080 으로 전달)
npm test             # Vitest
npm run typecheck    # 타입 검사 (shared, server, web)
npm run build        # apps/web/dist + apps/server/dist/server.mjs
npm run package      # release/leave-flow-<버전>.zip + .sha256
```

개발 실행(`dev:server`)에서는 버전이 `dev`라서 자동 업데이트가 꺼져 있습니다. 데이터 위치는 `LEAVE_FLOW_HOME` 환경 변수로 바꿀 수 있습니다.

## 배포

`package.json`의 `version`을 올리고 같은 이름의 태그(`v0.2.0`)를 push 하면 GitHub Actions가 테스트 후 Release를 만들고, 사무실 서버가 자동으로 받아 업데이트합니다. 자세한 순서는 [운영가이드](docs/운영가이드.md#새-버전-배포-개발자)를 보세요.

이 저장소는 공개 저장소입니다. DB, 백업, 직원 정보, `config.json`은 절대 커밋하지 않습니다 (`.gitignore`).
