declare const __APP_VERSION__: string | undefined;

/** 빌드 시 루트 package.json 버전이 주입됨. 개발 실행(tsx)에서는 "dev" */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
