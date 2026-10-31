import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { INestApplication } from "@nestjs/common";
export class RedisSocketAdapter extends IoAdapter {
  private pub: any;
  private sub: any;
  constructor(app: INestApplication) {
    super(app);
  }
  async connect(url: string) {
    this.pub = createClient({ url });
    this.sub = this.pub.duplicate();
    for (const client of [this.pub, this.sub])
      client.on("error", (e: Error) =>
        console.error("Redis adapter:", e.message),
      );
    await Promise.all([this.pub.connect(), this.sub.connect()]);
  }
  createIOServer(port: number, options?: any) {
    const server = super.createIOServer(port, {
      ...options,
      transports: ["websocket"],
    });
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }
  async dispose() {
    await super.dispose();
    await Promise.all([this.pub?.quit(), this.sub?.quit()]);
  }
}
