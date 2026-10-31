import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { Database } from "../../database/db";
import { InventoryService } from "./inventory.service";
import { validate, uuid, date } from "../../shared/validation";
import { z } from "zod";
import { scope } from "../warehouse/access";
@Controller()
export class InventoryController {
  constructor(
    @Inject(InventoryService) private inventory: InventoryService,
    @Inject(Database) private db: Database,
  ) {}
  @Post("inbound/receipts") receive(@Req() req: any, @Body() b: unknown) {
    return this.inventory.receiveManual(
      req.actor,
      req.headers["idempotency-key"],
      b,
    );
  }
  @Get("inventory/packs") async packs(@Req() req: any, @Query() q: any) {
    validate(uuid, q.warehouseId);
    scope(req.actor, q.warehouseId);
    const pattern = String(q.q || "")
      .slice(0, 100)
      .replace(/[\\%_]/g, "\\$&");
    const literal = String(q.q || "").slice(0, 100);
    const locationId = q.locationId ? validate(uuid, q.locationId) : null;
    const status = q.status
      ? validate(
          z.enum(["AVAILABLE", "QUARANTINE", "LOCKED", "EXPIRED"]),
          q.status,
        )
      : "";
    const expiryFrom = q.expiryFrom ? validate(date, q.expiryFrom) : null;
    const expiryTo = q.expiryTo ? validate(date, q.expiryTo) : null;
    const exactPack = literal
      ? (
          await this.db.pool.query(
            "SELECT id FROM stock_pack_balances WHERE mes_pack_no=$1",
            [literal],
          )
        ).rows[0]?.id
      : null;
    const exactProduct =
      literal && !exactPack
        ? (
            await this.db.pool.query(
              "SELECT id FROM products WHERE part_no=$1",
              [literal],
            )
          ).rows[0]?.id
        : null;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200),
      offset = Math.max(Number(q.offset) || 0, 0);
    const result = await this.db.pool.query(
      `SELECT b.*,b.expired_date::text AS expiry,p.part_no,p.specification,p.base_uom,p.model,p.finished_goods_code,l.code AS location_code,
       (b.expired_date-(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS days_left,
       CASE WHEN b.status='AVAILABLE' AND b.expired_date>(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN b.on_hand-b.reserved ELSE 0 END AS available,
       count(*) OVER() AS total_count
      FROM stock_pack_balances b JOIN products p ON p.id=b.product_id JOIN locations l ON l.id=b.location_id
      WHERE l.warehouse_id=$1 AND ($2='' OR ($6::uuid IS NOT NULL AND b.id=$6) OR ($7::uuid IS NOT NULL AND b.product_id=$7)
        OR ($6::uuid IS NULL AND $7::uuid IS NULL AND (p.part_no ILIKE '%'||$2||'%' OR p.specification ILIKE '%'||$2||'%' OR p.model ILIKE '%'||$2||'%' OR p.finished_goods_code ILIKE '%'||$2||'%' OR b.lot_no ILIKE '%'||$2||'%' OR b.mes_pack_no ILIKE '%'||$2||'%' OR b.vendor_code ILIKE '%'||$2||'%')))
      AND ($3='' OR ($3='expiring' AND b.on_hand>0 AND b.expired_date>(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND b.expired_date<=(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+30)
        OR ($3='expired' AND b.on_hand>0 AND b.expired_date<=(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) OR ($3='empty' AND b.on_hand=0)
        OR ($3='today' AND (b.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date))
      AND ($8::uuid IS NULL OR b.location_id=$8)
      AND ($9='' OR b.status=$9)
      AND ($10::date IS NULL OR b.expired_date>=$10)
      AND ($11::date IS NULL OR b.expired_date<=$11)
      ORDER BY b.expired_date,b.mes_pack_no LIMIT $4 OFFSET $5`,
      [
        q.warehouseId,
        pattern,
        q.preset || "",
        limit,
        offset,
        exactPack || null,
        exactProduct || null,
        locationId,
        status,
        expiryFrom,
        expiryTo,
      ],
    );
    return {
      rows: result.rows,
      total: Number(result.rows[0]?.total_count || 0),
    };
  }
  @Put("inventory/packs/:id/status") status(
    @Req() req: any,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.inventory.setStatus(
      req.actor,
      req.headers["idempotency-key"],
      id,
      b,
    );
  }
  @Get("outbound/orders") async orders(
    @Req() req: any,
    @Query("warehouseId") id: string,
  ) {
    validate(uuid, id);
    scope(req.actor, id);
    return (
      await this.db.pool.query(
        `SELECT o.*,json_agg(json_build_object('id',l.id,'product_id',l.product_id,'part_no',p.part_no,'quantity',l.quantity)) AS lines
      FROM outbound_orders o JOIN outbound_lines l ON l.order_id=o.id JOIN products p ON p.id=l.product_id WHERE o.warehouse_id=$1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`,
        [id],
      )
    ).rows;
  }
  @Post("outbound/orders") order(@Req() req: any, @Body() b: unknown) {
    return this.inventory.createOrder(
      req.actor,
      req.headers["idempotency-key"],
      b,
    );
  }
  @Post("outbound/orders/:id/reserve") reserve(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inventory.transition(
      req.actor,
      req.headers["idempotency-key"],
      id,
      "reserve",
    );
  }
  @Post("outbound/orders/:id/ship") ship(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inventory.transition(
      req.actor,
      req.headers["idempotency-key"],
      id,
      "ship",
    );
  }
  @Post("outbound/orders/:id/cancel") cancel(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inventory.transition(
      req.actor,
      req.headers["idempotency-key"],
      id,
      "cancel",
    );
  }
}
