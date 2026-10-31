import { request } from "node:https";
import { readFileSync } from "node:fs";
import "../apps/api/src/config";
const origin = process.env.LAN_ORIGIN;
if (!origin) throw new Error("LAN_ORIGIN required");
const ca = readFileSync("deploy/certs/rootCA.pem");
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; headers: any; body: string }>(
    (resolve, reject) => {
      const req = request(
        new URL(path, origin),
        {
          method,
          ca,
          headers: {
            ...headers,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.setTimeout(10000, () =>
        req.destroy(new Error("TLS request timed out")),
      );
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    },
  );
}
async function run() {
  const health = await call("/api/v1/health");
  if (health.status !== 200) throw new Error(health.body);
  const login = await call(
    "/api/v1/auth/login",
    "POST",
    {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    },
    { Origin: origin! },
  );
  if (login.status !== 201) throw new Error("LAN login failed");
  const cookies = login.headers["set-cookie"] as string[];
  if (!cookies?.some((c) => c.includes("HttpOnly") && c.includes("Secure")))
    throw new Error("Secure cookie missing");
  const cookie = cookies[0].split(";")[0],
    csrf = JSON.parse(login.body).csrfToken;
  const warehouses = await call("/api/v1/warehouses", "GET", undefined, {
    Cookie: cookie,
  });
  if (warehouses.status !== 200) throw new Error("Warehouse read failed");
  const root = await call("/");
  if (root.status !== 200 || !root.body.includes("root"))
    throw new Error("Web assets unavailable");
  await call(
    "/api/v1/auth/logout",
    "POST",
    {},
    { Cookie: cookie, Origin: origin!, "x-csrf-token": csrf },
  );
  console.log(
    "PASS LAN HTTPS certificate chain/SAN verified against internal root CA; health, secure login, warehouse read and web assets work.",
  );
}
run().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
