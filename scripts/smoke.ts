import "reflect-metadata";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../apps/api/src/database/db";
import { migrate } from "../apps/api/src/database/migrate";
import { passwordHash } from "../apps/api/src/modules/identity/auth";
import ExcelJS from "exceljs";
async function run() {
  const url = process.env.TEST_DATABASE_URL!;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Dedicated *_test database required");
  await mkdir("test-results", { recursive: true });
  await migrate(url);
  const db = new Database(url),
    password = randomBytes(16).toString("hex");
  await db.pool.query("TRUNCATE warehouses,users,products,vendors CASCADE");
  const warehouse = (
    await db.pool.query(
      "INSERT INTO warehouses(code,name) VALUES('E2E','Kho kiểm thử') RETURNING id",
    )
  ).rows[0].id;
  await db.pool.query(
    "INSERT INTO locations(warehouse_id,code,name) VALUES($1,'A1','Kệ A1')",
    [warehouse],
  );
  await db.pool.query(
    "INSERT INTO users(username,display_name,password_hash,role) VALUES('e2e','Thủ kho kiểm thử',$1,'ADMIN')",
    [passwordHash(password)],
  );
  const apiLog = await open("test-results/api-smoke.log", "w"),
    webLog = await open("test-results/web-smoke.log", "w");
  const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: "3002",
      WEB_ORIGIN: "http://localhost:5174",
      REDIS_URL: "",
    },
    stdio: ["ignore", apiLog.fd, apiLog.fd],
    windowsHide: true,
  });
  const web = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "apps/web",
      "--config",
      "apps/web/vite.config.ts",
      "--port",
      "5174",
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_API_PROXY: "http://127.0.0.1:3002" },
      stdio: ["ignore", webLog.fd, webLog.fd],
      windowsHide: true,
    },
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    baseURL: "http://localhost:5174",
    viewport: { width: 1480, height: 1040 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function ready(url: string) {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(url)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Not ready: ${url}`);
  }
  try {
    await ready("http://127.0.0.1:3002/api/v1/health");
    await ready("http://localhost:5174/");
    await page.goto("http://localhost:5174/");
    await page.getByLabel("Tên đăng nhập", { exact: true }).fill("e2e");
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.getByRole("button", { name: /Đăng nhập/ }).click();
    await expect(
      page.getByRole("heading", { name: "Tổng quan", exact: true }),
    ).toBeVisible();
    console.log("PASS login and dashboard");
    await page.getByRole("menuitem", { name: /Danh mục/ }).click();
    await page.getByRole("tab", { name: "Nhà cung cấp", exact: true }).click();
    await page.getByRole("button", { name: /Thêm nhà cung cấp/ }).click();
    await page.getByLabel("Mã", { exact: true }).fill("VENDOR-E2E");
    await page.getByLabel("Tên", { exact: true }).fill("Nhà cung cấp kiểm thử");
    await page.locator(".ant-modal-footer .ant-btn-primary").click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("tab", { name: "Sản phẩm", exact: true }).click();
    await page.getByRole("button", { name: /Thêm sản phẩm/ }).click();
    await page.getByLabel("Part No", { exact: true }).fill("PART-E2E");
    await page
      .getByLabel("Tên / quy cách", { exact: true })
      .fill("Linh kiện kiểm thử");
    await page
      .getByLabel("Mã NCC mặc định", { exact: true })
      .fill("VENDOR-E2E");
    await page.locator(".ant-modal-footer .ant-btn-primary").click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    console.log("PASS catalog create vendor/product");
    await page.getByRole("menuitem", { name: /Nhập từ Excel/ }).click();
    await page.getByText("Danh mục sản phẩm", { exact: true }).click();
    await page.getByText("Tồn đầu kỳ", { exact: true }).click();
    await page.locator("input[type=file]").setInputFiles({
      name: "ton-dau-ky.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "part_no,location_code,lot_no,mes_pack_no,vendor_code,quantity,expired_date,status\nPART-E2E,A1,LOT-E2E,000001,VENDOR-E2E,100,2099-12-31,AVAILABLE",
      ),
    });
    await expect(page.locator(".job-title")).toContainText("ton-dau-ky.csv");
    await page.getByRole("button", { name: /Kiểm tra dữ liệu/ }).click();
    await expect(page.locator(".import-summary")).toBeVisible();
    await page.getByLabel("Đã đối soát các cảnh báo").check();
    await page.getByRole("button", { name: /Xác nhận nhập dữ liệu/ }).click();
    await page.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
    await expect(
      page.getByText("Đã nhập 1 dòng", { exact: true }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: /Tồn kho/ }).click();
    await expect(page.getByText("000001", { exact: true })).toBeVisible();
    console.log(
      "PASS CSV upload, mapping, preview, opening balance, stock view",
    );
    await page.getByRole("menuitem", { name: /Xuất kho FEFO/ }).click();
    await page.getByRole("button", { name: /Tạo phiếu xuất/ }).click();
    await page
      .getByLabel("Mã phiếu / tham chiếu", { exact: true })
      .fill("OUT-E2E");
    await page.locator(".ant-modal .ant-select").click();
    await page.getByText("PART-E2E · PCS", { exact: true }).click();
    await page.locator(".ant-modal input[role=spinbutton]").fill("30");
    await page.locator(".ant-modal-footer .ant-btn-primary").click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("button", { name: /Giữ hàng FEFO/ }).click();
    await expect(page.getByText("Đã giữ hàng", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Xác nhận xuất/ }).click();
    await page.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
    await expect(page.getByText("Đã xuất", { exact: true })).toBeVisible();
    console.log("PASS FEFO reserve and ship through UI");
    await page.getByRole("menuitem", { name: /Quét nhập kho/ }).click();
    await page.getByRole("button", { name: /Tạo phiếu nhập/ }).click();
    await page
      .getByPlaceholder("Quét mã 1D hoặc QR đầy đủ…")
      .fill("PART-E2E|VENDOR-E2E|E1|LOT-NEW|00010");
    await page.getByRole("button", { name: /Nhận mã/ }).click();
    await expect(
      page.getByText("Chờ quét pack", { exact: true }),
    ).toBeVisible();
    await page
      .getByPlaceholder("Quét mã pack / QR bổ sung vào dòng đang chọn…")
      .fill("PACK-NEW");
    await page.getByRole("button", { name: /Nhận mã/ }).click();
    await expect(page.getByText("PACK-NEW", { exact: true })).toBeVisible();
    await page.locator("input[type=date]").fill("2099-12-31");
    await expect(page.getByText("Đủ dữ liệu", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Xác nhận nhập kho/ }).click();
    await page.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
    await expect(page.getByText("Đã ghi sổ", { exact: true })).toBeVisible();
    console.log("PASS 1D + pack + manual expiry + confirmed receipt");
    const rich = await page.request.get(
      `/api/v1/reports/aging/export?warehouseId=${warehouse}&mode=presentation`,
    );
    expect(rich.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await rich.body()) as any);
    expect(workbook.worksheets[0].getCell("E6").value).toBe("000001");
    expect(workbook.worksheets[0].views[0].state).toBe("frozen");
    const detail = await page.request.get(
      `/api/v1/reports/movements/export?warehouseId=${warehouse}&mode=detail`,
    );
    expect(detail.status()).toBe(200);
    const streamed = new ExcelJS.Workbook();
    await streamed.xlsx.load((await detail.body()) as any);
    expect(streamed.worksheets[0].rowCount).toBeGreaterThan(8);
    console.log(
      "PASS rich/stream XLSX opens, text identifiers and frozen panes",
    );
    await page.getByRole("menuitem", { name: /Tổng quan/ }).click();
    await expect(page.getByText("80", { exact: true })).toHaveCount(2);
    await page.screenshot({
      path: "test-results/wms-dashboard.png",
      fullPage: true,
    });
    const sum = Number(
      (await db.pool.query("SELECT sum(quantity_delta) q FROM stock_movements"))
        .rows[0].q,
    );
    expect(sum).toBe(80);
    expect(errors).toEqual([]);
    console.log("PASS ledger reconciles to 80, no browser runtime errors");
    const me = await (await page.request.get("/api/v1/auth/me")).json();
    const denied = await page.request.post("/api/v1/inbound/drafts", {
      data: {
        warehouseId: warehouse,
        locationId: (await db.pool.query("SELECT id FROM locations LIMIT 1"))
          .rows[0].id,
      },
    });
    expect(denied.status()).toBe(403);
    for (const [username, role, granted] of [
      ["e2e-view", "VIEWER", [warehouse]],
      ["e2e-limited", "OPERATOR", []],
    ] as const) {
      const created = await page.request.post("/api/v1/users", {
        headers: { "x-csrf-token": me.csrfToken },
        data: {
          username,
          displayName: username,
          password,
          role,
          warehouses: granted,
        },
      });
      expect(created.status()).toBe(201);
      const context = await browser.newContext({
        baseURL: "http://localhost:5174",
      });
      const login = await context.request.post("/api/v1/auth/login", {
        data: { username, password },
      });
      expect(login.status()).toBe(201);
      const auth = await login.json();
      const read = await context.request.get(
        `/api/v1/inventory/packs?warehouseId=${warehouse}`,
      );
      expect(read.status()).toBe(role === "VIEWER" ? 200 : 403);
      const write = await context.request.post("/api/v1/inbound/drafts", {
        headers: { "x-csrf-token": auth.csrfToken },
        data: {
          warehouseId: warehouse,
          locationId: (await db.pool.query("SELECT id FROM locations LIMIT 1"))
            .rows[0].id,
        },
      });
      expect(write.status()).toBe(403);
      const logout = await context.request.post("/api/v1/auth/logout", {
        headers: { "x-csrf-token": auth.csrfToken },
        data: {},
      });
      expect(logout.status()).toBe(201);
      await context.close();
    }
    console.log(
      "PASS CSRF, viewer read-only/logout and cross-warehouse access controls",
    );
  } catch (e) {
    await page.screenshot({
      path: "test-results/smoke-failure.png",
      fullPage: true,
    });
    throw e;
  } finally {
    await browser.close();
    api.kill();
    web.kill();
    await apiLog.close();
    await webLog.close();
    await db.pool.end();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
