import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Req,
  Param,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { Database } from "../../database/db";
import { Admin } from "../identity/auth";
import { scope } from "../warehouse/access";
import { ensure } from "../../shared/errors";
import { text, uuid, validate } from "../../shared/validation";
@Controller()
export class CatalogController {
  constructor(@Inject(Database) private db: Database) {}
  @Get("warehouses") async warehouses(@Req() req: any) {
    return (
      await this.db.pool.query(
        "SELECT * FROM warehouses WHERE $1 OR id=ANY($2::uuid[]) ORDER BY code",
        [req.actor.role === "ADMIN", req.actor.warehouses],
      )
    ).rows;
  }
  @Get("locations") async locations(
    @Req() req: any,
    @Query("warehouseId") warehouseId: string,
  ) {
    validate(uuid, warehouseId);
    scope(req.actor, warehouseId);
    return (
      await this.db.pool.query(
        "SELECT * FROM locations WHERE warehouse_id=$1 ORDER BY code",
        [warehouseId],
      )
    ).rows;
  }
  @Admin() @Post("locations") async location(@Body() body: unknown) {
    const b = validate(
      z.object({ warehouseId: uuid, code: text, name: text }),
      body,
    );
    return (
      await this.db.pool.query(
        "INSERT INTO locations(warehouse_id,code,name) VALUES($1,$2,$3) RETURNING *",
        [b.warehouseId, b.code, b.name],
      )
    ).rows[0];
  }
  @Get("vendors") async vendors() {
    return (
      await this.db.pool.query("SELECT * FROM vendors ORDER BY code LIMIT 2000")
    ).rows;
  }
  @Admin() @Post("vendors") async vendor(@Body() body: unknown) {
    const b = validate(z.object({ code: text, name: text }), body);
    return (
      await this.db.pool.query(
        "INSERT INTO vendors(code,name) VALUES($1,$2) RETURNING *",
        [b.code, b.name],
      )
    ).rows[0];
  }
  @Get("products") async products(@Query("q") raw = "") {
    const q = String(raw).slice(0, 100);
    const pattern = q.replace(/[\\%_]/g, "\\$&");
    return (
      await this.db.pool.query(
        `SELECT * FROM products WHERE $1='' OR part_no=$1 OR
      (length($1)<3 AND part_no ILIKE $2||'%') OR
      (length($1)>=3 AND (part_no ILIKE '%'||$2||'%' OR specification ILIKE '%'||$2||'%' OR model ILIKE '%'||$2||'%' OR finished_goods_code ILIKE '%'||$2||'%'))
      ORDER BY (part_no=$1) DESC,part_no LIMIT 100`,
        [q, pattern],
      )
    ).rows;
  }
  @Admin() @Post("products") async product(@Body() body: unknown) {
    const b = validate(
      z.object({
        partNo: text,
        specification: text,
        baseUom: text.default("PCS"),
        vendorCode: text.nullish(),
        model: text.nullish(),
        finishedGoodsCode: text.nullish(),
      }),
      body,
    );
    return (
      await this.db.pool.query(
        "INSERT INTO products(part_no,specification,base_uom,default_vendor_code,model,finished_goods_code) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [b.partNo, b.specification, b.baseUom, b.vendorCode || null, b.model || null, b.finishedGoodsCode || null],
      )
    ).rows[0];
  }
  @Admin() @Put("products/:id") async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const b = validate(
      z.object({
        specification: text,
        model: text.nullish(),
        finishedGoodsCode: text.nullish(),
        version: z.number().int().nonnegative(),
      }),
      body,
    );
    const r = await this.db.pool.query(
      "UPDATE products SET specification=$2,model=COALESCE($3,model),finished_goods_code=COALESCE($4,finished_goods_code),version=version+1 WHERE id=$1 AND version=$5 RETURNING *",
      [validate(uuid, id), b.specification, b.model || null, b.finishedGoodsCode || null, b.version],
    );
    ensure(
      r.rowCount,
      "VERSION_CONFLICT",
      "Danh mục đã thay đổi. Tải lại trước khi sửa.",
    );
    return r.rows[0];
  }
}
