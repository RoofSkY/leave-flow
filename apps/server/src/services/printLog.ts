import { execute, type Db } from "../db/index.ts";

/** 출력 기록 추가 + 문서의 최근 출력일시 갱신 */
export function recordPrint(db: Db, docType: "leave" | "overtime", docId: number, at: string): void {
  execute(db, "INSERT INTO print_logs (doc_type, doc_id, printed_at) VALUES (?, ?, ?)", [docType, docId, at]);
  const table = docType === "leave" ? "leave_requests" : "overtime_requests";
  execute(db, `UPDATE ${table} SET last_printed_at = ? WHERE id = ?`, [at, docId]);
}
