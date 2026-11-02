import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { PassThrough } from "node:stream";
import { ReportService } from "./report.service";
import { ExcelService } from "./excel.service";
import { Public } from "../identity/auth";

@Controller("reports")
export class ReportController {
  constructor(
    @Inject(ReportService) private reports: ReportService,
    @Inject(ExcelService) private excel: ExcelService,
  ) {}

  @Public()
  @Get("full-backup-excel")
  async fullBackupExcel(
    @Res() reply: any,
    @Query("warehouseId") warehouseId?: string,
  ) {
    const buffer = await this.excel.exportFullBackup(warehouseId);
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    }).format(new Date());
    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header(
        "Content-Disposition",
        `attachment; filename="WMS_FULL_BACKUP_${dateStr}.xlsx"`,
      );
    return reply.send(buffer);
  }

  @Get("dashboard") dashboard(
    @Req() req: any,
    @Query("warehouseId") id: string,
  ) {
    return this.reports.dashboard(req.actor, id);
  }
  @Get("outbound-matrix") outboundMatrix(
    @Req() req: any,
    @Query("warehouseId") id: string,
    @Query("days") days?: string,
  ) {
    return this.reports.outboundMatrix(req.actor, id, Number(days || 7));
  }
  @Get("product-detail/:id") productDetail(
    @Req() req: any,
    @Param("id") id: string,
    @Query("warehouseId") warehouseId: string,
  ) {
    return this.reports.productDetail(req.actor, id, warehouseId);
  }
  @Get(":type/export") async export(
    @Req() req: any,
    @Param("type") type: string,
    @Query() q: any,
    @Res() reply: any,
  ) {
    await this.reports.query(req.actor, type, q);
    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", `attachment; filename="WMS_${type}.xlsx"`);
    if (q.mode !== "detail")
      return reply.send(await this.excel.rich(req.actor, type, q));
    const stream = new PassThrough({ highWaterMark: 64 * 1024 }),
      cancel = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) cancel.abort();
    });
    void this.excel
      .stream(req.actor, type, q, stream, cancel.signal)
      .catch((e) => {
        stream.destroy(e);
      });
    return reply.send(stream);
  }
  @Get(":type") report(
    @Req() req: any,
    @Param("type") type: string,
    @Query() q: any,
  ) {
    return this.reports.report(req.actor, type, q);
  }
}
