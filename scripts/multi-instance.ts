import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { Database } from "../apps/api/src/database/db";
import { migrate } from "../apps/api/src/database/migrate";
import { InventoryService } from "../apps/api/src/modules/inventory/inventory.service";
import { InboundService } from "../apps/api/src/modules/inbound/inbound.service";
import { hash } from "../apps/api/src/shared/idempotency";
async function run() {
  const url = process.env.TEST_DATABASE_URL!;
  assert.ok(url && new URL(url).pathname.endsWith("_test"));
  await migrate(url);
  await mkdir("test-results", { recursive: true });
  const db = new Database(url);
  await db.pool.query("TRUNCATE warehouses,users,products,vendors CASCADE");
  const w = (
    await db.pool.query(
      "INSERT INTO warehouses(code,name) VALUES('WS','WS warehouse') RETURNING id",
    )
  ).rows[0].id;
  const l = (
    await db.pool.query(
      "INSERT INTO locations(warehouse_id,code,name) VALUES($1,'A1','A1') RETURNING id",
      [w],
    )
  ).rows[0].id;
  const u = (
    await db.pool.query(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES('ws','WS','unused','ADMIN') RETURNING id",
    )
  ).rows[0].id;
  await db.pool.query("INSERT INTO vendors(code,name) VALUES('V','Vendor')");
  await db.pool.query(
    "INSERT INTO products(part_no,specification) VALUES('WS-PART','WS Product')",
  );
  const session = randomBytes(32).toString("hex"),
    csrf = randomBytes(24).toString("hex");
  await db.pool.query(
    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [hash(session), u, csrf],
  );
  const actor: any = {
      id: u,
      role: "ADMIN",
      warehouses: [w],
      session_hash: hash(session),
    },
    inbound = new InboundService(db, new InventoryService(db));
  const draft = await inbound.draft(actor, { warehouseId: w, locationId: l }),
    pair = await inbound.makePairing(actor, draft.id);
  const logs = await Promise.all([
    open("test-results/instance-a.log", "w"),
    open("test-results/instance-b.log", "w"),
  ]);
  const children = [3002, 3003].map((port, i) =>
    spawn(process.execPath, ["apps/api/dist/main.js"], {
      env: {
        ...process.env,
        DATABASE_URL: url,
        PORT: String(port),
        WEB_ORIGIN: "http://localhost:5174",
        REDIS_URL: "redis://127.0.0.1:63799",
      },
      stdio: ["ignore", logs[i].fd, logs[i].fd],
      windowsHide: true,
    }),
  );
  const ready = async (port: number) => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("API not ready");
  };
  let pc: any, phone: any;
  try {
    await Promise.all([ready(3002), ready(3003)]);
    const event = (s: any, name: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timeout ${name}`)),
          10000,
        );
        s.once(name, (data: any) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
    pc = io("http://127.0.0.1:3002", {
      transports: ["websocket"],
      auth: { csrf, draftId: draft.id },
      extraHeaders: { Cookie: `wms_session=${session}` },
    });
    await event(pc, "draft:ready");
    phone = io("http://127.0.0.1:3003", {
      transports: ["websocket"],
      auth: { token: pair.token },
    });
    await event(phone, "scanner:ready");
    const change = event(pc, "draft:changed");
    const ack = await phone.timeout(5000).emitWithAck("scan:item", {
      draftId: draft.id,
      scanEventId: randomUUID(),
      raw: JSON.stringify({
        partNo: "WS-PART",
        vendorCode: "V",
        lotNo: "L",
        quantity: 10,
        mesPackNo: "WS-PACK",
        expiredDate: "2099-12-31",
      }),
    });
    assert.equal(ack.status, "ACCEPTED");
    assert.equal((await change).draftId, draft.id);
    console.log(
      "PASS scan ACK on instance B, PC update on instance A via Redis",
    );
    const revoked = event(phone, "session:revoked"),
      disconnected = event(phone, "disconnect");
    const r = await fetch(
      `http://127.0.0.1:3002/api/v1/inbound/drafts/${draft.id}/revoke`,
      {
        method: "POST",
        headers: {
          Cookie: `wms_session=${session}`,
          "x-csrf-token": csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(r.status, 201);
    await revoked;
    await disconnected;
    const refresh = await fetch(
      "http://127.0.0.1:3003/api/v1/scanner/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pair.token }),
      },
    );
    assert.equal(refresh.status, 401);
    console.log(
      "PASS revoke on A disconnects phone on B; refresh after revoke rejected",
    );
  } finally {
    pc?.disconnect();
    phone?.disconnect();
    children.forEach((c) => c.kill());
    await Promise.all(logs.map((f) => f.close()));
    await db.pool.end();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
