import { createHash } from "node:crypto";
import { PoolClient } from "pg";
import { ensure } from "./errors";
function canonical(v: any): any {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
}
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value)),
    )
    .digest("hex");
export async function idempotent<T>(
  c: PoolClient,
  actor: string,
  operation: string,
  key: string,
  payload: unknown,
  run: () => Promise<T>,
): Promise<T> {
  ensure(
    typeof key === "string" && key.length > 0 && key.length <= 200,
    "IDEMPOTENCY_REQUIRED",
    "Cần Idempotency-Key (tối đa 200 ký tự).",
    422,
  );
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${actor}:${operation}:${key}`,
  ]);
  const requestHash = hash(payload);
  const old = await c.query(
    "SELECT * FROM idempotency_records WHERE actor_id=$1 AND operation=$2 AND key=$3",
    [actor, operation, key],
  );
  if (old.rowCount) {
    ensure(
      old.rows[0].request_hash === requestHash,
      "IDEMPOTENCY_CONFLICT",
      "Key đã dùng với nội dung khác.",
    );
    return old.rows[0].response;
  }
  const response = await run();
  await c.query(
    "INSERT INTO idempotency_records(actor_id,operation,key,request_hash,response) VALUES($1,$2,$3,$4,$5)",
    [actor, operation, key, requestHash, JSON.stringify(response)],
  );
  return response;
}
