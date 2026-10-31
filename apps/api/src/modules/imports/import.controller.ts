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
  Res,
} from "@nestjs/common";
import ExcelJS from "exceljs";
import { ImportService, fields } from "./import.service";
import { ensure } from "../../shared/errors";
import { validate } from "../../shared/validation";
import { z } from "zod";
import { importKinds } from "./import.service";
@Controller("imports")
export class ImportController {
  constructor(@Inject(ImportService) private imports: ImportService) {}
  @Get() async list(@Req() req: any, @Query("warehouseId") wh: string) {
    const { scope } = await import("../warehouse/access");
    const { uuid } = await import("../../shared/validation");
    validate(uuid, wh);
    scope(req.actor, wh);
    return (
      await this.imports.db.pool.query(
        "SELECT id,kind,file_name,status,summary,created_at FROM import_jobs WHERE warehouse_id=$1 AND (actor_id=$2 OR $3) ORDER BY created_at DESC LIMIT 50",
        [wh, req.actor.id, req.actor.role === "ADMIN"],
      )
    ).rows;
  }
  @Get("profiles") async profiles(@Req() req: any) {
    return (
      await this.imports.db.pool.query(
        "SELECT * FROM import_mapping_profiles WHERE actor_id=$1 ORDER BY name",
        [req.actor.id],
      )
    ).rows;
  }
  @Get("template/:kind") async template(
    @Param("kind") kind: string,
    @Res() reply: any,
  ) {
    const type = validate(z.enum(importKinds), kind),
      wb = new ExcelJS.Workbook(),
      sheet = wb.addWorksheet("Du lieu");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns = fields[type].map((key) => ({
      header: key,
      key,
      width: 24,
      style: { numFmt: key === "quantity" ? "0" : "@" },
    }));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    const help = wb.addWorksheet("Huong dan");
    help.addRow(["template_version", "1"]);
    help.addRow(["Loại import", type]);
    help.addRow([
      "Cách dùng",
      "Nhập tối đa 1000 dòng vào sheet Du lieu; lưu mã dưới dạng Text, ngày YYYY-MM-DD.",
    ]);
    help.addRow([
      "Tồn đầu kỳ",
      "Chỉ xác nhận ở kho chưa phát sinh giao dịch; tồn hết hạn được chuyển EXPIRED.",
    ]);
    help.columns = [{ width: 25 }, { width: 100 }];
    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", `attachment; filename="Mau_${type}.xlsx"`)
      .send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  @Post() async upload(@Req() req: any, @Query() q: any) {
    const file = await req.file({
      limits: { fileSize: this.imports.maxBytes, files: 1 },
    });
    ensure(file, "FILE_REQUIRED", "Chọn file để nhập.", 422);
    const buffer = await file.toBuffer();
    return this.imports.upload(
      req.actor,
      q.warehouseId,
      q.kind,
      file.filename,
      buffer,
    );
  }
  @Get(":id") get(@Req() req: any, @Param("id") id: string) {
    return this.imports.get(req.actor, id);
  }
  @Put(":id/mapping") mapping(
    @Req() req: any,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.imports.mapping(req.actor, id, b);
  }
  @Post(":id/validate") validate(@Req() req: any, @Param("id") id: string) {
    return this.imports.validateJob(req.actor, id);
  }
  @Post(":id/rows/:rowId/toggle-skip") toggleSkip(
    @Req() req: any,
    @Param("id") id: string,
    @Param("rowId") rowId: string,
  ) {
    return this.imports.toggleSkipRow(req.actor, id, rowId);
  }
  @Post(":id/confirm") confirm(
    @Req() req: any,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.imports.confirm(
      req.actor,
      id,
      req.headers["idempotency-key"],
      b,
    );
  }
  @Get(":id/errors.xlsx") async errors(
    @Req() req: any,
    @Param("id") id: string,
    @Res() reply: any,
  ) {
    const j = await this.imports.get(req.actor, id),
      wb = new ExcelJS.Workbook(),
      s = wb.addWorksheet("Loi du lieu");
    const originalHeaders = (
      j.sheets.find((sheet: any) => sheet.name === j.options.sheet)?.preview[
        j.options.headerRow - 1
      ] || []
    ).map((c: any) => String(c.value || ""));
    s.addRow([
      "Sheet",
      "Dòng nguồn",
      ...originalHeaders,
      "Mã lỗi / cột",
      "Lý do",
      "Cảnh báo",
    ]);
    for (const r of j.rows.filter(
      (r: any) => r.errors.length || r.warnings.length,
    ))
      s.addRow([
        r.sheet,
        r.source_row,
        ...r.original.map((cell: any) => String(cell.value ?? "")),
        r.errors.map((e: any) => e.column).join("; "),
        r.errors.map((e: any) => e.message).join("; "),
        r.warnings.join("; "),
      ]);
    s.columns.forEach((c: any) => {
      c.width = 28;
      c.numFmt = "@";
    });
    s.getRow(1).font = { bold: true };
    s.views = [{ state: "frozen", ySplit: 1 }];
    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", 'attachment; filename="Loi_import.xlsx"')
      .send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
}
