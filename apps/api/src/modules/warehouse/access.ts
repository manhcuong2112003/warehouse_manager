import type { PoolClient } from "pg";
import type { Actor } from "../identity/auth";
import { ensure } from "../../shared/errors";
export function scope(actor: Actor, warehouse: string) {
  ensure(
    actor.role === "ADMIN" || actor.warehouses.includes(warehouse),
    "WAREHOUSE_FORBIDDEN",
    "Không có quyền truy cập kho này.",
    403,
  );
}
export async function writableWarehouse(
  c: PoolClient,
  actor: Actor,
  id: string,
  openingJob?: string,
) {
  scope(actor, id);
  const r = await c.query("SELECT * FROM warehouses WHERE id=$1 FOR SHARE", [
    id,
  ]);
  ensure(r.rowCount, "NOT_FOUND", "Không tìm thấy kho.", 404);
  ensure(
    r.rows[0].opening_state === "NORMAL" ||
      r.rows[0].opening_job_id === openingJob,
    "WAREHOUSE_FROZEN",
    "Kho đang chốt tồn chuyển đổi.",
  );
  return r.rows[0];
}
