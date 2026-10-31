import { Inject, Injectable } from "@nestjs/common";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { PoolClient } from "pg";
import { Open } from "unzipper";
import { Database } from "../../database/db";
import { ensure } from "../../shared/errors";
import { hash, idempotent } from "../../shared/idempotency";
import {
  date,
  text,
  uuid,
  validate,
  validateQuantity,
  warehouseDate,
} from "../../shared/validation";
import { Actor } from "../identity/auth";
import { scope } from "../warehouse/access";
import { InventoryService, ReceivePack } from "../inventory/inventory.service";
export const importKinds = [
  "PRODUCTS",
  "VENDORS",
  "LOCATIONS",
  "OPENING_BALANCE",
  "INBOUND",
] as const;
export const fields: Record<string, string[]> = {
  PRODUCTS: ["part_no", "specification", "base_uom", "vendor_code"],
  VENDORS: ["code", "name"],
  LOCATIONS: ["code", "name"],
  OPENING_BALANCE: [
    "part_no",
    "location_code",
    "lot_no",
    "mes_pack_no",
    "vendor_code",
    "quantity",
    "expired_date",
    "status",
  ],
  INBOUND: [
    "reference",
    "part_no",
    "location_code",
    "lot_no",
    "mes_pack_no",
    "vendor_code",
    "quantity",
    "expired_date",
    "status",
  ],
};
type Cell = { value: string | number | null; kind: string };
@Injectable()
export class ImportService {
  readonly maxRows = 1000;
  readonly maxBytes = 5 * 1024 * 1024;
  constructor(
    @Inject(Database) readonly db: Database,
    @Inject(InventoryService) private inventory: InventoryService,
  ) {}
  async check(
    actor: Actor,
    id: string,
    c: Pick<PoolClient, "query"> = this.db.pool,
  ) {
    const j = (
      await c.query("SELECT * FROM import_jobs WHERE id=$1", [
        validate(uuid, id),
      ])
    ).rows[0];
    ensure(j, "NOT_FOUND", "Không tìm thấy lượt nhập.", 404);
    scope(actor, j.warehouse_id);
    ensure(
      actor.role === "ADMIN" || j.actor_id === actor.id,
      "FORBIDDEN",
      "Lượt nhập thuộc người dùng khác.",
      403,
    );
    return j;
  }
  async upload(
    actor: Actor,
    warehouse: string,
    kind: unknown,
    name: string,
    buffer: Buffer,
  ) {
    validate(uuid, warehouse);
    scope(actor, warehouse);
    const type = validate(z.enum(importKinds), kind);
    ensure(
      ["OPENING_BALANCE", "INBOUND"].includes(type)
        ? type !== "OPENING_BALANCE" || actor.role === "ADMIN"
        : actor.role === "ADMIN",
      "FORBIDDEN",
      "Loại import này yêu cầu quyền quản trị.",
      403,
    );
    ensure(
      buffer.length <= this.maxBytes,
      "FILE_TOO_LARGE",
      "Tối đa 5 MB cho một file.",
      413,
    );
    const sheets: { name: string; rows: Cell[][] }[] = [];
    if (name.toLowerCase().endsWith(".csv")) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        ensure(
          false,
          "CSV_ENCODING",
          "Lưu CSV theo UTF-8 trước khi nhập.",
          422,
        );
      }
      const rows = parse(buffer, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        to: this.maxRows + 2,
        max_record_size: 100000,
      }) as string[][];
      sheets.push({
        name: "CSV",
        rows: rows.map((row) => row.map((value) => ({ value, kind: "text" }))),
      });
    } else {
      ensure(
        name.toLowerCase().endsWith(".xlsx"),
        "FILE_TYPE",
        "Hỗ trợ .xlsx hoặc CSV UTF-8.",
        422,
      );
      const archive = await Open.buffer(buffer);
      ensure(
        archive.files.length <= 2000 &&
          archive.files.reduce((sum, f) => sum + f.uncompressedSize, 0) <=
            50 * 1024 * 1024,
        "XLSX_EXPANSION_LIMIT",
        "Nội dung XLSX vượt giới hạn giải nén 50 MB.",
        422,
      );
      ensure(
        !archive.files.some((f) => /vbaProject\.bin$/i.test(f.path)),
        "MACROS_NOT_ALLOWED",
        "Chuyển file thành XLSX không có macro trước khi nhập.",
        422,
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);
      let count = 0;
      for (const sheet of wb.worksheets) {
        ensure(
          sheet.columnCount <= 100,
          "TOO_MANY_COLUMNS",
          "Tối đa 100 cột mỗi sheet.",
          422,
        );
        const rows: Cell[][] = [];
        sheet.eachRow({ includeEmpty: true }, (row) => {
          count++;
          ensure(
            count <= this.maxRows + 20,
            "TOO_MANY_ROWS",
            "Tối đa 1.000 dòng dữ liệu mỗi file ở phiên bản này.",
            422,
          );
          rows.push(
            Array.from({ length: sheet.columnCount }, (_, i) => {
              const v = row.getCell(i + 1).value;
              if (v instanceof Date)
                return { value: v.toISOString().slice(0, 10), kind: "date" };
              if (
                v &&
                typeof v === "object" &&
                ("formula" in v || "sharedFormula" in v)
              )
                return { value: row.getCell(i + 1).text, kind: "formula" };
              return {
                value:
                  v === null
                    ? null
                    : typeof v === "number"
                      ? v
                      : row.getCell(i + 1).text,
                kind: typeof v === "number" ? "number" : "text",
              };
            }),
          );
        });
        sheets.push({ name: sheet.name, rows });
      }
    }
    ensure(
      sheets.length > 0 && sheets.some((s) => s.rows.length > 1),
      "EMPTY_FILE",
      "File không có dòng dữ liệu.",
      422,
    );
    for (const s of sheets)
      ensure(
        s.rows.length <= this.maxRows + 1,
        "TOO_MANY_ROWS",
        "Tối đa 1.000 dòng dữ liệu mỗi sheet.",
        422,
      );
    const previous = await this.db.pool.query(
      "SELECT id FROM import_jobs WHERE file_hash=$1 AND warehouse_id=$2 AND kind=$3 LIMIT 1",
      [hash(buffer.toString("base64")), warehouse, type],
    );
    const job = (
      await this.db.pool.query(
        "INSERT INTO import_jobs(actor_id,warehouse_id,kind,file_name,file_hash,sheet_data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status",
        [
          actor.id,
          warehouse,
          type,
          name,
          hash(buffer.toString("base64")),
          JSON.stringify(sheets),
        ],
      )
    ).rows[0];
    return {
      ...job,
      previousImportId: previous.rows[0]?.id,
      sheets: sheets.map((s) => ({
        name: s.name,
        preview: s.rows.slice(0, 6),
        rowCount: s.rows.length,
      })),
      fields: fields[type],
    };
  }
  async get(actor: Actor, id: string) {
    const j = await this.check(actor, id);
    const { sheet_data, ...job } = j;
    return {
      ...job,
      sheets: sheet_data.map((s: any) => ({
        name: s.name,
        preview: s.rows.slice(0, 20),
        rowCount: s.rows.length,
      })),
      fields: fields[j.kind],
      rows: (
        await this.db.pool.query(
          "SELECT * FROM import_rows WHERE job_id=$1 ORDER BY source_row",
          [id],
        )
      ).rows,
    };
  }
  async mapping(actor: Actor, id: string, body: unknown) {
    const b = validate(
      z.object({
        mapping: z.record(z.string(), z.number().int().min(0).max(99)),
        options: z.object({
          sheet: text,
          headerRow: z.number().int().min(1).max(20).default(1),
          dateFormat: z.enum(["ISO", "DMY", "MDY"]).default("ISO"),
          thousands: z.enum(["", ",", "."]).default(""),
          profileName: z.string().trim().max(100).optional(),
        }),
      }),
      body,
    );
    return this.db.transaction(async (c) => {
      await c.query("SELECT id FROM import_jobs WHERE id=$1 FOR UPDATE", [
        validate(uuid, id),
      ]);
      const j = await this.check(actor, id, c);
      ensure(
        ["UPLOADED", "MAPPED", "VALIDATED", "FAILED"].includes(j.status),
        "JOB_CLOSED",
        "Lượt nhập đã được xử lý.",
      );
      ensure(
        j.sheet_data.some((s: any) => s.name === b.options.sheet),
        "SHEET_NOT_FOUND",
        "Sheet không tồn tại.",
        422,
      );
      await c.query("DELETE FROM import_rows WHERE job_id=$1", [id]);
      if (b.options.profileName)
        await c.query(
          "INSERT INTO import_mapping_profiles(actor_id,name,kind,mapping,options) VALUES($1,$2,$3,$4,$5) ON CONFLICT(actor_id,name,kind) DO UPDATE SET mapping=excluded.mapping,options=excluded.options",
          [
            actor.id,
            b.options.profileName,
            j.kind,
            JSON.stringify(b.mapping),
            JSON.stringify(b.options),
          ],
        );
      return (
        await c.query(
          "UPDATE import_jobs SET mapping=$2,options=$3,status='MAPPED',preview_version=preview_version+1,summary=NULL,updated_at=now() WHERE id=$1 RETURNING id,status,preview_version",
          [id, JSON.stringify(b.mapping), JSON.stringify(b.options)],
        )
      ).rows[0];
    });
  }
  normalizeDate(raw: string, format: string) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validate(date, raw);
    const m = raw.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
    ensure(
      m && format !== "ISO",
      "AMBIGUOUS_DATE",
      "Chọn quy tắc DMY/MDY hoặc dùng YYYY-MM-DD.",
      422,
    );
    const month = format === "DMY" ? m[2] : m[1],
      day = format === "DMY" ? m[1] : m[2];
    return validate(
      date,
      `${m[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    );
  }
  async validateJob(actor: Actor, id: string) {
    return this.db.transaction(async (c) => {
      await c.query("SELECT id FROM import_jobs WHERE id=$1 FOR UPDATE", [
        validate(uuid, id),
      ]);
      const j = await this.check(actor, id, c);
      ensure(
        j.mapping && ["MAPPED", "VALIDATED", "FAILED"].includes(j.status),
        "MAPPING_REQUIRED",
        "Ghép cột trước khi kiểm tra.",
        422,
      );
      const mandatoryFields: Record<string, string[]> = {
        PRODUCTS: ["part_no", "specification"],
        VENDORS: ["code", "name"],
        LOCATIONS: ["code", "name"],
        OPENING_BALANCE: [
          "part_no",
          "location_code",
          "lot_no",
          "mes_pack_no",
          "vendor_code",
          "quantity",
          "expired_date",
        ],
        INBOUND: ["reference", "part_no", "quantity", "vendor_code"],
      };
      const required = mandatoryFields[j.kind] || [];
      const missingMappings = required.filter(
        (f) =>
          j.mapping[f] === undefined ||
          j.mapping[f] === null ||
          j.mapping[f] < 0,
      );
      ensure(
        missingMappings.length === 0,
        "MAPPING_INCOMPLETE",
        `Vui lòng chọn cột tương ứng trong file cho các trường bắt buộc: ${missingMappings.join(", ")}.`,
        422,
      );
      const sheet = j.sheet_data.find((s: any) => s.name === j.options.sheet);
      const rows = sheet.rows.slice(j.options.headerRow) as Cell[][];
      ensure(
        rows.length <= this.maxRows,
        "TOO_MANY_ROWS",
        "Tối đa 1.000 dòng dữ liệu.",
        422,
      );
      await c.query("DELETE FROM import_rows WHERE job_id=$1", [id]);
      const seen = new Set<string>(),
        summary: any = {
          valid: 0,
          errors: 0,
          skipped: 0,
          create: 0,
          update: 0,
          totals: {},
        };
      for (let idx = 0; idx < rows.length; idx++) {
        const original = rows[idx];
        if (
          original.every(
            (cell) => cell.value === null || String(cell.value).trim() === "",
          )
        )
          continue;
        const n: any = {},
          errors: any[] = [],
          warnings: string[] = [];
        let version: number | null = null;
        for (const field of fields[j.kind]) {
          const cell = original[j.mapping[field]];
          n[field] = String(cell?.value ?? "").trim();
          if (cell?.kind === "formula")
            errors.push({
              column: field,
              message: "Chuyển công thức thành giá trị trước khi import.",
            });
          if (
            cell?.kind === "number" &&
            [
              "part_no",
              "lot_no",
              "mes_pack_no",
              "vendor_code",
              "location_code",
              "code",
            ].includes(field)
          )
            errors.push({
              column: field,
              message:
                "Mã phải lưu dạng Text; kiểm tra số 0 đầu và độ chính xác của file nguồn.",
            });
        }
        try {
          if (["PRODUCTS", "VENDORS", "LOCATIONS"].includes(j.kind)) {
            const key = j.kind === "PRODUCTS" ? "part_no" : "code";
            const nameKey = j.kind === "PRODUCTS" ? "specification" : "name";
            if (!n[key] && !n[nameKey]) {
              // Bỏ qua các dòng tiêu đề phụ, sub-header không chứa mã và tên
              continue;
            }
            if (!n[key]) {
              errors.push({
                column: key,
                message: `Cột mã (${key}) không được để trống.`,
              });
            }
            if (!n[nameKey]) {
              errors.push({
                column: nameKey,
                message: `Cột tên (${nameKey}) không được để trống.`,
              });
            }
            if (errors.length) {
              summary.errors++;
              await c.query(
                "INSERT INTO import_rows(job_id,sheet,source_row,original,normalized,errors,warnings,expected_version,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [
                  id,
                  sheet.name,
                  idx + j.options.headerRow + 1,
                  JSON.stringify(original),
                  JSON.stringify(n),
                  JSON.stringify(errors),
                  JSON.stringify(warnings),
                  null,
                  "ERROR",
                ],
              );
              continue;
            }
            validate(text, n[key]);
            validate(text, n[nameKey]);
            ensure(
              !seen.has(n[key]),
              "DUPLICATE_ROW",
              `Mã "${n[key]}" bị trùng trong file.`,
              422,
            );
            seen.add(n[key]);
            const existing =
              j.kind === "PRODUCTS"
                ? (
                    await c.query("SELECT * FROM products WHERE part_no=$1", [
                      n.part_no,
                    ])
                  ).rows[0]
                : j.kind === "VENDORS"
                  ? (
                      await c.query("SELECT * FROM vendors WHERE code=$1", [
                        n.code,
                      ])
                    ).rows[0]
                  : (
                      await c.query(
                        "SELECT * FROM locations WHERE warehouse_id=$1 AND code=$2",
                        [j.warehouse_id, n.code],
                      )
                    ).rows[0];
            version = existing ? Number(existing.version) : null;
            n.action = existing ? "UPDATE" : "CREATE";
            if (existing) n.before = existing;
            if (j.kind === "PRODUCTS") {
              n.base_uom = n.base_uom || "PCS";
              if (n.vendor_code)
                ensure(
                  (
                    await c.query("SELECT 1 FROM vendors WHERE code=$1", [
                      n.vendor_code,
                    ])
                  ).rowCount,
                  "UNKNOWN_VENDOR",
                  "Nhà cung cấp chưa có trong danh mục.",
                  422,
                );
              if (existing && existing.base_uom !== n.base_uom)
                ensure(
                  !(
                    await c.query(
                      "SELECT 1 FROM stock_pack_balances WHERE product_id=$1 LIMIT 1",
                      [existing.id],
                    )
                  ).rowCount,
                  "UOM_LOCKED",
                  "Không đổi đơn vị tính của sản phẩm đã có lịch sử tồn.",
                  422,
                );
            }
          } else {
            for (const f of [
              "part_no",
              "location_code",
              "lot_no",
              "mes_pack_no",
              "vendor_code",
              "quantity",
              "expired_date",
            ])
              validate(text, n[f]);
            ensure(
              !seen.has(n.mes_pack_no),
              "DUPLICATE_PACK",
              "Pack bị trùng trong file.",
              422,
            );
            seen.add(n.mes_pack_no);
            ensure(
              !(
                await c.query(
                  "SELECT 1 FROM stock_pack_balances WHERE mes_pack_no=$1",
                  [n.mes_pack_no],
                )
              ).rowCount,
              "PACK_EXISTS",
              "Pack đã tồn tại trong kho.",
              422,
            );
            const p = (
              await c.query(
                "SELECT id,base_uom FROM products WHERE part_no=$1",
                [n.part_no],
              )
            ).rows[0];
            ensure(
              p,
              "UNKNOWN_PRODUCT",
              "Part No chưa có trong danh mục.",
              422,
            );
            const l = (
              await c.query(
                "SELECT id FROM locations WHERE code=$1 AND warehouse_id=$2",
                [n.location_code, j.warehouse_id],
              )
            ).rows[0];
            ensure(l, "UNKNOWN_LOCATION", "Vị trí không thuộc kho.", 422);
            ensure(
              (
                await c.query("SELECT 1 FROM vendors WHERE code=$1", [
                  n.vendor_code,
                ])
              ).rowCount,
              "UNKNOWN_VENDOR",
              "Nhà cung cấp chưa có trong danh mục.",
              422,
            );
            let qty = n.quantity;
            if (j.options.thousands) {
              const sep = j.options.thousands;
              ensure(
                new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(qty) ||
                  /^\d+$/.test(qty),
                "INVALID_QUANTITY",
                "Dấu phân cách hàng nghìn không hợp lệ.",
                422,
              );
              qty = qty.split(sep).join("");
            }
            n.expired_date = this.normalizeDate(
              n.expired_date,
              j.options.dateFormat,
            );
            n.product_id = p.id;
            n.location_id = l.id;
            n.base_uom = p.base_uom;
            if (/^0+$/.test(qty)) {
              n.quantity = 0;
              warnings.push("Tồn bằng 0: bỏ qua, không tạo pack.");
            } else n.quantity = validateQuantity(qty);
            n.status = validate(
              z.enum(["AVAILABLE", "QUARANTINE", "LOCKED", "EXPIRED"]),
              n.status || "AVAILABLE",
            );
            if (n.expired_date <= warehouseDate()) {
              ensure(
                j.kind === "OPENING_BALANCE",
                "EXPIRED_INBOUND",
                "Phiếu nhập thường không nhận hàng hết hạn.",
                422,
              );
              n.status = "EXPIRED";
              warnings.push("Hàng hết hạn: ghi tồn vật lý và chặn xuất.");
            }
            if (j.kind === "INBOUND") {
              validate(text, n.reference);
              ensure(
                !(
                  await c.query(
                    "SELECT 1 FROM inbound_receipts WHERE warehouse_id=$1 AND source_reference=$2",
                    [j.warehouse_id, n.reference],
                  )
                ).rowCount,
                "REFERENCE_EXISTS",
                "Chứng từ nguồn đã ghi sổ.",
                422,
              );
            }
            n.action = "CREATE";
          }
        } catch (e: any) {
          errors.push({
            column: "row",
            message: e.getResponse?.()?.message || e.message,
          });
        }
        const skipped = n.quantity === 0;
        const status = errors.length ? "ERROR" : skipped ? "SKIPPED" : "VALID";
        summary[errors.length ? "errors" : skipped ? "skipped" : "valid"]++;
        if (!errors.length && !skipped) {
          summary[n.action === "UPDATE" ? "update" : "create"]++;
          if (n.quantity)
            summary.totals[n.base_uom] =
              (summary.totals[n.base_uom] || 0) + n.quantity;
        }
        await c.query(
          "INSERT INTO import_rows(job_id,sheet,source_row,original,normalized,errors,warnings,expected_version,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            sheet.name,
            idx + j.options.headerRow + 1,
            JSON.stringify(original),
            JSON.stringify(n),
            JSON.stringify(errors),
            JSON.stringify(warnings),
            version,
            status,
          ],
        );
      }
      ensure(
        summary.valid + summary.errors + summary.skipped > 0,
        "EMPTY_FILE",
        "Không có dữ liệu để nhập.",
        422,
      );
      await c.query(
        "UPDATE import_jobs SET status='VALIDATED',summary=$2,preview_version=preview_version+1,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(summary)],
      );
      return summary;
    });
  }
  async confirm(actor: Actor, id: string, key: string, body: unknown) {
    const b = validate(
      z.object({
        previewVersion: z.number().int().positive(),
        acknowledgeWarnings: z.boolean().default(false),
      }),
      body,
    );
    return this.db.transaction((c) =>
      idempotent(c, actor.id, "import-confirm", key, { id, ...b }, async () => {
        await c.query("SELECT id FROM import_jobs WHERE id=$1 FOR UPDATE", [
          validate(uuid, id),
        ]);
        const j = await this.check(actor, id, c);
        if (j.status === "COMPLETED") return j.summary;
        ensure(
          j.status === "VALIDATED" && j.preview_version === b.previewVersion,
          "PREVIEW_STALE",
          "Kiểm tra lại dữ liệu trước khi xác nhận.",
        );
        ensure(
          j.summary.errors === 0,
          "IMPORT_HAS_ERRORS",
          "Sửa toàn bộ lỗi trước khi nhập.",
          422,
        );
        const rows = (
          await c.query(
            "SELECT * FROM import_rows WHERE job_id=$1 ORDER BY source_row",
            [id],
          )
        ).rows;
        ensure(
          b.acknowledgeWarnings || rows.every((r) => r.warnings.length === 0),
          "WARNINGS_REQUIRED",
          "Cần xác nhận cảnh báo trước khi nhập.",
          422,
        );
        const valid = rows.filter((r) => r.status === "VALID");
        ensure(
          valid.length > 0,
          "NO_VALID_ROWS",
          "Không có dòng hợp lệ để nhập.",
          422,
        );
        await c.query(
          "UPDATE import_jobs SET status='CONFIRMING' WHERE id=$1",
          [id],
        );
        if (["PRODUCTS", "VENDORS", "LOCATIONS"].includes(j.kind)) {
          ensure(
            actor.role === "ADMIN",
            "FORBIDDEN",
            "Cần quyền quản trị.",
            403,
          );
          for (const row of valid) {
            const n = row.normalized;
            let r;
            if (j.kind === "PRODUCTS") {
              const current = (
                await c.query(
                  "SELECT * FROM products WHERE part_no=$1 FOR UPDATE",
                  [n.part_no],
                )
              ).rows[0];
              ensure(
                current
                  ? String(current.version) === String(row.expected_version)
                  : row.expected_version === null,
                "PREVIEW_STALE",
                "Sản phẩm đã thay đổi sau preview.",
              );
              if (current && current.base_uom !== n.base_uom)
                ensure(
                  !(
                    await c.query(
                      "SELECT 1 FROM stock_pack_balances WHERE product_id=$1 LIMIT 1",
                      [current.id],
                    )
                  ).rowCount,
                  "UOM_LOCKED",
                  "Không đổi đơn vị tính của sản phẩm đã có lịch sử tồn.",
                  422,
                );
              if (row.expected_version === null)
                r = await c.query(
                  "INSERT INTO products(part_no,specification,base_uom,default_vendor_code) VALUES($1,$2,$3,$4) RETURNING id",
                  [
                    n.part_no,
                    n.specification,
                    n.base_uom,
                    n.vendor_code || null,
                  ],
                );
              else
                r = await c.query(
                  "UPDATE products SET specification=$2,base_uom=$3,default_vendor_code=$4,version=version+1 WHERE part_no=$1 AND version=$5 RETURNING id",
                  [
                    n.part_no,
                    n.specification,
                    n.base_uom,
                    n.vendor_code || null,
                    row.expected_version,
                  ],
                );
            } else if (j.kind === "VENDORS") {
              if (row.expected_version === null)
                r = await c.query(
                  "INSERT INTO vendors(code,name) VALUES($1,$2) RETURNING code",
                  [n.code, n.name],
                );
              else
                r = await c.query(
                  "UPDATE vendors SET name=$2,version=version+1 WHERE code=$1 AND version=$3 RETURNING code",
                  [n.code, n.name, row.expected_version],
                );
            } else {
              if (row.expected_version === null)
                r = await c.query(
                  "INSERT INTO locations(warehouse_id,code,name) VALUES($1,$2,$3) RETURNING id",
                  [j.warehouse_id, n.code, n.name],
                );
              else
                r = await c.query(
                  "UPDATE locations SET name=$3,version=version+1 WHERE warehouse_id=$1 AND code=$2 AND version=$4 RETURNING id",
                  [j.warehouse_id, n.code, n.name, row.expected_version],
                );
            }
            ensure(
              r.rowCount === 1,
              "PREVIEW_STALE",
              "Danh mục đã thay đổi sau preview. Kiểm tra lại.",
            );
          }
        } else {
          let effective: string | undefined;
          if (j.kind === "OPENING_BALANCE") {
            ensure(
              actor.role === "ADMIN",
              "FORBIDDEN",
              "Cần quyền quản trị để chốt tồn đầu kỳ.",
              403,
            );
            const w = (
              await c.query("SELECT * FROM warehouses WHERE id=$1 FOR UPDATE", [
                j.warehouse_id,
              ])
            ).rows[0];
            ensure(
              !w.cutover_at,
              "OPENING_ALREADY_DONE",
              "Kho đã chốt tồn đầu kỳ. Dùng chứng từ nghiệp vụ để bổ sung.",
            );
            const movements = await c.query(
              "SELECT 1 FROM stock_movements m JOIN locations l ON l.id=m.location_id WHERE l.warehouse_id=$1 LIMIT 1",
              [j.warehouse_id],
            );
            ensure(
              !movements.rowCount,
              "WAREHOUSE_NOT_EMPTY",
              "Chỉ chuyển đổi tồn đầu kỳ khi kho chưa có giao dịch.",
            );
            effective = (await c.query("SELECT clock_timestamp()::text AS t"))
              .rows[0].t;
            await c.query(
              "UPDATE warehouses SET opening_state='IMPORTING',opening_job_id=$2 WHERE id=$1",
              [j.warehouse_id, id],
            );
          }
          const groups = new Map<string, any[]>();
          for (const row of valid) {
            const ref =
              j.kind === "OPENING_BALANCE"
                ? `OPENING:${id}`
                : row.normalized.reference;
            groups.set(ref, [...(groups.get(ref) || []), row]);
          }
          for (const [ref, group] of groups) {
            for (const row of group) {
              const current = (
                await c.query(
                  "SELECT base_uom FROM products WHERE id=$1 FOR SHARE",
                  [row.normalized.product_id],
                )
              ).rows[0];
              ensure(
                current && current.base_uom === row.normalized.base_uom,
                "PREVIEW_STALE",
                "Đơn vị tính sản phẩm đã thay đổi sau preview.",
              );
            }
            const packs: ReceivePack[] = group.map((r) => ({
              productId: r.normalized.product_id,
              locationId: r.normalized.location_id,
              lotNo: r.normalized.lot_no,
              mesPackNo: r.normalized.mes_pack_no,
              vendorCode: r.normalized.vendor_code,
              quantity: r.normalized.quantity,
              expiredDate: r.normalized.expired_date,
              status: r.normalized.status,
            }));
            const receipt = await this.inventory.receive(
              c,
              actor,
              j.warehouse_id,
              ref,
              packs,
              j.kind,
              id,
              effective,
            );
            for (const r of group)
              await c.query(
                "UPDATE import_rows SET document_id=$2 WHERE id=$1",
                [r.id, receipt.id],
              );
          }
          if (effective)
            await c.query(
              "UPDATE warehouses SET cutover_at=$2,opening_state='NORMAL' WHERE id=$1",
              [j.warehouse_id, effective],
            );
        }
        await c.query(
          "UPDATE import_rows SET status='COMMITTED' WHERE job_id=$1 AND status='VALID'",
          [id],
        );
        const summary = { ...j.summary, committed: valid.length };
        await c.query(
          "UPDATE import_jobs SET status='COMPLETED',summary=$2,updated_at=now() WHERE id=$1",
          [id, JSON.stringify(summary)],
        );
        return summary;
      }),
    );
  }
}
