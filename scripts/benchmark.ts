import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { Database } from "../apps/api/src/database/db";
import { migrate } from "../apps/api/src/database/migrate";
import { hash } from "../apps/api/src/shared/idempotency";
async function run() {
  const url = process.env.TEST_DATABASE_URL!;
  assert.ok(url && new URL(url).pathname.endsWith("_test"));
  await migrate(url);
  const db = new Database(url);
  const reuse = process.argv.includes("--reuse");
  await mkdir("test-results", { recursive: true });
  if (!reuse)
    await db.pool.query("TRUNCATE warehouses,users,products,vendors CASCADE");
  const w = (
    await db.pool.query(
      reuse
        ? "SELECT id FROM warehouses WHERE code='BENCH'"
        : "INSERT INTO warehouses(code,name) VALUES('BENCH','Benchmark warehouse') RETURNING id",
    )
  ).rows[0].id;
  const l = (
    await db.pool.query(
      reuse
        ? "SELECT id FROM locations WHERE warehouse_id=$1 AND code='A1'"
        : "INSERT INTO locations(warehouse_id,code,name) VALUES($1,'A1','A1') RETURNING id",
      [w],
    )
  ).rows[0].id;
  const u = (
    await db.pool.query(
      reuse
        ? "SELECT id FROM users WHERE username='bench'"
        : "INSERT INTO users(username,display_name,password_hash,role) VALUES('bench','Benchmark','unused','ADMIN') RETURNING id",
    )
  ).rows[0].id;
  if (!reuse) {
    await db.pool.query(
      "INSERT INTO vendors(code,name) VALUES('BENCH','Benchmark')",
    );
    console.log(
      "Seeding 20,000 products, 500,000 packs and 1,000,000 movements in *_test only...",
    );
    await db.pool.query(
      "INSERT INTO products(part_no,specification) SELECT 'PART-'||lpad(n::text,6,'0'),'SPONGE ESD '||lpad(n::text,6,'0') FROM generate_series(1,20000) n",
    );
    await db.pool.query(
      `INSERT INTO stock_pack_balances(product_id,location_id,lot_no,mes_pack_no,vendor_code,expired_date,on_hand)
    SELECT p.id,$1,'LOT-'||(n/100)::text,'000'||lpad(n::text,12,'0'),'BENCH','2099-12-31',1
    FROM generate_series(1,500000) n JOIN products p ON p.part_no='PART-'||lpad((1+(n%20000))::text,6,'0')`,
      [l],
    );
    await db.pool.query(
      `INSERT INTO stock_movements(pack_balance_id,product_id,location_id,quantity_delta,balance_after,movement_type,reference_type,reference_id,actor_id)
    SELECT b.id,b.product_id,b.location_id,CASE WHEN n=1 THEN 2 ELSE -1 END,CASE WHEN n=1 THEN 2 ELSE 1 END,
    CASE WHEN n=1 THEN 'INBOUND' ELSE 'OUTBOUND' END,'BENCH',gen_random_uuid(),$1 FROM stock_pack_balances b CROSS JOIN generate_series(1,2) n`,
      [u],
    );
    await db.pool.query("ANALYZE");
  }
  // Measure steady-state read performance after GIN pending lists from bulk seeding have been flushed.
  await db.pool.query("VACUUM (ANALYZE) products");
  await db.pool.query("VACUUM (ANALYZE) stock_pack_balances");
  await db.pool.query("VACUUM (ANALYZE) stock_movements");
  console.log("Seed ready; warming queries.");
  const session = randomBytes(32).toString("hex");
  await db.pool.query(
    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'csrf',now()+interval '1 hour')",
    [hash(session), u],
  );
  const log = await open("test-results/benchmark-api.log", "w");
  const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: "3002",
      WEB_ORIGIN: "http://localhost:5174",
      REDIS_URL: "",
    },
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
  });
  const results: any = {
    products: 20000,
    packs: 500000,
    movements: 1000000,
    concurrency: 20,
    samples: 400,
    node: process.version,
    platform: process.platform,
    warmCache: true,
  };
  async function measure(
    name: string,
    fn: (i: number) => Promise<unknown>,
    serverTime = false,
  ) {
    for (let i = 0; i < 30; i++) await fn(i);
    const times: number[] = [];
    let n = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        for (;;) {
          const i = n++;
          if (i >= 400) break;
          const start = performance.now();
          const measured = await fn(i);
          times.push(serverTime ? Number(measured) : performance.now() - start);
        }
      }),
    );
    times.sort((a, b) => a - b);
    results[name] = {
      p50: +times[199].toFixed(2),
      p95: +times[379].toFixed(2),
      p99: +times[395].toFixed(2),
    };
    console.log(name, results[name]);
  }
  const http = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:3002/api/v1${path}`, {
      headers: { Cookie: `wms_session=${session}` },
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch("http://127.0.0.1:3002/api/v1/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await measure("exact_db_roundtrip", (i) =>
      db.pool.query(
        "SELECT id,on_hand FROM stock_pack_balances WHERE mes_pack_no=$1",
        ["000" + String(1000 + i).padStart(12, "0")],
      ),
    );
    await measure("trigram_db_roundtrip", (i) =>
      db.pool.query(
        "SELECT id,part_no,specification FROM products WHERE specification ILIKE $1 OR part_no ILIKE $1 ORDER BY part_no LIMIT 100",
        ["%ESD " + String(i % 100).padStart(4, "0") + "%"],
      ),
    );
    await measure(
      "exact_db_execution",
      async (i) => {
        const plan = (
          await db.pool.query(
            "EXPLAIN (ANALYZE, FORMAT JSON) SELECT id,on_hand FROM stock_pack_balances WHERE mes_pack_no=$1",
            ["000" + String(1000 + i).padStart(12, "0")],
          )
        ).rows[0]["QUERY PLAN"][0];
        return plan["Planning Time"] + plan["Execution Time"];
      },
      true,
    );
    await measure(
      "trigram_db_execution",
      async (i) => {
        const plan = (
          await db.pool.query(
            "EXPLAIN (ANALYZE, FORMAT JSON) SELECT id,part_no,specification FROM products WHERE specification ILIKE $1 OR part_no ILIKE $1 ORDER BY part_no LIMIT 100",
            ["%ESD " + String(i % 100).padStart(4, "0") + "%"],
          )
        ).rows[0]["QUERY PLAN"][0];
        return plan["Planning Time"] + plan["Execution Time"];
      },
      true,
    );
    await measure("products_api", (i) =>
      http(
        "/products?q=" +
          encodeURIComponent("ESD " + String(i % 100).padStart(4, "0")),
      ),
    );
    await measure("pack_exact_api", (i) =>
      http(
        `/inventory/packs?warehouseId=${w}&q=000${String(1000 + i).padStart(12, "0")}`,
      ),
    );
    await measure("part_exact_api", (i) =>
      http(
        `/inventory/packs?warehouseId=${w}&q=PART-${String(100 + i).padStart(6, "0")}`,
      ),
    );
    results.targets = {
      exactDbExecutionP95: 2,
      trigramDbExecutionP95: 15,
      apiP95: 50,
    };
    results.measurementNotes =
      "DB execution = Planning Time + Execution Time from EXPLAIN ANALYZE. DB roundtrip includes driver/network/queue time on Windows-to-Docker. API timings include auth and HTTP. Hardware is this workstation, not a certified 4-core/8-GB reference server.";
    results.meetsTargets =
      results.exact_db_execution.p95 < 2 &&
      results.trigram_db_execution.p95 < 15 &&
      ["products_api", "pack_exact_api", "part_exact_api"].every(
        (k) => results[k].p95 < 50,
      );
    await writeFile(
      "test-results/benchmark.json",
      JSON.stringify(results, null, 2),
    );
    console.log("SLA met:", results.meetsTargets);
  } finally {
    child.kill();
    await log.close();
    await db.pool.end();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
