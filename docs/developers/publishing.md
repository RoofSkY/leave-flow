# 새 버전 배포

1. 코드를 고치고 `npm test`, `npm run typecheck`로 확인합니다.
2. 루트 `package.json`의 `version`을 올립니다. 예: `npm version patch --no-git-tag-version` (0.1.0 → 0.1.1)
3. 커밋하고 같은 버전의 태그를 push 합니다.
    ```sh
    git commit -am "0.1.1"
    git tag v0.1.1
    git push && git push --tags
    ```
4. GitHub Actions(`release`)가 테스트·타입 검사·빌드 후 Release에 `leave-flow-0.1.1.zip`과 `.sha256`, 설치 프로그램 `leave-flow-setup-0.1.1.exe`를 올립니다.
   태그와 `package.json` 버전이 다르면 실패합니다.
5. 사무실 서버는 다음 확인 때(최대 `updateCheckHours`) 자동으로 설치합니다. 바로 적용하려면 관리 화면에서 **지금 업데이트**.

받은 업데이트가 어떻게 설치되고 되돌려지는지는 [배포 구조와 자동 업데이트](architecture.md)를 보세요.

> 공개 저장소이므로 DB, 백업, 직원 정보, `config.json`은 절대 커밋하지 않습니다.
