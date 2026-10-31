import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Req,
  Res,
  SetMetadata,
  CanActivate,
  ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";
import "@fastify/cookie";
import { z } from "zod";
import { Database } from "../../database/db";
import { ensure } from "../../shared/errors";
import { hash } from "../../shared/idempotency";
import { validate } from "../../shared/validation";
import { settings, isAllowedOrigin } from "../../config";
import { hashSync, verifySync, Algorithm } from "@node-rs/argon2";
export type Actor = {
  id: string;
  username: string;
  display_name: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  warehouses: string[];
  session_hash?: string;
  csrf_token?: string;
};
export const Public = () => SetMetadata("public", true);
export const Admin = () => SetMetadata("admin", true);
export function passwordHash(password: string) {
  return hashSync(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}
function matches(password: string, stored: string) {
  try {
    if (stored.startsWith("$argon2")) return verifySync(stored, password);
    const [salt, key] = stored.split(":");
    const actual = scryptSync(password, salt, 64, {
      N: 32768,
      maxmem: 128 * 1024 * 1024,
    });
    const expected = Buffer.from(key || "", "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
const dummyHash = passwordHash(randomBytes(32).toString("hex"));
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Database) private db: Database,
    @Inject(Reflector) private reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    // ScannerGateway validates its scoped pairing on connection and every scan.
    if (context.getType() !== "http") return true;
    if (
      this.reflector.getAllAndOverride("public", [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.wms_session;
    ensure(token, "UNAUTHENTICATED", "Vui lòng đăng nhập.", 401);
    const r = await this.db.pool.query(
      `SELECT u.id,u.username,u.display_name,u.role,s.csrf_token,s.token_hash AS session_hash,
      ARRAY(SELECT warehouse_id FROM user_warehouses WHERE user_id=u.id) AS warehouses
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
      [hash(token)],
    );
    ensure(r.rowCount, "UNAUTHENTICATED", "Phiên làm việc đã hết hạn.", 401);
    req.actor = r.rows[0];
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      ensure(
        req.headers["x-csrf-token"] === req.actor.csrf_token,
        "CSRF_REJECTED",
        "Phiên xác nhận không hợp lệ.",
        403,
      );
      ensure(
        req.actor.role !== "VIEWER" ||
          this.reflector.getAllAndOverride("sessionAction", [
            context.getHandler(),
            context.getClass(),
          ]),
        "FORBIDDEN",
        "Tài khoản chỉ có quyền xem.",
        403,
      );
      ensure(
        !req.headers.origin || isAllowedOrigin(req.headers.origin),
        "ORIGIN_REJECTED",
        "Nguồn yêu cầu không được phép.",
        403,
      );
    }
    if (
      this.reflector.getAllAndOverride("admin", [
        context.getHandler(),
        context.getClass(),
      ])
    )
      ensure(
        req.actor.role === "ADMIN",
        "FORBIDDEN",
        "Cần quyền quản trị.",
        403,
      );
    return true;
  }
}
@Controller("auth")
export class AuthController {
  private failures = new Map<string, { count: number; until: number }>();
  constructor(@Inject(Database) private db: Database) {}
  @Public()
  @Post("login")
  async login(
    @Body() body: unknown,
    @Req() req: any,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = validate(
      z.object({
        username: z.string().trim().min(1).max(100),
        password: z.string().min(1).max(200),
      }),
      body,
    );
    const ip = req.ip;
    const entry = this.failures.get(ip);
    ensure(
      !entry || entry.until < Date.now() || entry.count < 10,
      "RATE_LIMIT",
      "Thử đăng nhập quá nhiều. Chờ một phút.",
      429,
    );
    const r = await this.db.pool.query(
      "SELECT * FROM users WHERE username=$1 AND active",
      [b.username],
    );
    const valid = matches(b.password, r.rows[0]?.password_hash || dummyHash);
    const ok = r.rowCount && valid;
    if (!ok) {
      this.failures.set(ip, {
        count: entry && entry.until > Date.now() ? entry.count + 1 : 1,
        until: Date.now() + 60000,
      });
    }
    ensure(
      ok,
      "INVALID_CREDENTIALS",
      "Tên đăng nhập hoặc mật khẩu không đúng.",
      401,
    );
    this.failures.delete(ip);
    if (!r.rows[0].password_hash.startsWith("$argon2"))
      await this.db.pool.query(
        "UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3",
        [r.rows[0].id, passwordHash(b.password), r.rows[0].password_hash],
      );
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(24).toString("base64url");
    await this.db.pool.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
      [hash(token), r.rows[0].id, csrf],
    );
    reply.setCookie("wms_session", token, {
      httpOnly: true,
      secure: settings.secure,
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 3600,
    });
    return {
      csrfToken: csrf,
      user: {
        id: r.rows[0].id,
        username: b.username,
        display_name: r.rows[0].display_name,
        role: r.rows[0].role,
      },
    };
  }
  @Get("me") me(@Req() req: any) {
    return { user: req.actor, csrfToken: req.actor.csrf_token };
  }
  @SetMetadata("sessionAction", true)
  @Post("logout")
  async logout(
    @Req() req: any,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.db.pool.query(
      "UPDATE sessions SET expires_at=now() WHERE token_hash=$1",
      [req.actor.session_hash],
    );
    reply.clearCookie("wms_session", { path: "/" });
    return { ok: true };
  }
}
@Admin()
@Controller("users")
export class UsersController {
  constructor(@Inject(Database) private db: Database) {}
  @Get() async list() {
    return (
      await this.db.pool.query(
        "SELECT u.id,u.username,u.display_name,u.role,u.active,ARRAY(SELECT warehouse_id FROM user_warehouses WHERE user_id=u.id) AS warehouses FROM users u ORDER BY username",
      )
    ).rows;
  }
  @Post() async create(@Body() body: unknown) {
    const b = validate(
      z.object({
        username: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9_.-]{3,50}$/),
        displayName: z.string().trim().min(1).max(100),
        password: z.string().min(12).max(200),
        role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
        warehouses: z.array(z.uuid()).max(100),
      }),
      body,
    );
    return this.db.transaction(async (c) => {
      const u = (
        await c.query(
          "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role,active",
          [b.username, b.displayName, passwordHash(b.password), b.role],
        )
      ).rows[0];
      for (const wh of new Set(b.warehouses))
        await c.query(
          "INSERT INTO user_warehouses(user_id,warehouse_id) VALUES($1,$2)",
          [u.id, wh],
        );
      return u;
    });
  }
  @Post(":id/disable") async disable(@Req() req: any) {
    const id = validate(z.uuid(), req.params.id);
    ensure(
      id !== req.actor.id,
      "SELF_DISABLE",
      "Không thể khóa tài khoản đang sử dụng.",
      422,
    );
    return this.db.transaction(async (c) => {
      await c.query("UPDATE users SET active=false WHERE id=$1", [id]);
      await c.query("UPDATE sessions SET expires_at=now() WHERE user_id=$1", [
        id,
      ]);
      return { ok: true };
    });
  }
}
