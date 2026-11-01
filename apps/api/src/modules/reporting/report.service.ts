import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PoolClient } from "pg";
import { Database } from "../../database/db";
import { Actor } from "../identity/auth";
import { scope } from "../warehouse/access";
import { validate, uuid, date } from "../../shared/validation";
import { ensure } from "../../shared/errors";
export const reportTypes = ["aging", "movements", "trace", "period"] as const;
@Injectable()
export class ReportService {
  constructor(@Inject(Database) readonly db: Database) {}
  async dashboard(actor: Actor, warehouse: string) {
    validate(uuid, warehouse);
    scope(actor, warehouse);
    return this.db.transaction(async (c) => {
      const asOf = (await c.query("SELECT now() AS t")).rows[0].t;
      const units = (
        await c.query(
          `SELECT p.base_uom,sum(b.on_hand) AS on_hand,sum(b.reserved) AS reserved,
        COALESCE(sum(b.on_hand-b.reserved) FILTER(WHERE b.status='AVAILABLE' AND b.expired_date>(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),0) AS available,
        count(*) FILTER(WHERE b.on_hand>0) AS packs,
        count(*) FILTER(WHERE b.on_hand>0 AND b.expired_date<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS expired,
        count(*) FILTER(WHERE b.on_hand>0 AND b.expired_date>(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND b.expired_date<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+30) AS expiring
        FROM stock_pack_balances b JOIN products p ON p.id=b.product_id JOIN locations l ON l.id=b.location_id WHERE l.warehouse_id=$1 GROUP BY p.base_uom ORDER BY p.base_uom`,
          [warehouse],
        )
      ).rows;
      const days = (
        await c.query(
          `SELECT (m.effective_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day,p.base_uom,
        sum(CASE WHEN m.movement_type='INBOUND' THEN m.quantity_delta ELSE 0 END) AS inbound,
        sum(CASE WHEN m.movement_type='OUTBOUND' THEN -m.quantity_delta ELSE 0 END) AS outbound
        FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN locations l ON l.id=m.location_id
        WHERE l.warehouse_id=$1 AND m.effective_at>=now()-interval '30 days' GROUP BY 1,2 ORDER BY 1`,
          [warehouse],
        )
      ).rows;
      const activity = (
        await c.query(
          `SELECT count(DISTINCT reference_id) FILTER(WHERE movement_type='INBOUND') AS receipts,
        count(DISTINCT reference_id) FILTER(WHERE movement_type='OUTBOUND') AS shipments FROM stock_movements m JOIN locations l ON l.id=m.location_id
        WHERE l.warehouse_id=$1 AND (m.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
          [warehouse],
        )
      ).rows[0];
      return { asOf, timezone: "Asia/Ho_Chi_Minh", units, days, activity };
    }, true);
  }

  async outboundMatrix(actor: Actor, warehouse: string, daysCount: number = 7) {
    validate(uuid, warehouse);
    scope(actor, warehouse);
    return this.db.transaction(async (c) => {
      const dayNamesVi = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
      const dates: { date: string; dayName: string; label: string }[] = [];
      const now = new Date();
      for (let i = daysCount - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const dateStr = `${yyyy}-${mm}-${dd}`;
        const dayOfWeek = d.getDay();
        const dayName = dayNamesVi[dayOfWeek];
        dates.push({
          date: dateStr,
          dayName,
          label: `${dd}/${mm} (${dayName})`,
        });
      }

      const startDate = dates[0].date;
      const finishDate = dates[dates.length - 1].date;

      const movements = (
        await c.query(
          `SELECT 
            m.product_id,
            (m.effective_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day,
            sum(-m.quantity_delta) AS outbound_qty,
            u.display_name AS actor_name,
            u.username AS actor_username,
            max(m.effective_at) AS last_time
           FROM stock_movements m
           JOIN locations l ON l.id = m.location_id
           JOIN users u ON u.id = m.actor_id
           WHERE l.warehouse_id = $1 
             AND m.movement_type = 'OUTBOUND'
             AND (m.effective_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $2::date
             AND (m.effective_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $3::date
           GROUP BY m.product_id, 2, u.display_name, u.username
           ORDER BY last_time DESC`,
          [warehouse, startDate, finishDate],
        )
      ).rows;

      const products = (
        await c.query(
          `SELECT 
            p.id,
            p.part_no,
            p.specification,
            p.model,
            p.finished_goods_code,
            p.base_uom,
            COALESCE(sum(b.on_hand), 0) AS on_hand,
            COALESCE(sum(b.reserved), 0) AS reserved,
            COALESCE(sum(b.on_hand - b.reserved) FILTER(WHERE b.status='AVAILABLE' AND b.expired_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0) AS available,
            max(b.updated_at) AS last_stock_update
           FROM products p
           LEFT JOIN stock_pack_balances b ON b.product_id = p.id
           LEFT JOIN locations l ON l.id = b.location_id AND l.warehouse_id = $1
           GROUP BY p.id, p.part_no, p.specification, p.model, p.finished_goods_code, p.base_uom
           ORDER BY on_hand DESC, p.part_no`,
          [warehouse],
        )
      ).rows;

      const items = products.map((p) => {
        const prodMovements = movements.filter((m) => m.product_id === p.id);
        const dailyOutbound: Record<string, number> = {};
        let totalOutbound = 0;
        let lastOutboundAt = null;
        let lastOutboundBy = null;

        for (const m of prodMovements) {
          const qty = Number(m.outbound_qty || 0);
          dailyOutbound[m.day] = (dailyOutbound[m.day] || 0) + qty;
          totalOutbound += qty;
          if (!lastOutboundAt || new Date(m.last_time) > new Date(lastOutboundAt)) {
            lastOutboundAt = m.last_time;
            lastOutboundBy = m.actor_name || m.actor_username;
          }
        }

        return {
          id: p.id,
          partNo: p.part_no,
          specification: p.specification,
          model: p.model,
          finishedGoodsCode: p.finished_goods_code,
          baseUom: p.base_uom,
          onHand: Number(p.on_hand),
          reserved: Number(p.reserved),
          available: Number(p.available),
          dailyOutbound,
          totalOutbound,
          lastOutboundAt,
          lastOutboundBy,
          lastUpdated: p.last_stock_update || lastOutboundAt || null,
        };
      });

      return { dates, items };
    }, true);
  }

  async productDetail(actor: Actor, productId: string, warehouse: string) {
    validate(uuid, productId);
    validate(uuid, warehouse);
    scope(actor, warehouse);
    return this.db.transaction(async (c) => {
      const product = (
        await c.query(
          `SELECT id, part_no, specification, model, finished_goods_code, base_uom, default_vendor_code, created_at
           FROM products WHERE id=$1`,
          [productId],
        )
      ).rows[0];
      ensure(product, "NOT_FOUND", "Không tìm thấy sản phẩm.", 404);

      const stockSummary = (
        await c.query(
          `SELECT 
            COALESCE(sum(b.on_hand), 0) AS on_hand,
            COALESCE(sum(b.reserved), 0) AS reserved,
            COALESCE(sum(b.on_hand - b.reserved) FILTER(WHERE b.status='AVAILABLE' AND b.expired_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0) AS available,
            COALESCE(sum(b.on_hand) FILTER(WHERE b.expired_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0) AS expired,
            count(b.id) AS packs_count
           FROM stock_pack_balances b
           JOIN locations l ON l.id = b.location_id
           WHERE b.product_id = $1 AND l.warehouse_id = $2`,
          [productId, warehouse],
        )
      ).rows[0];

      const packs = (
        await c.query(
          `SELECT b.id, b.mes_pack_no, b.lot_no, l.code AS location_code, l.name AS location_name,
                  b.on_hand, b.reserved, b.expired_date, b.status, b.created_at, b.updated_at
           FROM stock_pack_balances b
           JOIN locations l ON l.id = b.location_id
           WHERE b.product_id = $1 AND l.warehouse_id = $2
           ORDER BY b.expired_date ASC, b.created_at ASC`,
          [productId, warehouse],
        )
      ).rows;

      const recentMovements = (
        await c.query(
          `SELECT m.id, m.movement_type, m.quantity_delta, m.balance_after, m.effective_at,
                  m.reference_type, u.display_name AS actor_name, u.username AS actor_username,
                  l.code AS location_code
           FROM stock_movements m
           JOIN locations l ON l.id = m.location_id
           JOIN users u ON u.id = m.actor_id
           WHERE m.product_id = $1 AND l.warehouse_id = $2
           ORDER BY m.effective_at DESC, m.created_at DESC LIMIT 30`,
          [productId, warehouse],
        )
      ).rows;

      return {
        product,
        stockSummary: {
          onHand: Number(stockSummary.on_hand),
          reserved: Number(stockSummary.reserved),
          available: Number(stockSummary.available),
          expired: Number(stockSummary.expired),
          packsCount: Number(stockSummary.packs_count),
        },
        packs,
        recentMovements,
      };
    }, true);
  }
  async query(
    actor: Actor,
    type: string,
    q: any,
    c: Pick<PoolClient, "query"> = this.db.pool,
  ) {
    validate(z.enum(reportTypes), type);
    const warehouse = validate(uuid, q.warehouseId);
    scope(actor, warehouse);
    if (type === "period") {
      const from = validate(date, q.from),
        to = validate(date, q.to);
      ensure(
        from < to,
        "INVALID_PERIOD",
        "Đến ngày phải lớn hơn Từ ngày; khoảng báo cáo không gồm ngày kết thúc.",
        422,
      );
      const w = (
        await c.query(
          "SELECT cutover_at,(cutover_at AT TIME ZONE timezone)::date::text AS cutover_date FROM warehouses WHERE id=$1",
          [warehouse],
        )
      ).rows[0];
      ensure(w, "NOT_FOUND", "Kho không tồn tại.", 404);
      ensure(
        !w.cutover_date || from >= w.cutover_date,
        "BEFORE_CUTOVER",
        "Kỳ báo cáo bắt đầu trước ngày chuyển đổi tồn.",
        422,
      );
      return {
        text: `WITH bounds AS (SELECT GREATEST($2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh',COALESCE(cutover_at,'-infinity'::timestamptz)) AS start,
          $3::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS finish FROM warehouses WHERE id=$1),
        totals AS (SELECT p.part_no,p.specification,p.base_uom,p.model,p.finished_goods_code,
          COALESCE(sum(m.quantity_delta) FILTER(WHERE m.effective_at<b.start OR (m.movement_type='OPENING_BALANCE' AND m.effective_at=b.start)),0) AS opening,
          COALESCE(sum(m.quantity_delta) FILTER(WHERE m.effective_at>=b.start AND m.movement_type='INBOUND'),0) AS inbound,
          COALESCE(sum(-m.quantity_delta) FILTER(WHERE m.effective_at>=b.start AND m.movement_type='OUTBOUND'),0) AS outbound,
          COALESCE(sum(m.quantity_delta) FILTER(WHERE m.effective_at>=b.start AND m.movement_type IN ('ADJUSTMENT','TRANSFER')),0) AS adjustment,
          sum(m.quantity_delta) AS closing
        FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN locations l ON l.id=m.location_id CROSS JOIN bounds b
        WHERE l.warehouse_id=$1 AND m.effective_at<b.finish GROUP BY p.id,p.part_no,p.specification,p.base_uom,p.model,p.finished_goods_code)
        SELECT * FROM totals ORDER BY part_no`,
        values: [warehouse, from, to],
      };
    }
    if (type === "movements" || type === "trace") {
      const pack = String(q.pack || "").slice(0, 100);
      ensure(
        type !== "trace" || pack.length > 0,
        "PACK_REQUIRED",
        "Nhập MES Pack No để truy vết.",
        422,
      );
      return {
        text: `SELECT m.id,m.effective_at,m.created_at,p.part_no,p.specification,p.base_uom,p.model,p.finished_goods_code,b.lot_no,b.mes_pack_no,l.code AS location,
          m.quantity_delta,m.balance_after,m.movement_type,m.reference_type,m.reference_id,u.display_name AS actor,r.import_job_id
        FROM stock_movements m JOIN stock_pack_balances b ON b.id=m.pack_balance_id JOIN products p ON p.id=m.product_id
        JOIN locations l ON l.id=m.location_id JOIN users u ON u.id=m.actor_id LEFT JOIN inbound_receipts r ON r.id=m.reference_id AND m.reference_type='INBOUND_RECEIPT'
        WHERE l.warehouse_id=$1 AND ($2='' OR b.mes_pack_no=$2) ORDER BY m.effective_at DESC,m.created_at DESC,m.id`,
        values: [warehouse, pack],
      };
    }
    return {
      text: `SELECT b.id,p.part_no,p.specification,p.base_uom,p.model,p.finished_goods_code,b.lot_no,b.mes_pack_no,b.vendor_code,l.code AS location,b.on_hand,b.reserved,
        CASE WHEN b.status='AVAILABLE' AND b.expired_date>(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN b.on_hand-b.reserved ELSE 0 END AS available,
        b.expired_date::text AS expired_date,b.expired_date-(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS days_left,
        CASE WHEN b.expired_date<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN 'HẾT HẠN'
          WHEN b.expired_date<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+30 THEN 'CẬN HẠN'
          WHEN b.expired_date<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+90 THEN 'SẮP ĐẾN HẠN' ELSE 'AN TOÀN' END AS aging,b.status
      FROM stock_pack_balances b JOIN products p ON p.id=b.product_id JOIN locations l ON l.id=b.location_id
      WHERE l.warehouse_id=$1 AND b.on_hand>0 ORDER BY b.expired_date,b.mes_pack_no`,
      values: [warehouse],
    };
  }
  async report(actor: Actor, type: string, q: any) {
    return this.db.transaction(async (c) => {
      const query = await this.query(actor, type, q, c),
        offset = Math.max(Number(q.offset) || 0, 0),
        limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const count = Number(
        (await c.query(`SELECT count(*) FROM (${query.text}) r`, query.values))
          .rows[0].count,
      );
      const rows = (
        await c.query(
          `${query.text} LIMIT ${limit} OFFSET ${offset}`,
          query.values,
        )
      ).rows;
      return {
        rows,
        total: count,
        asOf: (await c.query("SELECT now() AS t")).rows[0].t,
        timezone: "Asia/Ho_Chi_Minh",
      };
    }, true);
  }
}
