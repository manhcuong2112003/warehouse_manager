import { Injectable, OnModuleDestroy, Optional, Inject } from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import { settings } from "../config";
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;
  constructor(@Optional() @Inject("DATABASE_URL") url = settings.databaseUrl) {
    if (!url)
      throw new Error(
        "DATABASE_URL is required. Copy .env.example and configure PostgreSQL.",
      );
    this.pool = new Pool({
      connectionString: url,
      max: 30,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on("error", (err) =>
      console.error("PostgreSQL pool error:", err.message),
    );
  }
  async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    repeatable = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query(
          repeatable ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
        );
        await c.query("SET LOCAL lock_timeout = '5s'");
        await c.query("SET LOCAL statement_timeout = '60s'");
        const result = await fn(c);
        await c.query("COMMIT");
        return result;
      } catch (e: any) {
        await c.query("ROLLBACK");
        if (["40P01", "40001"].includes(e.code) && attempt < 2) continue;
        throw e;
      } finally {
        c.release();
      }
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
