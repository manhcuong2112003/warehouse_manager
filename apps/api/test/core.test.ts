import "reflect-metadata";
import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/database/db";
import { migrate } from "../src/database/migrate";
import { InventoryService } from "../src/modules/inventory/inventory.service";
import { InboundService } from "../src/modules/inbound/inbound.service";
import { parseBarcode } from "../src/modules/inbound/barcode";
import { ImportService } from "../src/modules/imports/import.service";
import { validateQuantity } from "../src/shared/validation";
import { ReportService } from "../src/modules/reporting/report.service";
import { ExcelService } from "../src/modules/reporting/excel.service";
import ExcelJS from "exceljs";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Writable } from "node:stream";
import { hash } from "../src/shared/idempotency";
import { Actor } from "../src/modules/identity/auth";
const url = process.env.TEST_DATABASE_URL!;
assert.ok(
  url && new URL(url).pathname.endsWith("_test"),
  "Tests require a dedicated *_test database.",
);
const db = new Database(url),
  inventory = new InventoryService(db),
  inbound = new InboundService(db, inventory),
  imports = new ImportService(db, inventory);
let actor: Actor, warehouse: string, location: string, product: string;
before(async () => {
  await migrate(url);
});
after(async () => {
  await db.pool.end();
});
beforeEach(async () => {
  await db.pool.query("TRUNCATE warehouses,users,products,vendors CASCADE");
  warehouse = (
    await db.pool.query(
      "INSERT INTO warehouses(code,name) VALUES('TEST','Test warehouse') RETURNING id",
    )
  ).rows[0].id;
  location = (
    await db.pool.query(
      "INSERT INTO locations(warehouse_id,code,name) VALUES($1,'A1','A1') RETURNING id",
      [warehouse],
    )
  ).rows[0].id;
  await db.pool.query("INSERT INTO vendors(code,name) VALUES('V','Vendor')");
  product = (
    await db.pool.query(
      "INSERT INTO products(part_no,specification) VALUES('GH02-28974A-R0','Sponge') RETURNING id",
    )
  ).rows[0].id;
  const user = (
    await db.pool.query(
      "INSERT INTO users(username,display_name,password_hash,role) VALUES('test','Test','unused','ADMIN') RETURNING id",
    )
  ).rows[0].id;
  actor = {
    id: user,
    username: "test",
    display_name: "Test",
    role: "ADMIN",
    warehouses: [warehouse],
  };
});
async function receive(qty = 100, pack = "PACK-001", expiry = "2099-12-31") {
  return inventory.receiveManual(actor, randomUUID(), {
    warehouseId: warehouse,
    reference: randomUUID(),
    packs: [
      {
        productId: product,
        locationId: location,
        lotNo: "LOT1",
        mesPackNo: pack,
        vendorCode: "V",
        quantity: qty,
        expiredDate: expiry,
      },
    ],
  });
}
async function order(qty: number) {
  return inventory.createOrder(actor, randomUUID(), {
    warehouseId: warehouse,
    reference: randomUUID(),
    lines: [{ productId: product, quantity: qty }],
  });
}
test("parser accepts leading zeros; rejects garbage, fractions, negatives and unsafe numbers", () => {
  assert.equal(validateQuantity("010000"), 10000);
  for (const s of [
    "0",
    "000",
    "100abc",
    "1.5",
    "-10",
    "9007199254740993",
    "10000001",
  ])
    assert.throws(() => validateQuantity(s));
  assert.equal(parseBarcode("GH02-28974A-R0|V|E1|LOT1|010000").quantity, 10000);
  assert.equal(
    parseBarcode("(240)GH02-28974A-R0(10)LOT1(21)PACK1(17)271015(30)010000")
      .expiredDate,
    "2027-10-15",
  );
});
test("20 concurrent reservations never oversell; failed allocations roll back", async () => {
  await receive();
  const orders = await Promise.all(Array.from({ length: 20 }, () => order(10)));
  const results = await Promise.allSettled(
    orders.map((o) =>
      inventory.transition(actor, randomUUID(), o.id, "reserve"),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
  const balance = (await db.pool.query("SELECT * FROM stock_pack_balances"))
    .rows[0];
  assert.equal(Number(balance.on_hand), 100);
  assert.equal(Number(balance.reserved), 100);
  assert.equal(
    Number(
      (
        await db.pool.query(
          "SELECT sum(quantity) AS qty FROM stock_reservations WHERE status='ACTIVE'",
        )
      ).rows[0].qty,
    ),
    100,
  );
});
test("FEFO and all-or-nothing allocation across multiple packs", async () => {
  await receive(20, "LATE", "2099-12-31");
  await receive(10, "EARLY", "2098-01-01");
  const a = await order(25);
  await inventory.transition(actor, randomUUID(), a.id, "reserve");
  const b = (
    await db.pool.query(
      "SELECT mes_pack_no,reserved FROM stock_pack_balances ORDER BY mes_pack_no",
    )
  ).rows;
  assert.equal(Number(b[0].reserved), 10);
  assert.equal(Number(b[1].reserved), 15);
  const fail = await order(20);
  await assert.rejects(() =>
    inventory.transition(actor, randomUUID(), fail.id, "reserve"),
  );
  assert.equal(
    Number(
      (
        await db.pool.query(
          "SELECT sum(reserved) AS q FROM stock_pack_balances",
        )
      ).rows[0].q,
    ),
    25,
  );
});
test("same idempotency key ships once; different keys cannot repeat business operation; ledger reconciles", async () => {
  await receive();
  const o = await order(30);
  await inventory.transition(actor, randomUUID(), o.id, "reserve");
  const key = randomUUID();
  await Promise.all([
    inventory.transition(actor, key, o.id, "ship"),
    inventory.transition(actor, key, o.id, "ship"),
  ]);
  await inventory.transition(actor, randomUUID(), o.id, "ship");
  const b = (await db.pool.query("SELECT * FROM stock_pack_balances")).rows[0];
  assert.equal(Number(b.on_hand), 70);
  assert.equal(Number(b.reserved), 0);
  const m = (
    await db.pool.query(
      "SELECT count(*) AS n,sum(quantity_delta) AS qty FROM stock_movements",
    )
  ).rows[0];
  assert.equal(Number(m.n), 2);
  assert.equal(Number(m.qty), 70);
  await assert.rejects(() =>
    db.pool.query("UPDATE stock_movements SET quantity_delta=1"),
  );
});
test("expiry or quarantine after reserve rejects ship and cancel releases stock", async () => {
  const r = await receive();
  const o = await order(30);
  await inventory.transition(actor, randomUUID(), o.id, "reserve");
  await db.pool.query(
    "UPDATE stock_pack_balances SET expired_date='2000-01-01' WHERE id=$1",
    [r.packs[0]],
  );
  await assert.rejects(
    () => inventory.transition(actor, randomUUID(), o.id, "ship"),
    (e: any) => e.code === "EXPIRED_DURING_RESERVATION",
  );
  assert.equal(
    Number(
      (await db.pool.query("SELECT on_hand FROM stock_pack_balances")).rows[0]
        .on_hand,
    ),
    100,
  );
  await inventory.transition(actor, randomUUID(), o.id, "cancel");
  assert.equal(
    Number(
      (await db.pool.query("SELECT reserved FROM stock_pack_balances")).rows[0]
        .reserved,
    ),
    0,
  );
});
test("quarantine racing with ship is observed after row lock", async () => {
  await receive();
  const o = await order(30);
  await inventory.transition(actor, randomUUID(), o.id, "reserve");
  const c = await db.pool.connect();
  await c.query("BEGIN");
  await c.query("UPDATE stock_pack_balances SET status='QUARANTINE'");
  const ship = inventory.transition(actor, randomUUID(), o.id, "ship");
  await c.query("COMMIT");
  c.release();
  await assert.rejects(ship, (e: any) => e.code === "PACK_NOT_AVAILABLE");
  assert.equal(
    Number(
      (await db.pool.query("SELECT on_hand FROM stock_pack_balances")).rows[0]
        .on_hand,
    ),
    100,
  );
});
test("scan persistence supports incomplete 1D, merge, atomic ACK replay and duplicate pack race", async () => {
  const d = await inbound.draft(actor, {
    warehouseId: warehouse,
    locationId: location,
  });
  const event = randomUUID();
  const initial = {
    draftId: d.id,
    scanEventId: event,
    raw: "GH02-28974A-R0|V|E1|LOT1|010000",
  };
  const results = await Promise.all([
    inbound.scan(initial, actor),
    inbound.scan(initial, actor),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "ACCEPTED",
    "ACCEPTED_IDEMPOTENT",
  ]);
  const line = results[0].item;
  assert.equal(line.mes_pack_no, null);
  await assert.rejects(() => inbound.confirm(actor, randomUUID(), d.id));
  const merge = await inbound.scan(
    {
      draftId: d.id,
      scanEventId: randomUUID(),
      targetLineId: line.id,
      raw: "PACK-MERGE",
    },
    actor,
  );
  assert.equal(merge.item.status, "WAITING_EXP_DATE");
  await inbound.setExpiry(actor, d.id, line.id, { expiredDate: "2099-12-31" });
  await inbound.confirm(actor, randomUUID(), d.id);
  await inbound.confirm(actor, randomUUID(), d.id);
  assert.equal(
    Number(
      (await db.pool.query("SELECT count(*) FROM stock_movements")).rows[0]
        .count,
    ),
    1,
  );
  const d2 = await inbound.draft(actor, {
    warehouseId: warehouse,
    locationId: location,
  });
  const full = JSON.stringify({
    partNo: "GH02-28974A-R0",
    lotNo: "LOT1",
    vendorCode: "V",
    quantity: 10,
    mesPackNo: "DUP",
    expiredDate: "2099-12-31",
  });
  const race = await Promise.allSettled(
    [1, 2].map(() =>
      inbound.scan(
        { draftId: d2.id, scanEventId: randomUUID(), raw: full },
        actor,
      ),
    ),
  );
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    Number(
      (
        await db.pool.query(
          "SELECT count(*) FROM inbound_scan_events WHERE draft_id=$1",
          [d2.id],
        )
      ).rows[0].count,
    ),
    1,
  );
});
test("import preview never changes stock; opening balance commit is atomic and retry-safe", async () => {
  const csv = Buffer.from(
    "part_no,location_code,lot_no,mes_pack_no,vendor_code,quantity,expired_date,status\nGH02-28974A-R0,A1,OLD,000001,V,0100,2000-01-01,AVAILABLE",
  );
  const job = await imports.upload(
    actor,
    warehouse,
    "OPENING_BALANCE",
    "old.csv",
    csv,
  );
  await imports.mapping(actor, job.id, {
    mapping: {
      part_no: 0,
      location_code: 1,
      lot_no: 2,
      mes_pack_no: 3,
      vendor_code: 4,
      quantity: 5,
      expired_date: 6,
      status: 7,
    },
    options: { sheet: "CSV", headerRow: 1, dateFormat: "ISO", thousands: "" },
  });
  const preview = await imports.validateJob(actor, job.id);
  assert.equal(preview.errors, 0);
  assert.equal(
    Number(
      (await db.pool.query("SELECT count(*) FROM stock_pack_balances")).rows[0]
        .count,
    ),
    0,
  );
  const j = await imports.get(actor, job.id);
  const key = randomUUID();
  const body = { previewVersion: j.preview_version, acknowledgeWarnings: true };
  await imports.confirm(actor, job.id, key, body);
  await imports.confirm(actor, job.id, key, body);
  await imports.confirm(actor, job.id, randomUUID(), body);
  const b = (await db.pool.query("SELECT * FROM stock_pack_balances")).rows[0];
  assert.equal(b.status, "EXPIRED");
  assert.equal(Number(b.on_hand), 100);
  assert.equal(
    Number(
      (await db.pool.query("SELECT count(*) FROM stock_movements")).rows[0]
        .count,
    ),
    1,
  );
});
test("warehouse scope prevents cross-warehouse mutation", async () => {
  const limited = { ...actor, role: "OPERATOR" as const, warehouses: [] };
  await assert.rejects(
    () =>
      inbound.draft(limited, { warehouseId: warehouse, locationId: location }),
    (e: any) => e.getStatus() === 403,
  );
});
test("pairing scope, active revocation and PC session expiry are enforced for every event and refresh", async () => {
  actor.session_hash = hash("test-session");
  await db.pool.query(
    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf',now()+interval '1 hour')",
    [actor.session_hash, actor.id],
  );
  const d = await inbound.draft(actor, {
      warehouseId: warehouse,
      locationId: location,
    }),
    other = await inbound.draft(actor, {
      warehouseId: warehouse,
      locationId: location,
    });
  const pair = await inbound.makePairing(actor, d.id);
  await assert.rejects(
    () =>
      inbound.scan(
        {
          draftId: other.id,
          scanEventId: randomUUID(),
          raw: "GH02-28974A-R0|V|E1|LOT1|10",
        },
        undefined,
        pair.token,
      ),
    (e: any) => e.code === "PAIRING_SCOPE",
  );
  await inbound.revoke(actor, d.id);
  await assert.rejects(() => inbound.refresh(pair.token));
  const next = await inbound.makePairing(actor, d.id);
  await db.pool.query(
    "UPDATE sessions SET expires_at=now() WHERE token_hash=$1",
    [actor.session_hash],
  );
  await assert.rejects(() => inbound.refresh(next.token));
  await assert.rejects(() =>
    inbound.scan(
      {
        draftId: d.id,
        scanEventId: randomUUID(),
        raw: "GH02-28974A-R0|V|E1|LOT1|10",
      },
      undefined,
      next.token,
    ),
  );
});
test("queued 1D/2D events use stable client line IDs and replay rejects changed payloads", async () => {
  const d = await inbound.draft(actor, {
    warehouseId: warehouse,
    locationId: location,
  });
  const line = randomUUID(),
    event = randomUUID();
  const raw = {
    draftId: d.id,
    scanEventId: event,
    newLineId: line,
    raw: "GH02-28974A-R0|V|E1|LOT1|10",
  };
  await inbound.scan(raw, actor);
  const merged = await inbound.scan(
    {
      draftId: d.id,
      scanEventId: randomUUID(),
      targetLineId: line,
      raw: "QUEUE-PACK",
    },
    actor,
  );
  assert.equal(merged.item.id, line);
  await assert.rejects(
    () => inbound.scan({ ...raw, raw: "GH02-28974A-R0|V|E1|LOT1|20" }, actor),
    (e: any) => e.code === "SCAN_EVENT_CONFLICT",
  );
});
test("period rollup includes opening once and dashboard counts quarantine/expired physical stock correctly", async () => {
  const effective = (await db.pool.query("SELECT clock_timestamp()::text AS t"))
    .rows[0].t;
  await db.transaction((c) =>
    inventory.receive(
      c,
      actor,
      warehouse,
      "OPENING",
      [
        {
          productId: product,
          locationId: location,
          lotNo: "L",
          mesPackNo: "BASE",
          vendorCode: "V",
          quantity: 100,
          expiredDate: "2099-12-31",
          status: "AVAILABLE",
        },
      ],
      "OPENING_BALANCE",
      undefined,
      effective,
    ),
  );
  await db.pool.query("UPDATE warehouses SET cutover_at=$2 WHERE id=$1", [
    warehouse,
    effective,
  ]);
  await receive(20, "RECEIVED");
  const o = await order(30);
  await inventory.transition(actor, randomUUID(), o.id, "reserve");
  await inventory.transition(actor, randomUUID(), o.id, "ship");
  const reports = new ReportService(db);
  const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    }),
    to = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    });
  const report = await reports.report(actor, "period", {
    warehouseId: warehouse,
    from: today,
    to,
  });
  const r = report.rows[0];
  assert.deepEqual(
    [r.opening, r.inbound, r.outbound, r.closing].map(Number),
    [100, 20, 30, 90],
  );
  await db.pool.query(
    "UPDATE stock_pack_balances SET status='QUARANTINE' WHERE mes_pack_no='BASE'",
  );
  await db.pool.query(
    "UPDATE stock_pack_balances SET expired_date='2000-01-01' WHERE mes_pack_no='RECEIVED'",
  );
  const dash = await reports.dashboard(actor, warehouse);
  assert.equal(Number(dash.units[0].on_hand), 90);
  assert.equal(Number(dash.units[0].available), 0);
  assert.equal(Number(dash.units[0].packs), 2);
});
test(
  "100000-row XLSX streaming is readable and stays within a measured memory budget",
  { timeout: 180000 },
  async () => {
    await mkdir("test-results", { recursive: true });
    await db.pool.query(
      `INSERT INTO stock_pack_balances(product_id,location_id,lot_no,mes_pack_no,vendor_code,expired_date,on_hand)
    SELECT $1,$2,'PERF','000'||lpad(n::text,12,'0'),'V','2099-12-31',1 FROM generate_series(1,100000) n`,
      [product, location],
    );
    await db.pool.query(
      `INSERT INTO stock_movements(pack_balance_id,product_id,location_id,quantity_delta,balance_after,movement_type,reference_type,reference_id,actor_id)
    SELECT id,product_id,location_id,1,1,'INBOUND','TEST',gen_random_uuid(),$1 FROM stock_pack_balances`,
      [actor.id],
    );
    const excel = new ExcelService(new ReportService(db));
    let peak = process.memoryUsage().rss;
    const baseline = peak,
      start = Date.now();
    const timer = setInterval(
      () => (peak = Math.max(peak, process.memoryUsage().rss)),
      25,
    );
    try {
      const result = await excel.stream(
        actor,
        "movements",
        { warehouseId: warehouse },
        createWriteStream("test-results/export-100000.xlsx"),
      );
      assert.equal(result.rows, 100000);
    } finally {
      clearInterval(timer);
    }
    const delta = (peak - baseline) / 1024 / 1024;
    console.log(
      JSON.stringify({
        exportRows: 100000,
        milliseconds: Date.now() - start,
        baselineRssMB: Math.round(baseline / 1024 / 1024),
        peakRssMB: Math.round(peak / 1024 / 1024),
        deltaMB: Math.round(delta),
      }),
    );
    assert.ok(delta < 256, `RSS grew by ${delta} MB`);
    let count = 0;
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(
      "test-results/export-100000.xlsx",
      {
        worksheets: "emit",
        sharedStrings: "cache",
        styles: "ignore",
        hyperlinks: "ignore",
      },
    );
    for await (const sheet of reader)
      for await (const row of sheet) {
        count++;
        if (row.number === 6)
          assert.equal(typeof row.getCell(6).value, "string");
      }
    assert.equal(count, 100006);
    let slowPeak = process.memoryUsage().rss,
      bytes = 0;
    const slowTimer = setInterval(
      () => (slowPeak = Math.max(slowPeak, process.memoryUsage().rss)),
      25,
    );
    const slow = () =>
      new Writable({
        highWaterMark: 16384,
        write(chunk, _enc, cb) {
          bytes += chunk.length;
          setTimeout(cb, 50);
        },
      });
    const a = excel.stream(
        actor,
        "movements",
        { warehouseId: warehouse },
        slow(),
      ),
      b = excel.stream(actor, "movements", { warehouseId: warehouse }, slow());
    await assert.rejects(
      () =>
        excel.stream(
          actor,
          "movements",
          { warehouseId: warehouse },
          new Writable({
            write(_c, _e, cb) {
              cb();
            },
          }),
        ),
      (e: any) => e.code === "EXPORT_BUSY",
    );
    try {
      const results = await Promise.all([a, b]);
      assert.ok(results.every((r) => r.rows === 100000));
    } finally {
      clearInterval(slowTimer);
    }
    assert.ok(bytes > 0);
    assert.ok(
      slowPeak < 768 * 1024 * 1024,
      "Two slow exports exceed process memory budget",
    );
    console.log(
      JSON.stringify({
        slowConcurrentExports: 2,
        rowsEach: 100000,
        totalBytes: bytes,
        peakRssMB: Math.round(slowPeak / 1024 / 1024),
      }),
    );
    const cancel = new AbortController(),
      sink = new Writable({
        write(_chunk, _enc, cb) {
          cancel.abort();
          cb();
        },
      });
    sink.on("error", () => {});
    await assert.rejects(() =>
      excel.stream(
        actor,
        "movements",
        { warehouseId: warehouse },
        sink,
        cancel.signal,
      ),
    );
    assert.equal(db.pool.waitingCount, 0);
  },
);
