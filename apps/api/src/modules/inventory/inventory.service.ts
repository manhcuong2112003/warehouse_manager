import { Injectable, Inject } from "@nestjs/common";
import { PoolClient } from "pg";
import { z } from "zod";
import { Database } from "../../database/db";
import { ensure } from "../../shared/errors";
import { idempotent } from "../../shared/idempotency";
import { date, quantity, text, uuid, validate } from "../../shared/validation";
import { Actor } from "../identity/auth";
import { scope, writableWarehouse } from "../warehouse/access";
export const packSchema = z.object({
  productId: uuid,
  locationId: uuid,
  lotNo: text,
  mesPackNo: text,
  vendorCode: text,
  quantity,
  expiredDate: date,
  status: z
    .enum(["AVAILABLE", "QUARANTINE", "LOCKED", "EXPIRED"])
    .default("AVAILABLE"),
});
export type ReceivePack = z.infer<typeof packSchema>;
@Injectable()
export class InventoryService {
  constructor(@Inject(Database) readonly db: Database) {}
  async receive(
    c: PoolClient,
    actor: Actor,
    warehouseId: string,
    reference: string,
    packs: ReceivePack[],
    kind: "INBOUND" | "OPENING_BALANCE" = "INBOUND",
    jobId?: string,
    effectiveAt?: string,
    draftId?: string,
  ) {
    await writableWarehouse(c, actor, warehouseId, jobId);
    ensure(
      packs.length > 0 && packs.length <= 1000,
      "INVALID_LINES",
      "Mỗi chứng từ cần 1–1000 pack.",
      422,
    );
    const old = await c.query(
      "SELECT id FROM inbound_receipts WHERE warehouse_id=$1 AND source_reference=$2",
      [warehouseId, reference],
    );
    ensure(!old.rowCount, "REFERENCE_EXISTS", "Chứng từ nguồn đã được nhập.");
    const today = (
      await c.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS today",
      )
    ).rows[0].today;
    const receipt = (
      await c.query(
        `INSERT INTO inbound_receipts(warehouse_id,source_reference,actor_id,kind,import_job_id,effective_at,draft_id)
      VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()),$7) RETURNING *`,
        [
          warehouseId,
          reference,
          actor.id,
          kind,
          jobId || null,
          effectiveAt || null,
          draftId || null,
        ],
      )
    ).rows[0];
    const ids: string[] = [];
    for (const raw of packs) {
      const p = validate(packSchema, raw);
      ensure(
        (
          await c.query("SELECT id FROM products WHERE id=$1 FOR SHARE", [
            p.productId,
          ])
        ).rowCount,
        "UNKNOWN_PRODUCT",
        "Sản phẩm không tồn tại.",
        422,
      );
      const location = await c.query(
        "SELECT 1 FROM locations WHERE id=$1 AND warehouse_id=$2",
        [p.locationId, warehouseId],
      );
      ensure(
        location.rowCount,
        "INVALID_LOCATION",
        "Vị trí không thuộc kho được chọn.",
        422,
      );
      ensure(
        kind === "OPENING_BALANCE" || p.expiredDate > today,
        "EXPIRED_INBOUND",
        "Không nhận hàng hết hạn trong phiếu nhập thông thường.",
        422,
      );
      const status = p.expiredDate <= today ? "EXPIRED" : p.status;
      const b = (
        await c.query(
          `INSERT INTO stock_pack_balances(product_id,location_id,lot_no,mes_pack_no,vendor_code,expired_date,on_hand,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            p.productId,
            p.locationId,
            p.lotNo,
            p.mesPackNo,
            p.vendorCode,
            p.expiredDate,
            p.quantity,
            status,
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO inbound_lines(receipt_id,pack_balance_id,quantity) VALUES($1,$2,$3)",
        [receipt.id, b.id, p.quantity],
      );
      await this.movement(
        c,
        actor,
        b.id,
        p.quantity,
        p.quantity,
        kind,
        "INBOUND_RECEIPT",
        receipt.id,
        receipt.effective_at,
      );
      ids.push(b.id);
    }
    return { id: receipt.id, reference, packs: ids };
  }
  async receiveManual(actor: Actor, key: string, body: unknown) {
    const b = validate(
      z.object({
        warehouseId: uuid,
        reference: text,
        packs: z.array(packSchema).min(1).max(1000),
      }),
      body,
    );
    return this.db.transaction((c) =>
      idempotent(c, actor.id, "receive", key, b, () =>
        this.receive(c, actor, b.warehouseId, b.reference, b.packs),
      ),
    );
  }
  async movement(
    c: PoolClient,
    actor: Actor,
    pack: string,
    delta: number,
    after: number,
    type: string,
    refType: string,
    ref: string,
    effectiveAt?: string,
  ) {
    await c.query(
      `INSERT INTO stock_movements(pack_balance_id,product_id,location_id,quantity_delta,balance_after,movement_type,reference_type,reference_id,actor_id,effective_at)
      SELECT id,product_id,location_id,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()) FROM stock_pack_balances WHERE id=$1`,
      [pack, delta, after, type, refType, ref, actor.id, effectiveAt || null],
    );
  }
  async createOrder(actor: Actor, key: string, body: unknown) {
    const b = validate(
      z.object({
        warehouseId: uuid,
        reference: text,
        lines: z
          .array(z.object({ productId: uuid, quantity }))
          .min(1)
          .max(100),
      }),
      body,
    );
    ensure(
      new Set(b.lines.map((l) => l.productId)).size === b.lines.length,
      "DUPLICATE_PRODUCT",
      "Gộp số lượng các dòng cùng sản phẩm.",
      422,
    );
    return this.db.transaction((c) =>
      idempotent(c, actor.id, "create-order", key, b, async () => {
        await writableWarehouse(c, actor, b.warehouseId);
        const o = (
          await c.query(
            "INSERT INTO outbound_orders(warehouse_id,reference,actor_id) VALUES($1,$2,$3) RETURNING *",
            [b.warehouseId, b.reference, actor.id],
          )
        ).rows[0];
        for (const l of b.lines)
          await c.query(
            "INSERT INTO outbound_lines(order_id,product_id,quantity) VALUES($1,$2,$3)",
            [o.id, l.productId, l.quantity],
          );
        return o;
      }),
    );
  }
  async transition(
    actor: Actor,
    key: string,
    id: string,
    action: "reserve" | "ship" | "cancel",
  ) {
    validate(uuid, id);
    return this.db.transaction((c) =>
      idempotent(c, actor.id, `order-${action}`, key, { id }, async () => {
        const found = await c.query(
          "SELECT * FROM outbound_orders WHERE id=$1",
          [id],
        );
        ensure(found.rowCount, "NOT_FOUND", "Không tìm thấy phiếu xuất.", 404);
        await writableWarehouse(c, actor, found.rows[0].warehouse_id);
        const o = (
          await c.query(
            "SELECT * FROM outbound_orders WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        const expected =
          action === "reserve"
            ? "RESERVED"
            : action === "ship"
              ? "SHIPPED"
              : "CANCELLED";
        if (o.status === expected) return o;
        const lines = (
          await c.query(
            "SELECT * FROM outbound_lines WHERE order_id=$1 ORDER BY product_id,id",
            [id],
          )
        ).rows;
        if (action === "reserve") {
          ensure(
            o.status === "DRAFT",
            "INVALID_STATE",
            "Chỉ giữ hàng cho phiếu nháp.",
          );
          for (const line of lines) {
            let remaining = Number(line.quantity);
            // Blocking locks preserve FEFO order; all orders use the same product/pack lock order.
            const candidates = await c.query(
              `SELECT b.* FROM stock_pack_balances b JOIN locations l ON l.id=b.location_id
            WHERE b.product_id=$1 AND l.warehouse_id=$2 AND b.status='AVAILABLE'
              AND b.expired_date>(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND b.on_hand>b.reserved
            ORDER BY b.expired_date,b.created_at,b.id FOR UPDATE OF b`,
              [line.product_id, o.warehouse_id],
            );
            for (const b of candidates.rows) {
              if (!remaining) break;
              const alloc = Math.min(
                remaining,
                Number(b.on_hand) - Number(b.reserved),
              );
              const changed = await c.query(
                `UPDATE stock_pack_balances SET reserved=reserved+$2,version=version+1,updated_at=now()
              WHERE id=$1 AND on_hand-reserved>=$2 AND status='AVAILABLE' AND expired_date>(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date RETURNING id`,
                [b.id, alloc],
              );
              ensure(
                changed.rowCount === 1,
                "INSUFFICIENT_STOCK",
                "Tồn khả dụng đã thay đổi.",
              );
              await c.query(
                "INSERT INTO stock_reservations(outbound_line_id,pack_balance_id,quantity) VALUES($1,$2,$3)",
                [line.id, b.id, alloc],
              );
              remaining -= alloc;
            }
            ensure(
              remaining === 0,
              "INSUFFICIENT_STOCK",
              `Không đủ tồn còn hạn cho sản phẩm ${line.product_id}.`,
            );
          }
        } else {
          ensure(
            action === "cancel"
              ? ["DRAFT", "RESERVED"].includes(o.status)
              : o.status === "RESERVED",
            "INVALID_STATE",
            "Trạng thái phiếu không cho phép thao tác này.",
          );
          const reservations = (
            await c.query(
              `SELECT r.*,b.on_hand,b.reserved,b.status AS pack_status,b.expired_date::text,
            (b.expired_date>(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS unexpired
          FROM stock_reservations r JOIN stock_pack_balances b ON b.id=r.pack_balance_id JOIN outbound_lines ol ON ol.id=r.outbound_line_id
          WHERE ol.order_id=$1 AND r.status='ACTIVE' ORDER BY b.product_id,b.expired_date,b.created_at,b.id,r.id FOR UPDATE OF b,r`,
              [id],
            )
          ).rows;
          if (action === "ship") {
            ensure(
              reservations.length > 0,
              "NO_RESERVATIONS",
              "Phiếu chưa có hàng được giữ.",
            );
            for (const line of lines)
              ensure(
                reservations
                  .filter((r) => r.outbound_line_id === line.id)
                  .reduce((s, r) => s + Number(r.quantity), 0) ===
                  Number(line.quantity),
                "RESERVATION_MISMATCH",
                "Lượng giữ hàng không khớp phiếu.",
              );
            for (const r of reservations) {
              ensure(
                r.pack_status === "AVAILABLE",
                "PACK_NOT_AVAILABLE",
                "Pack đã bị khóa hoặc cách ly.",
              );
              ensure(
                r.unexpired,
                "EXPIRED_DURING_RESERVATION",
                "Pack đã hết hạn sau khi giữ hàng. Hãy hủy phiếu để giải phóng giữ chỗ.",
              );
            }
          }
          const grouped = new Map<string, number>();
          for (const r of reservations)
            grouped.set(
              r.pack_balance_id,
              (grouped.get(r.pack_balance_id) || 0) + Number(r.quantity),
            );
          for (const [pack, qty] of grouped) {
            const changed = await c.query(
              `UPDATE stock_pack_balances SET reserved=reserved-$2,on_hand=on_hand-$3,version=version+1,updated_at=now()
            WHERE id=$1 AND reserved>=$2 AND on_hand>=$3
              AND ($4::boolean=false OR (status='AVAILABLE' AND expired_date>(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)) RETURNING on_hand`,
              [pack, qty, action === "ship" ? qty : 0, action === "ship"],
            );
            ensure(
              changed.rowCount === 1,
              "STOCK_CONFLICT",
              "Số dư hoặc trạng thái pack đã thay đổi.",
            );
            if (action === "ship")
              await this.movement(
                c,
                actor,
                pack,
                -qty,
                Number(changed.rows[0].on_hand),
                "OUTBOUND",
                "OUTBOUND_ORDER",
                id,
              );
          }
          await c.query(
            "UPDATE stock_reservations SET status=$2,updated_at=now() WHERE outbound_line_id=ANY($1::uuid[]) AND status='ACTIVE'",
            [
              lines.map((l) => l.id),
              action === "ship" ? "SHIPPED" : "RELEASED",
            ],
          );
        }
        return (
          await c.query(
            "UPDATE outbound_orders SET status=$2 WHERE id=$1 RETURNING *",
            [id, expected],
          )
        ).rows[0];
      }),
    );
  }
  async setStatus(actor: Actor, key: string, id: string, body: unknown) {
    const b = validate(
      z.object({
        status: z.enum(["AVAILABLE", "QUARANTINE", "LOCKED", "EXPIRED"]),
      }),
      body,
    );
    return this.db.transaction((c) =>
      idempotent(c, actor.id, "pack-status", key, { id, ...b }, async () => {
        const row = (
          await c.query(
            "SELECT l.warehouse_id FROM stock_pack_balances b JOIN locations l ON l.id=b.location_id WHERE b.id=$1",
            [validate(uuid, id)],
          )
        ).rows[0];
        ensure(row, "NOT_FOUND", "Không tìm thấy pack.", 404);
        await writableWarehouse(c, actor, row.warehouse_id);
        return (
          await c.query(
            "UPDATE stock_pack_balances SET status=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id, b.status],
          )
        ).rows[0];
      }),
    );
  }
}
