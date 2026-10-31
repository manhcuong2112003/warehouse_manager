import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PoolClient } from "pg";
import { z } from "zod";
import { Database } from "../../database/db";
import { ensure } from "../../shared/errors";
import { hash, idempotent } from "../../shared/idempotency";
import { date, text, uuid, validate } from "../../shared/validation";
import { Actor } from "../identity/auth";
import { InventoryService } from "../inventory/inventory.service";
import { scope, writableWarehouse } from "../warehouse/access";
import { parseBarcode } from "./barcode";
export const scanSchema = z.object({
  draftId: uuid,
  scanEventId: uuid,
  raw: z.string().min(1).max(4096),
  targetLineId: uuid.optional(),
  newLineId: uuid.optional(),
});
@Injectable()
export class InboundService {
  changed: (draft: string) => void = () => {};
  revoked: (pairing: string) => void = () => {};
  constructor(
    @Inject(Database) readonly db: Database,
    @Inject(InventoryService) private inventory: InventoryService,
  ) {}
  async draft(actor: Actor, body: unknown) {
    const b = validate(z.object({ warehouseId: uuid, locationId: uuid }), body);
    return this.db.transaction(async (c) => {
      await writableWarehouse(c, actor, b.warehouseId);
      const l = await c.query(
        "SELECT id FROM locations WHERE id=$1 AND warehouse_id=$2",
        [b.locationId, b.warehouseId],
      );
      ensure(l.rowCount, "INVALID_LOCATION", "Vị trí không thuộc kho.", 422);
      return (
        await c.query(
          "INSERT INTO inbound_drafts(warehouse_id,location_id,actor_id) VALUES($1,$2,$3) RETURNING *",
          [b.warehouseId, b.locationId, actor.id],
        )
      ).rows[0];
    });
  }
  async checkDraft(c: PoolClient, actor: Actor, id: string, lock = false) {
    const d = (
      await c.query(
        `SELECT * FROM inbound_drafts WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
        [validate(uuid, id)],
      )
    ).rows[0];
    ensure(d, "NOT_FOUND", "Không tìm thấy phiếu nháp.", 404);
    scope(actor, d.warehouse_id);
    ensure(
      actor.role === "ADMIN" || d.actor_id === actor.id,
      "FORBIDDEN",
      "Phiếu nháp thuộc người dùng khác.",
      403,
    );
    return d;
  }
  async pairing(c: PoolClient, token: string) {
    ensure(
      typeof token === "string" && token.length < 200,
      "PAIRING_INVALID",
      "Phiên quét không hợp lệ.",
      401,
    );
    const r = await c.query(
      `SELECT p.*,u.role,u.username,u.display_name,d.warehouse_id,d.status AS draft_status,
      ARRAY(SELECT warehouse_id FROM user_warehouses WHERE user_id=p.actor_id) AS warehouses
      FROM scanner_pairings p JOIN sessions s ON s.token_hash=p.session_hash JOIN users u ON u.id=p.actor_id JOIN inbound_drafts d ON d.id=p.draft_id
      WHERE p.token_hash=$1 AND p.status='ACTIVE' AND p.expires_at>now() AND s.expires_at>now() AND u.active FOR SHARE OF p,s`,
      [hash(token)],
    );
    ensure(
      r.rowCount,
      "PAIRING_EXPIRED",
      "Phiên quét đã hết hạn hoặc bị thu hồi.",
      401,
    );
    const p = r.rows[0];
    ensure(p.draft_status === "OPEN", "DRAFT_CLOSED", "Phiếu nháp đã đóng.");
    const actor: Actor = {
      id: p.actor_id,
      role: p.role,
      username: p.username,
      display_name: p.display_name,
      warehouses: p.warehouses,
    };
    scope(actor, p.warehouse_id);
    return { pairing: p, actor };
  }
  async makePairing(actor: Actor, id: string) {
    const token = randomBytes(32).toString("base64url");
    const pairing = await this.db.transaction(async (c) => {
      const d = await this.checkDraft(c, actor, id, true);
      ensure(d.status === "OPEN", "DRAFT_CLOSED", "Phiếu đã đóng.");
      return (
        await c.query(
          "INSERT INTO scanner_pairings(draft_id,actor_id,session_hash,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes') RETURNING id,expires_at",
          [id, actor.id, actor.session_hash, hash(token)],
        )
      ).rows[0];
    });
    return { ...pairing, token, draftId: id };
  }
  async refresh(token: string) {
    return this.db.transaction(async (c) => {
      const { pairing } = await this.pairing(c, token);
      return (
        await c.query(
          "UPDATE scanner_pairings SET expires_at=now()+interval '30 minutes' WHERE id=$1 RETURNING expires_at",
          [pairing.id],
        )
      ).rows[0];
    });
  }
  async revoke(actor: Actor, id: string) {
    const revoked = await this.db.transaction(async (c) => {
      await this.checkDraft(c, actor, id);
      return (
        await c.query(
          "UPDATE scanner_pairings SET status='REVOKED' WHERE draft_id=$1 AND status='ACTIVE' RETURNING id",
          [id],
        )
      ).rows;
    });
    revoked.forEach((p) => this.revoked(p.id));
    return { ok: true };
  }
  async scan(payload: unknown, actor?: Actor, token?: string) {
    const b = validate(scanSchema, payload);
    const result = await this.db
      .transaction(async (c) => {
        let pairingId: string | null = null;
        if (token) {
          const auth = await this.pairing(c, token);
          actor = auth.actor;
          pairingId = auth.pairing.id;
          ensure(
            auth.pairing.draft_id === b.draftId,
            "PAIRING_SCOPE",
            "Token không thuộc phiếu này.",
            403,
          );
        }
        ensure(actor, "UNAUTHENTICATED", "Cần đăng nhập hoặc ghép nối.", 401);
        const d = await this.checkDraft(c, actor, b.draftId, true);
        ensure(d.status === "OPEN", "DRAFT_CLOSED", "Phiếu nháp đã đóng.");
        await writableWarehouse(c, actor, d.warehouse_id);
        const old = (
          await c.query(
            "SELECT * FROM inbound_scan_events WHERE draft_id=$1 AND scan_event_id=$2",
            [b.draftId, b.scanEventId],
          )
        ).rows[0];
        if (old) {
          ensure(
            old.request_hash === hash(b),
            "SCAN_EVENT_CONFLICT",
            "Event ID đã dùng với dữ liệu khác.",
          );
          return { ...old.response, status: "ACCEPTED_IDEMPOTENT" };
        }
        const parsed = parseBarcode(b.raw);
        let line: any;
        if (b.targetLineId) {
          line = (
            await c.query(
              "SELECT * FROM inbound_draft_lines WHERE id=$1 AND draft_id=$2 AND NOT deleted FOR UPDATE",
              [b.targetLineId, b.draftId],
            )
          ).rows[0];
          ensure(
            line,
            "LINE_NOT_FOUND",
            "Không tìm thấy dòng cần bổ sung.",
            404,
          );
          ensure(
            line.status !== "COMPLETE",
            "LINE_COMPLETE",
            "Dòng đã hoàn tất.",
          );
          if (parsed.partNo) {
            const p = (
              await c.query("SELECT part_no FROM products WHERE id=$1", [
                line.product_id,
              ])
            ).rows[0];
            ensure(
              p.part_no === parsed.partNo,
              "SCAN_MISMATCH",
              "Part No không khớp dòng đang chọn.",
              422,
            );
          }
          ensure(
            !parsed.lotNo || parsed.lotNo === line.lot_no,
            "SCAN_MISMATCH",
            "Lot không khớp dòng đang chọn.",
            422,
          );
          ensure(
            !parsed.quantity || parsed.quantity === Number(line.quantity),
            "SCAN_MISMATCH",
            "Số lượng không khớp dòng đang chọn.",
            422,
          );
          const pack = parsed.mesPackNo || line.mes_pack_no,
            exp = parsed.expiredDate || line.expired_date;
          line = (
            await c.query(
              "UPDATE inbound_draft_lines SET mes_pack_no=$2,expired_date=$3,status=$4,updated_at=now() WHERE id=$1 RETURNING *",
              [
                line.id,
                pack,
                exp,
                pack && exp
                  ? "COMPLETE"
                  : pack
                    ? "WAITING_EXP_DATE"
                    : "AWAITING_PACK_SCAN",
              ],
            )
          ).rows[0];
        } else {
          ensure(
            parsed.partNo &&
              parsed.lotNo &&
              parsed.quantity &&
              parsed.vendorCode,
            "INCOMPLETE_FIRST_SCAN",
            "Quét mã 1D đầy đủ trước, hoặc chọn dòng cần bổ sung mã pack.",
            422,
          );
          const product = (
            await c.query("SELECT id FROM products WHERE part_no=$1", [
              parsed.partNo,
            ])
          ).rows[0];
          ensure(
            product,
            "UNKNOWN_PRODUCT",
            "Part No chưa có trong danh mục. Hãy tạo hoặc import danh mục trước.",
            422,
          );
          line = (
            await c.query(
              `INSERT INTO inbound_draft_lines(draft_id,product_id,lot_no,quantity,vendor_code,po_type,mes_pack_no,expired_date,status,id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::uuid,gen_random_uuid())) RETURNING *`,
              [
                b.draftId,
                product.id,
                parsed.lotNo,
                parsed.quantity,
                parsed.vendorCode,
                parsed.poType || null,
                parsed.mesPackNo || null,
                parsed.expiredDate || null,
                parsed.mesPackNo && parsed.expiredDate
                  ? "COMPLETE"
                  : parsed.mesPackNo
                    ? "WAITING_EXP_DATE"
                    : "AWAITING_PACK_SCAN",
                b.newLineId || null,
              ],
            )
          ).rows[0];
        }
        const ack = {
          scanEventId: b.scanEventId,
          status: "ACCEPTED",
          item: line,
        };
        await c.query(
          "INSERT INTO inbound_scan_events(draft_id,scan_event_id,pairing_id,actor_id,request_hash,raw_payload,draft_line_id,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            b.draftId,
            b.scanEventId,
            pairingId,
            actor.id,
            hash(b),
            b.raw,
            line.id,
            JSON.stringify(ack),
          ],
        );
        return ack;
      })
      .catch((e) => {
        if (e.code === "23505" && e.constraint === "uq_draft_line_mes_pack")
          ensure(
            false,
            "DUPLICATE_PACK_SCANNED",
            "Pack đã được quét trong phiếu này.",
          );
        throw e;
      });
    this.changed(b.draftId);
    return result;
  }
  async setExpiry(actor: Actor, draft: string, lineId: string, body: unknown) {
    const b = validate(z.object({ expiredDate: date }), body);
    const result = await this.db.transaction(async (c) => {
      const d = await this.checkDraft(c, actor, draft, true);
      ensure(d.status === "OPEN", "DRAFT_CLOSED", "Phiếu đã đóng.");
      const l = (
        await c.query(
          "UPDATE inbound_draft_lines SET expired_date=$3,status=CASE WHEN mes_pack_no IS NULL THEN 'AWAITING_PACK_SCAN' ELSE 'COMPLETE' END,updated_at=now() WHERE id=$1 AND draft_id=$2 RETURNING *",
          [validate(uuid, lineId), draft, b.expiredDate],
        )
      ).rows[0];
      ensure(l, "NOT_FOUND", "Không tìm thấy dòng.", 404);
      return l;
    });
    this.changed(draft);
    return result;
  }
  async confirm(actor: Actor, key: string, id: string) {
    const result = await this.db.transaction((c) =>
      idempotent(c, actor.id, "confirm-draft", key, { id }, async () => {
        const d = await this.checkDraft(c, actor, id, true);
        if (d.status === "CONFIRMED")
          return (
            await c.query("SELECT id FROM inbound_receipts WHERE draft_id=$1", [
              id,
            ])
          ).rows[0];
        ensure(d.status === "OPEN", "DRAFT_CLOSED", "Phiếu đã đóng.");
        const lines = (
          await c.query(
            "SELECT *,expired_date::text AS expiry FROM inbound_draft_lines WHERE draft_id=$1 AND NOT deleted ORDER BY id",
            [id],
          )
        ).rows;
        ensure(
          lines.length > 0 && lines.every((l) => l.status === "COMPLETE"),
          "INCOMPLETE_DRAFT",
          "Cần hoàn tất tất cả dòng trước khi xác nhận.",
          422,
        );
        const r = await this.inventory.receive(
          c,
          actor,
          d.warehouse_id,
          `SCAN:${id}`,
          lines.map((l) => ({
            productId: l.product_id,
            locationId: d.location_id,
            lotNo: l.lot_no,
            mesPackNo: l.mes_pack_no,
            vendorCode: l.vendor_code,
            quantity: Number(l.quantity),
            expiredDate: l.expiry,
            status: "AVAILABLE",
          })),
          "INBOUND",
          undefined,
          undefined,
          id,
        );
        await c.query(
          "UPDATE inbound_drafts SET status='CONFIRMED' WHERE id=$1",
          [id],
        );
        return r;
      }),
    );
    this.changed(id);
    return result;
  }
}
