import { Inject, Injectable } from "@nestjs/common";
import ExcelJS from "exceljs";
import QueryStream from "pg-query-stream";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { existsSync } from "node:fs";
import { Actor } from "../identity/auth";
import { ReportService } from "./report.service";
import { ensure } from "../../shared/errors";
type Column = {
  key: string;
  header: string;
  width: number;
  kind?: "number" | "date";
  total?: boolean;
};
const common: Column[] = [
  { key: "part_no", header: "PART NO", width: 24 },
  { key: "specification", header: "TÊN / QUY CÁCH", width: 36 },
  { key: "base_uom", header: "ĐVT", width: 10 },
];
const columns: Record<string, Column[]> = {
  aging: [
    ...common,
    { key: "lot_no", header: "SỐ LÔ", width: 20 },
    { key: "mes_pack_no", header: "MÃ PACK (MES)", width: 32 },
    { key: "location", header: "VỊ TRÍ", width: 16 },
    { key: "vendor_code", header: "NHÀ CUNG CẤP", width: 18 },
    ...["on_hand", "reserved", "available"].map((key, i) => ({
      key,
      header: ["TỒN THỰC TẾ", "GIỮ CHỖ", "KHẢ DỤNG"][i],
      width: 17,
      kind: "number" as const,
      total: true,
    })),
    { key: "expired_date", header: "HẠN DÙNG", width: 16, kind: "date" },
    { key: "days_left", header: "NGÀY CÒN LẠI", width: 18, kind: "number" },
    { key: "aging", header: "CẢNH BÁO", width: 20 },
    { key: "status", header: "TRẠNG THÁI KHO", width: 20 },
  ],
  period: [
    ...common,
    ...["opening", "inbound", "outbound", "adjustment", "closing"].map(
      (key, i) => ({
        key,
        header: ["TỒN ĐẦU", "NHẬP", "XUẤT", "ĐIỀU CHỈNH / CHUYỂN", "TỒN CUỐI"][
          i
        ],
        width: 24,
        kind: "number" as const,
        total: true,
      }),
    ),
  ],
  movements: [
    {
      key: "effective_at",
      header: "THỜI ĐIỂM NGHIỆP VỤ",
      width: 25,
      kind: "date",
    },
    ...common,
    { key: "lot_no", header: "SỐ LÔ", width: 20 },
    { key: "mes_pack_no", header: "MES PACK NO", width: 32 },
    { key: "location", header: "VỊ TRÍ", width: 16 },
    {
      key: "quantity_delta",
      header: "BIẾN ĐỘNG",
      width: 18,
      kind: "number",
      total: true,
    },
    { key: "balance_after", header: "TỒN SAU", width: 18, kind: "number" },
    { key: "movement_type", header: "NGHIỆP VỤ", width: 22 },
    { key: "reference_id", header: "CHỨNG TỪ", width: 40 },
    { key: "actor", header: "NGƯỜI THỰC HIỆN", width: 24 },
    { key: "import_job_id", header: "NGUỒN IMPORT", width: 40 },
  ],
};
columns.trace = columns.movements;
const titles: Record<string, string> = {
  aging: "CẢNH BÁO HẠN SỬ DỤNG VÀ TỒN KHO",
  period: "BÁO CÁO NHẬP XUẤT TỒN",
  movements: "NHẬT KÝ BIẾN ĐỘNG KHO",
  trace: "TRUY VẾT LOT VÀ MES PACK",
};
@Injectable()
export class ExcelService {
  private active = 0;
  constructor(@Inject(ReportService) private reports: ReportService) {}
  async rich(actor: Actor, type: string, q: any) {
    return this.reports.db.transaction(async (c) => {
      const query = await this.reports.query(actor, type, q, c),
        rows = (await c.query(`${query.text} LIMIT 5001`, query.values)).rows;
      ensure(
        rows.length <= 5000,
        "USE_STREAMING",
        "Bản trình bày tối đa 5.000 dòng. Chọn xuất chi tiết.",
        422,
      );
      const wb = new ExcelJS.Workbook();
      wb.creator = actor.display_name;
      wb.calcProperties.fullCalcOnLoad = true;
      const overview = rows.length > 100 ? wb.addWorksheet("Tong quan") : null;
      const sheet = wb.addWorksheet("Chi tiet", {
        views: [
          { state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false },
        ],
      });
      const asOf = (await c.query("SELECT now() AS t")).rows[0].t;
      const layout = this.setup(sheet, type, actor, q, asOf);
      if (
        process.env.COMPANY_LOGO_PATH &&
        existsSync(process.env.COMPANY_LOGO_PATH)
      ) {
        const img = wb.addImage({
          filename: process.env.COMPANY_LOGO_PATH,
          extension: "png",
        });
        sheet.addImage(img, {
          tl: { col: layout.cols.length - 2, row: 0 },
          ext: { width: 100, height: 45 },
        });
      }
      const totals = new Map<string, Record<string, number>>();
      for (const row of rows) this.row(sheet, row, layout, totals);
      this.finish(sheet, layout, totals, false);
      if (overview) {
        overview.addRow([titles[type]]);
        overview.addRow([
          "ĐVT",
          ...layout.cols.filter((c) => c.total).map((c) => c.header),
        ]);
        for (const [u, t] of totals)
          overview.addRow([
            u,
            ...layout.cols.filter((c) => c.total).map((c) => t[c.key]),
          ]);
        overview.columns.forEach((c) => (c.width = 24));
      }
      return Buffer.from(await wb.xlsx.writeBuffer());
    }, true);
  }
  setup(sheet: any, type: string, actor: Actor, q: any, asOf: Date) {
    const cols = columns[type];
    ensure(cols, "INVALID_REPORT", "Loại báo cáo không hợp lệ.", 422);
    const totals = cols.filter((c) => c.total);
    sheet.columns = [
      ...cols.map((c) => ({ key: c.key, width: c.width })),
      ...totals.map((c) => ({
        key: `_visible_${c.key}`,
        width: 2,
        hidden: true,
      })),
    ];
    sheet.mergeCells(1, 1, 1, Math.min(cols.length, 6));
    sheet.getCell("A1").value = titles[type];
    sheet.getCell("A1").font = {
      name: "Calibri",
      size: 17,
      bold: true,
      color: { argb: "FF102E49" },
    };
    sheet.getCell("A2").value =
      `Kho: ${q.warehouseId} · Người lập: ${actor.display_name}`;
    sheet.getCell("A3").value =
      `Chốt dữ liệu: ${new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "medium" }).format(asOf)} · Asia/Ho_Chi_Minh`;
    sheet.getCell("A4").value =
      type === "period"
        ? `Kỳ: ${q.from} đến trước ${q.to}; ngày đầu chuyển đổi tính từ mốc chốt tồn.`
        : "Số liệu tại thời điểm xuất; các tổng được tách theo đơn vị tính.";
    sheet.getRow(5).values = [
      ...cols.map((c) => c.header),
      ...totals.map((c) => `VISIBLE_${c.key}`),
    ];
    sheet.getRow(5).height = 30;
    for (let i = 1; i <= cols.length; i++) {
      const cell = sheet.getCell(5, i);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F4E78" },
      };
      cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } };
      cell.alignment = { vertical: "middle", wrapText: true };
    }
    sheet.pageSetup = {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:5",
    };
    sheet.headerFooter = { oddFooter: "Trang &P / &N" };
    return { cols, totals, count: 0 };
  }
  row(
    sheet: any,
    row: any,
    layout: { cols: Column[]; totals: Column[]; count: number },
    totals: Map<string, Record<string, number>>,
    commit = false,
  ) {
    layout.count++;
    const line = layout.count + 5,
      unit = String(row.base_uom || "");
    const sum = totals.get(unit) || {};
    const values: any[] = [];
    for (const col of layout.cols) {
      const value = row[col.key];
      values.push(
        value == null
          ? ""
          : col.kind === "number"
            ? Number(value)
            : col.kind === "date"
              ? col.key.endsWith("_at")
                ? new Date(new Date(value).getTime() + 7 * 3600000)
                : new Date(`${value}T00:00:00Z`)
              : String(value),
      );
      if (col.total) sum[col.key] = (sum[col.key] || 0) + Number(value || 0);
    }
    for (const col of layout.totals) {
      const index = layout.cols.findIndex((c) => c.key === col.key) + 1;
      const letter = sheet.getColumn(index).letter;
      values.push({
        formula: `SUBTOTAL(109,${letter}${line})`,
        result: Number(row[col.key] || 0),
      });
    }
    totals.set(unit, sum);
    const r = sheet.addRow(values);
    for (let i = 0; i < layout.cols.length; i++) {
      const cell = r.getCell(i + 1),
        col = layout.cols[i];
      cell.font = { name: "Calibri", size: 11 };
      cell.alignment = {
        vertical: "middle",
        wrapText: col.key === "specification",
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: line % 2 ? "FFFFFFFF" : "FFF0F5FA" },
      };
      cell.numFmt =
        col.kind === "number"
          ? "#,##0"
          : col.kind === "date"
            ? col.key.endsWith("_at")
              ? "yyyy-mm-dd hh:mm"
              : "yyyy-mm-dd"
            : "@";
    }
    if (commit) r.commit();
  }
  finish(
    sheet: any,
    layout: { cols: Column[]; totals: Column[]; count: number },
    totals: Map<string, Record<string, number>>,
    streaming: boolean,
  ) {
    const last = 5 + layout.count;
    sheet.autoFilter = {
      from: { row: 5, column: 1 },
      to: { row: last, column: layout.cols.length },
    };
    const unitCol = sheet.getColumn(
      layout.cols.findIndex((c) => c.key === "base_uom") + 1,
    ).letter;
    for (const [unit, sum] of totals) {
      const values: any[] = Array(
        layout.cols.length + layout.totals.length,
      ).fill(null);
      values[0] = `TỔNG HIỂN THỊ (${unit})`;
      layout.totals.forEach((col, j) => {
        const dest = layout.cols.findIndex((c) => c.key === col.key);
        const helper = sheet.getColumn(layout.cols.length + j + 1).letter;
        values[dest] = {
          formula: `SUMIF(${unitCol}6:${unitCol}${last},"${unit.replace(/"/g, '""')}",${helper}6:${helper}${last})`,
          result: sum[col.key],
        };
      });
      const row = sheet.addRow(values);
      row.font = { bold: true };
      layout.totals.forEach(
        (col) =>
          (row.getCell(
            layout.cols.findIndex((c) => c.key === col.key) + 1,
          ).numFmt = "#,##0"),
      );
      if (streaming) row.commit();
    }
    const dayIndex = layout.cols.findIndex((c) => c.key === "days_left");
    if (dayIndex >= 0 && layout.count) {
      const letter = sheet.getColumn(dayIndex + 1).letter;
      sheet.addConditionalFormatting({
        ref: `${letter}6:${letter}${last}`,
        rules: [
          {
            type: "cellIs",
            operator: "lessThanOrEqual",
            formulae: [0],
            priority: 1,
            style: {
              fill: {
                type: "pattern",
                pattern: "solid",
                bgColor: { argb: "FFFFDAD6" },
              },
            },
          },
          {
            type: "cellIs",
            operator: "between",
            formulae: [1, 30],
            priority: 2,
            style: {
              fill: {
                type: "pattern",
                pattern: "solid",
                bgColor: { argb: "FFFFE8BC" },
              },
            },
          },
          {
            type: "cellIs",
            operator: "between",
            formulae: [31, 90],
            priority: 3,
            style: {
              fill: {
                type: "pattern",
                pattern: "solid",
                bgColor: { argb: "FFFFF6C4" },
              },
            },
          },
        ],
      });
    }
  }
  async stream(
    actor: Actor,
    type: string,
    q: any,
    destination: Writable,
    signal?: AbortSignal,
  ) {
    ensure(
      this.active < 2,
      "EXPORT_BUSY",
      "Đang có 2 lượt xuất lớn. Thử lại sau.",
      429,
    );
    this.active++;
    const c = await this.reports.db.pool.connect().catch((e) => {
      this.active--;
      throw e;
    });
    let cursor: QueryStream | undefined;
    let aborted = false;
    let writer: any;
    const cancel = () => {
      aborted = true;
      cursor?.destroy(new Error("Export cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const query = await this.reports.query(actor, type, q, c);
      const asOf = (await c.query("SELECT now() AS t")).rows[0].t;
      const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: destination,
        useStyles: true,
        useSharedStrings: false,
      });
      writer = wb;
      const sheet = wb.addWorksheet("Chi tiet", {
        views: [
          { state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false },
        ],
      });
      const layout = this.setup(sheet, type, actor, q, asOf),
        totals = new Map<string, Record<string, number>>();
      // The ZIP writer must be allowed to flush between bounded DB batches.
      for (let i = 1; i <= 5; i++) sheet.getRow(i).commit();
      cursor = new QueryStream(query.text, query.values, { batchSize: 100 });
      const rows = c.query(cursor);
      for await (const row of rows) {
        ensure(!aborted, "EXPORT_CANCELLED", "Đã hủy xuất file.", 499);
        ensure(
          layout.count < 500000,
          "EXPORT_LIMIT",
          "Tối đa 500.000 dòng mỗi lượt xuất.",
          422,
        );
        this.row(sheet, row, layout, totals, true);
        if (layout.count % 100 === 0) {
          await setImmediate();
          if (destination.writableNeedDrain)
            await once(destination, "drain", { signal });
        }
      }
      this.finish(sheet, layout, totals, true);
      sheet.commit();
      await wb.commit();
      await c.query("COMMIT");
      return { rows: layout.count };
    } catch (e) {
      cursor?.destroy();
      writer?.zip?.abort();
      await c.query("ROLLBACK");
      throw e;
    } finally {
      signal?.removeEventListener("abort", cancel);
      c.release();
      this.active--;
    }
  }
}
