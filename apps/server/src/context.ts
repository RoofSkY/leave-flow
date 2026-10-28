import { localTimestamp, localToday } from "@leave-flow/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";

export interface AppContext {
  db: Db;
  config: Config;
  version: string;
  /** 오늘 날짜 "YYYY-MM-DD" (테스트에서 바꿀 수 있음) */
  today: () => string;
  /** 지금 "YYYY-MM-DD HH:MM:SS" */
  now: () => string;
}

export function createContext(db: Db, config: Config, version: string): AppContext {
  return { db, config, version, today: () => localToday(), now: () => localTimestamp() };
}
