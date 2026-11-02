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
  { key: "model", header: "MODEL SỬ DỤNG", width: 22 },
  { key: "finished_goods_code", header: "CODE THÀNH PHẨM", width: 25 },
  { key: "specification", header: "TÊN VẬT LIỆU", width: 36 },
  { key: "part_no", header: "CODE LINH KIỆN", width: 24 },
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

  async exportFullBackup(warehouseId?: string): Promise<Buffer> {
    return this.reports.db.transaction(async (c) => {
      const wb = new ExcelJS.Workbook();
      wb.creator = "Hệ Thống Quản Lý Kho WMS - Bản Sao Lưu Tự Động";
      wb.created = new Date();
      wb.calcProperties.fullCalcOnLoad = true;

      const nowTimeStr = new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        dateStyle: "full",
        timeStyle: "medium",
      }).format(new Date());

      type BackupCol = {
        key: string;
        header: string;
        width: number;
        align?: "left" | "center" | "right";
        isNum?: boolean;
      };

      const setupHeader = (
        ws: ExcelJS.Worksheet,
        title: string,
        headers: BackupCol[],
      ) => {
        ws.views = [
          { state: "frozen", xSplit: 0, ySplit: 3, showGridLines: true },
        ];

        // Row 1: Title
        ws.mergeCells(1, 1, 1, headers.length);
        const titleCell = ws.getCell("A1");
        titleCell.value = `HỆ THỐNG QUẢN LÝ KHO (WMS) - ${title.toUpperCase()}`;
        titleCell.font = {
          name: "Calibri",
          size: 14,
          bold: true,
          color: { argb: "FFFFFFFF" },
        };
        titleCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF1E3A8A" },
        };
        titleCell.alignment = {
          vertical: "middle",
          horizontal: "left",
          indent: 1,
        };
        ws.getRow(1).height = 30;

        // Row 2: Subtitle
        ws.mergeCells(2, 1, 2, headers.length);
        const subCell = ws.getCell("A2");
        subCell.value = `Thời điểm sao lưu: ${nowTimeStr} · Múi giờ: Asia/Ho_Chi_Minh · Tự động bảo toàn dữ liệu kho 100%`;
        subCell.font = {
          name: "Calibri",
          size: 10,
          italic: true,
          color: { argb: "FF475569" },
        };
        subCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
        subCell.alignment = {
          vertical: "middle",
          horizontal: "left",
          indent: 1,
        };
        ws.getRow(2).height = 22;

        // Row 3: Headers
        const headerRow = ws.getRow(3);
        headerRow.values = headers.map((h) => h.header);
        headerRow.height = 28;
        for (let i = 1; i <= headers.length; i++) {
          const cell = headerRow.getCell(i);
          cell.font = {
            name: "Calibri",
            size: 10.5,
            bold: true,
            color: { argb: "FFFFFFFF" },
          };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1F4E78" },
          };
          cell.alignment = {
            vertical: "middle",
            horizontal: "center",
            wrapText: true,
          };
          cell.border = {
            top: { style: "thin", color: { argb: "FFCBD5E1" } },
            left: { style: "thin", color: { argb: "FFCBD5E1" } },
            bottom: { style: "medium", color: { argb: "FF0F172A" } },
            right: { style: "thin", color: { argb: "FFCBD5E1" } },
          };
        }

        ws.columns = headers.map((h) => ({ key: h.key, width: h.width }));
      };

      const addRow = (
        ws: ExcelJS.Worksheet,
        rowIdx: number,
        values: any[],
        headers: BackupCol[],
        isEven: boolean,
      ) => {
        const row = ws.getRow(rowIdx);
        row.values = values;
        row.height = 22;
        for (let i = 1; i <= headers.length; i++) {
          const cell = row.getCell(i);
          const h = headers[i - 1];
          cell.font = { name: "Calibri", size: 10.5 };
          cell.alignment = {
            vertical: "middle",
            horizontal: h.align || (h.isNum ? "right" : "left"),
            indent: h.align === "center" ? 0 : 1,
          };
          if (h.isNum) {
            cell.numFmt = "#,##0";
          }
          if (isEven) {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF8FAFC" },
            };
          }
          cell.border = {
            top: { style: "thin", color: { argb: "FFE2E8F0" } },
            left: { style: "thin", color: { argb: "FFE2E8F0" } },
            bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
            right: { style: "thin", color: { argb: "FFE2E8F0" } },
          };
        }
      };

      // 1. SHEET TỒN KHO TỔNG HỢP
      const summarySheet = wb.addWorksheet("TON_KHO_TONG_HOP");
      const summaryCols: BackupCol[] = [
        { key: "stt", header: "STT", width: 7, align: "center" },
        { key: "model", header: "MODEL SỬ DỤNG", width: 20, align: "center" },
        {
          key: "finished_goods_code",
          header: "CODE THÀNH PHẨM",
          width: 22,
          align: "center",
        },
        {
          key: "specification",
          header: "TÊN QUY CÁCH VẬT LIỆU",
          width: 38,
          align: "left",
        },
        {
          key: "part_no",
          header: "CODE LINH KIỆN",
          width: 22,
          align: "center",
        },
        { key: "base_uom", header: "ĐVT", width: 10, align: "center" },
        { key: "on_hand", header: "TỒN VẬT LÝ", width: 16, isNum: true },
        { key: "reserved", header: "GIỮ CHỖ", width: 14, isNum: true },
        { key: "available", header: "KHẢ DỤNG XUẤT", width: 16, isNum: true },
        { key: "pack_count", header: "TỔNG SỐ PACK", width: 15, isNum: true },
        {
          key: "expired_pack_count",
          header: "PACK HẾT HẠN",
          width: 15,
          isNum: true,
        },
        {
          key: "expiring_pack_count",
          header: "PACK CẬN HẠN",
          width: 15,
          isNum: true,
        },
        { key: "warehouse_name", header: "KHO HÀNG", width: 22, align: "left" },
      ];
      setupHeader(summarySheet, "Báo Cáo Tồn Kho Tổng Hợp", summaryCols);

      const summaryQuery = `
        SELECT 
          COALESCE(p.model, '-') AS model,
          COALESCE(p.finished_goods_code, '-') AS finished_goods_code,
          p.specification,
          p.part_no,
          p.base_uom,
          COALESCE(w.name, 'Kho Tổng Hợp') AS warehouse_name,
          COALESCE(sum(b.on_hand), 0)::bigint AS on_hand,
          COALESCE(sum(b.reserved), 0)::bigint AS reserved,
          COALESCE(sum(CASE WHEN b.status = 'AVAILABLE' AND b.expired_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN (b.on_hand - b.reserved) ELSE 0 END), 0)::bigint AS available,
          count(b.id) FILTER (WHERE b.on_hand > 0)::int AS pack_count,
          count(b.id) FILTER (WHERE b.on_hand > 0 AND b.expired_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int AS expired_pack_count,
          count(b.id) FILTER (WHERE b.on_hand > 0 AND b.expired_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND b.expired_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30)::int AS expiring_pack_count
        FROM products p
        LEFT JOIN stock_pack_balances b ON b.product_id = p.id AND b.on_hand > 0
        LEFT JOIN locations l ON l.id = b.location_id
        LEFT JOIN warehouses w ON w.id = l.warehouse_id
        ${warehouseId ? "WHERE l.warehouse_id = $1" : ""}
        GROUP BY p.id, p.model, p.finished_goods_code, p.specification, p.part_no, p.base_uom, w.name
        ORDER BY p.model, p.finished_goods_code, p.specification
      `;
      const summaryRows = (
        await c.query(summaryQuery, warehouseId ? [warehouseId] : [])
      ).rows;
      summaryRows.forEach((r, idx) => {
        addRow(
          summarySheet,
          idx + 4,
          [
            idx + 1,
            r.model,
            r.finished_goods_code,
            r.specification,
            r.part_no,
            r.base_uom,
            Number(r.on_hand),
            Number(r.reserved),
            Number(r.available),
            Number(r.pack_count),
            Number(r.expired_pack_count),
            Number(r.expiring_pack_count),
            r.warehouse_name,
          ],
          summaryCols,
          idx % 2 === 1,
        );
      });

      // 2. SHEET CHI TIẾT PACK & LOT
      const packSheet = wb.addWorksheet("CHI_TIET_PACK_LOT");
      const packCols: BackupCol[] = [
        { key: "stt", header: "STT", width: 7, align: "center" },
        { key: "model", header: "MODEL", width: 18, align: "center" },
        {
          key: "finished_goods_code",
          header: "CODE THÀNH PHẨM",
          width: 20,
          align: "center",
        },
        { key: "specification", header: "TÊN VẬT LIỆU", width: 36, align: "left" },
        {
          key: "part_no",
          header: "CODE LINH KIỆN",
          width: 20,
          align: "center",
        },
        { key: "base_uom", header: "ĐVT", width: 10, align: "center" },
        {
          key: "mes_pack_no",
          header: "MÃ PACK (MES)",
          width: 30,
          align: "center",
        },
        { key: "lot_no", header: "SỐ LÔ (LOT)", width: 20, align: "center" },
        { key: "warehouse_name", header: "KHO HÀNG", width: 20, align: "left" },
        { key: "location_code", header: "VỊ TRÍ", width: 14, align: "center" },
        {
          key: "vendor_code",
          header: "NHÀ CUNG CẤP",
          width: 16,
          align: "center",
        },
        { key: "on_hand", header: "TỒN THỰC TẾ", width: 15, isNum: true },
        { key: "reserved", header: "GIỮ CHỖ", width: 12, isNum: true },
        { key: "available", header: "KHẢ DỤNG", width: 14, isNum: true },
        { key: "mfg_date", header: "NGÀY SẢN XUẤT", width: 15, align: "center" },
        { key: "expired_date", header: "HẠN DÙNG", width: 15, align: "center" },
        { key: "days_left", header: "NGÀY CÒN LẠI", width: 14, isNum: true },
        {
          key: "aging_status",
          header: "CẢNH BÁO HẠN",
          width: 16,
          align: "center",
        },
        {
          key: "stock_status",
          header: "TRẠNG THÁI KHO",
          width: 16,
          align: "center",
        },
      ];
      setupHeader(packSheet, "Chi Tiết Tồn Kho Từng Kiện Hàng & Lô", packCols);

      const packQuery = `
        SELECT 
          COALESCE(p.model, '-') AS model,
          COALESCE(p.finished_goods_code, '-') AS finished_goods_code,
          p.specification,
          p.part_no,
          p.base_uom,
          b.mes_pack_no,
          b.lot_no,
          COALESCE(w.name, '-') AS warehouse_name,
          COALESCE(l.code, '-') AS location_code,
          COALESCE(b.vendor_code, '-') AS vendor_code,
          b.on_hand::bigint,
          b.reserved::bigint,
          (b.on_hand - b.reserved)::bigint AS available,
          to_char(b.mfg_date, 'DD/MM/YYYY') AS mfg_date_str,
          to_char(b.expired_date, 'DD/MM/YYYY') AS expired_date_str,
          (b.expired_date - (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS days_left,
          CASE 
            WHEN b.expired_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN 'ĐÃ HẾT HẠN'
            WHEN b.expired_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30 THEN 'CẬN HẠN'
            ELSE 'CÒN HẠN'
          END AS aging_status,
          b.status AS stock_status
        FROM stock_pack_balances b
        JOIN products p ON p.id = b.product_id
        JOIN locations l ON l.id = b.location_id
        JOIN warehouses w ON w.id = l.warehouse_id
        WHERE b.on_hand > 0 ${warehouseId ? "AND l.warehouse_id = $1" : ""}
        ORDER BY b.expired_date ASC, p.model, p.specification
      `;
      const packRows = (
        await c.query(packQuery, warehouseId ? [warehouseId] : [])
      ).rows;
      packRows.forEach((r, idx) => {
        addRow(
          packSheet,
          idx + 4,
          [
            idx + 1,
            r.model,
            r.finished_goods_code,
            r.specification,
            r.part_no,
            r.base_uom,
            r.mes_pack_no,
            r.lot_no,
            r.warehouse_name,
            r.location_code,
            r.vendor_code,
            Number(r.on_hand),
            Number(r.reserved),
            Number(r.available),
            r.mfg_date_str || "-",
            r.expired_date_str,
            Number(r.days_left),
            r.aging_status,
            r.stock_status,
          ],
          packCols,
          idx % 2 === 1,
        );
      });

      // 3. SHEET NHẬT KÝ BIẾN ĐỘNG XUẤT NHẬP
      const movementSheet = wb.addWorksheet("NHAT_KY_BIEN_DONG");
      const movementCols: BackupCol[] = [
        { key: "stt", header: "STT", width: 7, align: "center" },
        { key: "time_str", header: "THỜI ĐIỂM", width: 20, align: "center" },
        { key: "movement_type", header: "NGHIỆP VỤ", width: 16, align: "center" },
        { key: "model", header: "MODEL", width: 18, align: "center" },
        {
          key: "finished_goods_code",
          header: "CODE THÀNH PHẨM",
          width: 20,
          align: "center",
        },
        { key: "specification", header: "TÊN VẬT LIỆU", width: 36, align: "left" },
        {
          key: "part_no",
          header: "CODE LINH KIỆN",
          width: 20,
          align: "center",
        },
        { key: "base_uom", header: "ĐVT", width: 10, align: "center" },
        {
          key: "mes_pack_no",
          header: "MÃ PACK (MES)",
          width: 28,
          align: "center",
        },
        { key: "lot_no", header: "SỐ LÔ (LOT)", width: 18, align: "center" },
        { key: "quantity_delta", header: "BIẾN ĐỘNG", width: 15, isNum: true },
        { key: "balance_after", header: "TỒN SAU", width: 15, isNum: true },
        {
          key: "actor_name",
          header: "NGƯỜI THỰC HIỆN",
          width: 22,
          align: "left",
        },
        { key: "warehouse_name", header: "KHO HÀNG", width: 18, align: "left" },
        { key: "location_code", header: "VỊ TRÍ", width: 12, align: "center" },
        {
          key: "reference_code",
          header: "CHỨNG TỪ / ĐƠN",
          width: 36,
          align: "center",
        },
      ];
      setupHeader(
        movementSheet,
        "Nhật Ký Biến Động Xuất Nhập Kho Gần Nhất",
        movementCols,
      );

      const movementQuery = `
        SELECT 
          to_char(m.effective_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI:SS') AS time_str,
          CASE m.movement_type
            WHEN 'INBOUND' THEN 'NHẬP KHO'
            WHEN 'OUTBOUND' THEN 'XUẤT KHO'
            WHEN 'OPENING_BALANCE' THEN 'TỒN ĐẦU KỲ'
            WHEN 'ADJUSTMENT' THEN 'ĐIỀU CHỈNH'
            WHEN 'TRANSFER' THEN 'CHUYỂN KHO'
            ELSE m.movement_type
          END AS movement_type_vi,
          COALESCE(p.model, '-') AS model,
          COALESCE(p.finished_goods_code, '-') AS finished_goods_code,
          p.specification,
          p.part_no,
          p.base_uom,
          COALESCE(b.mes_pack_no, '-') AS mes_pack_no,
          COALESCE(b.lot_no, '-') AS lot_no,
          m.quantity_delta::bigint,
          m.balance_after::bigint,
          COALESCE(u.display_name, u.username, 'Hệ thống') AS actor_name,
          COALESCE(w.name, '-') AS warehouse_name,
          COALESCE(l.code, '-') AS location_code,
          m.reference_id::text AS reference_code
        FROM stock_movements m
        JOIN products p ON p.id = m.product_id
        JOIN locations l ON l.id = m.location_id
        JOIN warehouses w ON w.id = l.warehouse_id
        LEFT JOIN stock_pack_balances b ON b.id = m.pack_balance_id
        LEFT JOIN users u ON u.id = m.actor_id
        ${warehouseId ? "WHERE l.warehouse_id = $1" : ""}
        ORDER BY m.effective_at DESC
        LIMIT 5000
      `;
      const movementRows = (
        await c.query(movementQuery, warehouseId ? [warehouseId] : [])
      ).rows;
      movementRows.forEach((r, idx) => {
        addRow(
          movementSheet,
          idx + 4,
          [
            idx + 1,
            r.time_str,
            r.movement_type_vi,
            r.model,
            r.finished_goods_code,
            r.specification,
            r.part_no,
            r.base_uom,
            r.mes_pack_no,
            r.lot_no,
            Number(r.quantity_delta),
            Number(r.balance_after),
            r.actor_name,
            r.warehouse_name,
            r.location_code,
            r.reference_code,
          ],
          movementCols,
          idx % 2 === 1,
        );
      });

      // 4. SHEET DANH MỤC VẬT TƯ / SẢN PHẨM
      const productSheet = wb.addWorksheet("DANH_MUC_SAN_PHAM");
      const productCols: BackupCol[] = [
        { key: "stt", header: "STT", width: 7, align: "center" },
        { key: "model", header: "MODEL", width: 20, align: "center" },
        {
          key: "finished_goods_code",
          header: "CODE THÀNH PHẨM",
          width: 24,
          align: "center",
        },
        {
          key: "specification",
          header: "TÊN QUY CÁCH VẬT LIỆU",
          width: 40,
          align: "left",
        },
        {
          key: "part_no",
          header: "CODE LINH KIỆN",
          width: 24,
          align: "center",
        },
        { key: "base_uom", header: "ĐƠN VỊ TÍNH", width: 14, align: "center" },
        { key: "po_type", header: "LOẠI PO", width: 16, align: "center" },
        {
          key: "vendor_part_no",
          header: "MÃ NCC PART NO",
          width: 20,
          align: "center",
        },
        {
          key: "default_vendor_code",
          header: "MÃ NCC MẶC ĐỊNH",
          width: 20,
          align: "center",
        },
        {
          key: "created_at_str",
          header: "NGÀY TẠO",
          width: 18,
          align: "center",
        },
      ];
      setupHeader(productSheet, "Danh Mục Định Danh Sản Phẩm & Quy Cách", productCols);

      const productQuery = `
        SELECT 
          COALESCE(p.model, '-') AS model,
          COALESCE(p.finished_goods_code, '-') AS finished_goods_code,
          p.specification,
          p.part_no,
          p.base_uom,
          COALESCE(p.po_type, '-') AS po_type,
          COALESCE(p.vendor_part_no, '-') AS vendor_part_no,
          COALESCE(p.default_vendor_code, '-') AS default_vendor_code,
          to_char(p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') AS created_at_str
        FROM products p
        ORDER BY p.model, p.finished_goods_code, p.specification
      `;
      const productRows = (await c.query(productQuery)).rows;
      productRows.forEach((r, idx) => {
        addRow(
          productSheet,
          idx + 4,
          [
            idx + 1,
            r.model,
            r.finished_goods_code,
            r.specification,
            r.part_no,
            r.base_uom,
            r.po_type,
            r.vendor_part_no,
            r.default_vendor_code,
            r.created_at_str,
          ],
          productCols,
          idx % 2 === 1,
        );
      });

      // 5. SHEET THÔNG TIN BẢO TOÀN DỮ LIỆU & BẢN QUYỀN
      const infoSheet = wb.addWorksheet("THONG_TIN_BACKUP");
      infoSheet.columns = [
        { key: "k", width: 30 },
        { key: "v", width: 75 },
      ];
      infoSheet.views = [
        { state: "normal", showGridLines: true },
      ];

      infoSheet.mergeCells("A1:B1");
      const h1 = infoSheet.getCell("A1");
      h1.value = "THÔNG TIN BẢN SAO LƯU DỮ LIỆU KHO (WMS)";
      h1.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
      h1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
      h1.alignment = { vertical: "middle", horizontal: "center" };
      infoSheet.getRow(1).height = 36;

      const meta = [
        ["Hệ thống", "Hệ Thống Quản Lý Kho (WMS) - Local-First Edition"],
        ["Thời điểm sao lưu", nowTimeStr],
        ["Mục đích", "Tự động sao lưu toàn bộ số liệu kho khi hết hạn 3 ngày dùng thử"],
        [
          "Cam kết bảo toàn dữ liệu",
          "Dữ liệu được bảo toàn nguyên vẹn 100%. Phần mềm KHÔNG BAO GIỜ tự động xóa cơ sở dữ liệu trên máy khách kể cả khi gỡ cài đặt hay xóa app.",
        ],
        [
          "Nội dung các sheet",
          "1. TON_KHO_TONG_HOP: Báo cáo tồn vật lý, giữ chỗ, khả dụng, số pack.\n2. CHI_TIET_PACK_LOT: Chi tiết từng kiện pack, số lô, hạn dùng, trạng thái.\n3. NHAT_KY_BIEN_DONG: Lịch sử nhập, xuất, điều chỉnh kho gần nhất.\n4. DANH_MUC_SAN_PHAM: Toàn bộ danh mục sản phẩm, quy cách vật liệu.",
        ],
        [
          "Hướng dẫn mở khóa",
          "Vui lòng liên hệ nhà phát triển để nhận Mã bản quyền chính thức và tiếp tục sử dụng trọn đời.",
        ],
      ];

      meta.forEach((m, i) => {
        const row = infoSheet.getRow(i + 3);
        row.height = i === 4 ? 65 : 28;
        row.values = [m[0], m[1]];
        const c1 = row.getCell(1);
        c1.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF1E293B" } };
        c1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
        c1.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        c1.border = {
          top: { style: "thin", color: { argb: "FFCBD5E1" } },
          left: { style: "thin", color: { argb: "FFCBD5E1" } },
          bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
          right: { style: "thin", color: { argb: "FFCBD5E1" } },
        };

        const c2 = row.getCell(2);
        c2.font = { name: "Calibri", size: 11, color: { argb: "FF0F172A" } };
        c2.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
        c2.border = {
          top: { style: "thin", color: { argb: "FFCBD5E1" } },
          left: { style: "thin", color: { argb: "FFCBD5E1" } },
          bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
          right: { style: "thin", color: { argb: "FFCBD5E1" } },
        };
      });

      return Buffer.from(await wb.xlsx.writeBuffer());
    }, true);
  }
}
