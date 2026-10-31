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
@Controller("reports")
export class ReportController {
  constructor(
    @Inject(ReportService) private reports: ReportService,
    @Inject(ExcelService) private excel: ExcelService,
  ) {}
  @Get("dashboard") dashboard(
    @Req() req: any,
    @Query("warehouseId") id: string,
  ) {
    return this.reports.dashboard(req.actor, id);
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
