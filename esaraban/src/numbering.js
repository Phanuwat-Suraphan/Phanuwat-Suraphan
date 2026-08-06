import { db, beYear } from './db.js';

/**
 * Atomic running-number allocation, scoped by year+department+type+direction
 * (resolved decision: Part 4 review #3 — concurrency-safe counter).
 * Runs inside the caller's transaction; node:sqlite is synchronous and this
 * process is single-threaded, so the read-increment-write below cannot
 * interleave with another request as long as no `await` sits between them.
 */
export function nextRunningNumber({ departmentId, docTypeId, direction, year = beYear() }) {
  const existing = db
    .prepare(
      `SELECT running_number FROM document_counters
       WHERE year_be = ? AND department_id = ? AND doc_type_id = ? AND direction = ?`
    )
    .get(year, departmentId, docTypeId, direction);

  let next;
  if (existing) {
    next = existing.running_number + 1;
    db.prepare(
      `UPDATE document_counters SET running_number = ?
       WHERE year_be = ? AND department_id = ? AND doc_type_id = ? AND direction = ?`
    ).run(next, year, departmentId, docTypeId, direction);
  } else {
    next = 1;
    db.prepare(
      `INSERT INTO document_counters (year_be, department_id, doc_type_id, direction, running_number)
       VALUES (?, ?, ?, ?, ?)`
    ).run(year, departmentId, docTypeId, direction, next);
  }

  const display = `${String(next).padStart(4, '0')}/${year}`;
  return { runningNumber: next, yearBe: year, display };
}
