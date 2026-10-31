import { Database } from "./db";
import { passwordHash } from "../modules/identity/auth";
export async function seed() {
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters.");
  const db = new Database();
  try {
    await db.transaction(async (c) => {
      const w = await c.query(
        "INSERT INTO warehouses(code,name) VALUES('MAIN','Kho Vật Tư Chính') ON CONFLICT(code) DO UPDATE SET code=excluded.code RETURNING id",
      );
      await c.query(
        "INSERT INTO locations(warehouse_id,code,name) VALUES($1,'A-01','Kệ A · Ô 01') ON CONFLICT DO NOTHING",
        [w.rows[0].id],
      );
      const u = await c.query(
        "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Quản trị kho',$2,'ADMIN') ON CONFLICT(username) DO UPDATE SET username=excluded.username RETURNING id",
        [
          process.env.ADMIN_USERNAME || "admin",
          passwordHash(process.env.ADMIN_PASSWORD!),
        ],
      );
      await c.query(
        "INSERT INTO user_warehouses(user_id,warehouse_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [u.rows[0].id, w.rows[0].id],
      );
    });
    console.log(
      "Bootstrap warehouse/admin ready. Existing passwords and stock were not modified.",
    );
  } finally {
    await db.pool.end();
  }
}
if (require.main === module)
  seed().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
