import "reflect-metadata";
import {
  Module,
  Controller,
  Get,
  Inject,
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import { APP_GUARD, APP_FILTER } from "@nestjs/core";
import { Database } from "./database/db";
import {
  AuthController,
  AuthGuard,
  Public,
  UsersController,
} from "./modules/identity/auth";
import { CatalogController } from "./modules/catalog/catalog.controller";
import { InventoryService } from "./modules/inventory/inventory.service";
import { InventoryController } from "./modules/inventory/inventory.controller";
import { InboundService } from "./modules/inbound/inbound.service";
import { InboundController } from "./modules/inbound/inbound.controller";
import { ScannerGateway } from "./modules/inbound/scanner.gateway";
import { ImportService } from "./modules/imports/import.service";
import { ImportController } from "./modules/imports/import.controller";
import { ReportService } from "./modules/reporting/report.service";
import { ReportController } from "./modules/reporting/report.controller";
import { ExcelService } from "./modules/reporting/excel.service";
@Catch()
class Errors implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    if (host.getType() !== "http") {
      host.switchToWs().getClient().emit("exception", {
        code: "WS_ERROR",
        message: "Không thể xử lý sự kiện.",
      });
      return;
    }
    const reply = host.switchToHttp().getResponse();
    if (reply.sent) return;
    if (e instanceof HttpException)
      return reply.status(e.getStatus()).send(e.getResponse());
    const known: Record<string, [number, string, string]> = {
      "23505": [409, "DUPLICATE_REFERENCE", "Mã hoặc chứng từ đã tồn tại."],
      "23503": [
        422,
        "UNKNOWN_REFERENCE",
        "Thiếu dữ liệu tham chiếu trong danh mục.",
      ],
      "23514": [
        409,
        "INVARIANT_VIOLATION",
        "Số lượng hoặc trạng thái vi phạm quy tắc tồn kho.",
      ],
      "22P02": [422, "INVALID_VALUE", "Định dạng dữ liệu không hợp lệ."],
      "55P03": [
        409,
        "STOCK_BUSY",
        "Hàng đang được máy khác xử lý. Hãy thử lại.",
      ],
      "57014": [503, "QUERY_TIMEOUT", "Tác vụ vượt thời gian cho phép."],
      FST_REQ_FILE_TOO_LARGE: [
        413,
        "FILE_TOO_LARGE",
        "File vượt giới hạn 5 MB.",
      ],
    };
    const [status, code, message] = known[e.code] || [
      500,
      "INTERNAL_ERROR",
      "Không thể hoàn tất thao tác. Kiểm tra nhật ký máy chủ.",
    ];
    if (status === 500) console.error(e);
    reply.status(status).send({ code, message });
  }
}
@Controller("health")
class HealthController {
  constructor(@Inject(Database) private db: Database) {}
  @Public() @Get() async health() {
    await this.db.pool.query("SELECT 1");
    return { status: "ok" };
  }
}
@Module({
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    CatalogController,
    InventoryController,
    InboundController,
    ImportController,
    ReportController,
  ],
  providers: [
    Database,
    InventoryService,
    InboundService,
    ImportService,
    ReportService,
    ExcelService,
    ScannerGateway,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: Errors },
  ],
})
export class AppModule {}
