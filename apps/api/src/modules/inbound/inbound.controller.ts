import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Delete,
  Req,
} from "@nestjs/common";
import { ensure } from "../../shared/errors";
import { z } from "zod";
import { InboundService } from "./inbound.service";
import { Public } from "../identity/auth";
import { validate, text, uuid } from "../../shared/validation";
@Controller()
export class InboundController {
  constructor(@Inject(InboundService) private inbound: InboundService) {}
  @Post("inbound/drafts") create(@Req() req: any, @Body() b: unknown) {
    return this.inbound.draft(req.actor, b);
  }
  @Get("inbound/drafts") async list(@Req() req: any) {
    return (
      await this.inbound.db.pool.query(
        "SELECT * FROM inbound_drafts WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 50",
        [req.actor.id],
      )
    ).rows;
  }
  @Get("inbound/drafts/:id") async get(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inbound.db.transaction(async (c) => {
      const draft = await this.inbound.checkDraft(c, req.actor, id);
      const lines = (
        await c.query(
          "SELECT l.*,l.expired_date::text AS expiry,p.part_no,p.specification,p.base_uom FROM inbound_draft_lines l JOIN products p ON p.id=l.product_id WHERE draft_id=$1 AND NOT l.deleted ORDER BY l.created_at,l.id",
          [id],
        )
      ).rows;
      return { ...draft, lines };
    });
  }
  @Delete("inbound/drafts/:id/lines/:line") async remove(
    @Req() req: any,
    @Param("id") id: string,
    @Param("line") line: string,
  ) {
    const result = await this.inbound.db.transaction(async (c) => {
      const d = await this.inbound.checkDraft(c, req.actor, id, true);
      ensure(d.status === "OPEN", "DRAFT_CLOSED", "Phiếu đã đóng.");
      await c.query(
        "UPDATE inbound_draft_lines SET deleted=true,updated_at=now() WHERE id=$1 AND draft_id=$2",
        [validate(uuid, line), id],
      );
      return { ok: true };
    });
    this.inbound.changed(id);
    return result;
  }
  @Post("inbound/drafts/:id/pair") pair(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inbound.makePairing(req.actor, id);
  }
  @Post("inbound/drafts/:id/revoke") revoke(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inbound.revoke(req.actor, id);
  }
  @Post("inbound/scan") scan(@Req() req: any, @Body() b: unknown) {
    return this.inbound.scan(b, req.actor);
  }
  @Put("inbound/drafts/:id/lines/:line/expiry") expiry(
    @Req() req: any,
    @Param("id") id: string,
    @Param("line") line: string,
    @Body() b: unknown,
  ) {
    return this.inbound.setExpiry(req.actor, id, line, b);
  }
  @Post("inbound/drafts/:id/confirm") confirm(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.inbound.confirm(req.actor, req.headers["idempotency-key"], id);
  }
  @Public() @Post("scanner/refresh") refresh(@Body() body: unknown) {
    const b = validate(z.object({ token: text }), body);
    return this.inbound.refresh(b.token);
  }
  @Public() @Post("scanner/state") state(@Body() body: unknown) {
    const b = validate(z.object({ token: text }), body);
    return this.inbound.db.transaction(async (c) => {
      const { pairing } = await this.inbound.pairing(c, b.token);
      return {
        draftId: pairing.draft_id,
        lines: (
          await c.query(
            "SELECT l.id,p.part_no,l.mes_pack_no,l.status FROM inbound_draft_lines l JOIN products p ON p.id=l.product_id WHERE draft_id=$1 AND NOT l.deleted ORDER BY l.created_at",
            [pairing.draft_id],
          )
        ).rows,
      };
    });
  }
}
