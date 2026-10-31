import { Inject } from "@nestjs/common";
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { InboundService } from "./inbound.service";
import { Database } from "../../database/db";
import { settings, isAllowedOrigin } from "../../config";
import { hash } from "../../shared/idempotency";
@WebSocketGateway({
  transports: ["websocket"],
  cors: {
    origin: (origin: string, callback: any) => {
      callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
  },
})
export class ScannerGateway implements OnGatewayConnection, OnGatewayInit {
  @WebSocketServer() server!: Server;
  constructor(
    @Inject(InboundService) private inbound: InboundService,
    @Inject(Database) private db: Database,
  ) {}
  afterInit() {
    this.inbound.changed = (draft) =>
      this.server
        .to(`draft:${draft}`)
        .emit("draft:changed", { draftId: draft });
    this.inbound.revoked = (id) => {
      this.server.to(`pairing:${id}`).emit("session:revoked");
      this.server.in(`pairing:${id}`).disconnectSockets(true);
    };
  }
  async handleConnection(socket: Socket) {
    try {
      if (
        socket.handshake.headers.origin &&
        !isAllowedOrigin(socket.handshake.headers.origin)
      )
        throw new Error("Origin not allowed");
      if (socket.handshake.auth.token) {
        const result = await this.db.transaction((c) =>
          this.inbound.pairing(c, socket.handshake.auth.token),
        );
        socket.data.token = socket.handshake.auth.token;
        socket.data.pairingId = result.pairing.id;
        socket.data.draftId = result.pairing.draft_id;
        await socket.join(`pairing:${result.pairing.id}`);
        await socket.join(`draft:${result.pairing.draft_id}`);
        socket.emit("scanner:ready", { draftId: result.pairing.draft_id });
      } else {
        const token = socket.handshake.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("wms_session="))
          ?.slice(12);
        const r = await this.db.pool.query(
          `SELECT u.id,u.role,u.username,u.display_name,s.token_hash AS session_hash,s.csrf_token,
          ARRAY(SELECT warehouse_id FROM user_warehouses WHERE user_id=u.id) AS warehouses FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
          [hash(token || "")],
        );
        if (!r.rowCount || socket.handshake.auth.csrf !== r.rows[0].csrf_token)
          throw new Error("Unauthorized");
        socket.data.actor = r.rows[0];
        const d = await this.db.transaction((c) =>
          this.inbound.checkDraft(c, r.rows[0], socket.handshake.auth.draftId),
        );
        await socket.join(`draft:${d.id}`);
        socket.emit("draft:ready", { draftId: d.id });
      }
    } catch {
      socket.emit("session:revoked");
      socket.disconnect(true);
    }
  }
  @SubscribeMessage("scan:item") async scan(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    try {
      if (!socket.data.token) throw new Error("Scanner pairing required");
      return await this.inbound.scan(body, undefined, socket.data.token);
    } catch (e: any) {
      return {
        status: "ERROR",
        code: e.code || e.getResponse?.()?.code || "SCAN_ERROR",
        message: e.getResponse?.()?.message || e.message,
        scanEventId: (body as any)?.scanEventId,
      };
    }
  }
}
