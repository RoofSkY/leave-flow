import { execute, type Db } from "../db/index.ts";

/** 문서의 최근 출력일시 갱신 (출력 이력은 부르는 쪽이 변경 이력 print 로 남김) */
export function recordPrint(db: Db, docType: "leave" | "overtime", docId: number, at: string): void {
  const table = docType === "leave" ? "leave_requests" : "overtime_requests";
  execute(db, `UPDATE ${table} SET last_printed_at = ? WHERE id = ?`, [at, docId]);
}
