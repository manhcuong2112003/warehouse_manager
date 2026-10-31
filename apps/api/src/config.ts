import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(__dirname, "../../../.env"), quiet: true });
export const settings = {
  databaseUrl: process.env.DATABASE_URL || "",
  migrationUrl: process.env.MIGRATION_DATABASE_URL || "",
  port: Number(process.env.PORT || 3001),
  origin: process.env.WEB_ORIGIN || "http://localhost:5173",
  secure: process.env.COOKIE_SECURE === "true",
};

export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  if (origin === settings.origin) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)) return true;
  return false;
}
