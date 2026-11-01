import { useEffect, useState } from "react";
import {
  App,
  Button,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import {
  DashboardOutlined,
  InboxOutlined,
  ScanOutlined,
  ImportOutlined,
  FileExcelOutlined,
  AppstoreOutlined,
  LogoutOutlined,
  ExportOutlined,
  SunOutlined,
  MoonOutlined,
  TableOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { api, post, setCsrf } from "./api";
import { Dashboard, Inventory, Catalog, Outbound, OutboundMatrixPage } from "./pages/operations";
import { Inbound } from "./pages/inbound";
import { Imports } from "./pages/imports";
import { Reports } from "./pages/reports";
import { Users } from "./pages/users";
const entries = [
  { key: "dashboard", label: "Tổng quan", icon: <DashboardOutlined /> },
  { key: "matrix", label: "Xuất kho theo ngày", icon: <TableOutlined /> },
  { key: "inventory", label: "Tồn kho", icon: <InboxOutlined /> },
  { key: "inbound", label: "Quét nhập kho", icon: <ScanOutlined /> },
  { key: "outbound", label: "Xuất kho FEFO", icon: <ExportOutlined /> },
  { key: "imports", label: "Nhập từ Excel", icon: <ImportOutlined /> },
  { key: "reports", label: "Báo cáo & Excel", icon: <FileExcelOutlined /> },
  { key: "catalog", label: "Danh mục", icon: <AppstoreOutlined /> },
];
export function WmsApp() {
  const { message } = App.useApp();
  const [user, setUser] = useState<any>(),
    [loading, setLoading] = useState(true),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [warehouse, setWarehouse] = useState(""),
    [page, setPage] = useState("dashboard"),
    [busy, setBusy] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [currentFontSize, setCurrentFontSize] = useState<number>(() => {
      const saved = localStorage.getItem("wms_font_size");
      return saved ? Number(saved) : 14;
    }),
    [isDarkTheme, setIsDarkTheme] = useState<boolean>(() => {
      return localStorage.getItem("wms_dark") === "true";
    });
  const load = async () => {
    const r = await api("/auth/me");
    setCsrf(r.csrfToken);
    setUser(r.user);
    const w = await api("/warehouses");
    setWarehouses(w);
    setWarehouse((old) => old || w[0]?.id || "");
  };
  useEffect(() => {
    load()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div className="loading">
        <Spin size="large" />
      </div>
    );
  if (!user)
    return (
      <div className="login">
        <div className="login-story">
          <div className="brand-mark">W</div>
          <span className="eyebrow">WAREHOUSE OPERATIONS</span>
          <h1>
            Mỗi kiện hàng.
            <br />
            Một hành trình rõ ràng.
          </h1>
          <p>
            Quản lý tồn kho theo pack, truy vết từng lô và phối hợp các máy trạm
            trong cùng kho.
          </p>
          <div className="login-features">
            <span>01 / Quét và đối soát</span>
            <span>02 / Xuất hàng theo FEFO</span>
            <span>03 / Dữ liệu có thể truy vết</span>
          </div>
        </div>
        <div className="login-panel">
          <span className="eyebrow">KHO VẬT TƯ</span>
          <h2>Đăng nhập hệ thống</h2>
          <p>Sử dụng tài khoản được quản trị kho cấp.</p>
          <Form
            layout="vertical"
            onFinish={async (v) => {
              setBusy(true);
              try {
                const r = await post("/auth/login", v);
                setCsrf(r.csrfToken);
                await load();
              } catch (e: any) {
                message.error(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Form.Item
              name="username"
              label="Tên đăng nhập"
              rules={[{ required: true }]}
            >
              <Input autoComplete="username" size="large" />
            </Form.Item>
            <Form.Item
              name="password"
              label="Mật khẩu"
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" size="large" />
            </Form.Item>
            <Button
              type="primary"
              block
              size="large"
              htmlType="submit"
              loading={busy}
            >
              Đăng nhập
            </Button>
          </Form>
          <small>
            Tài khoản khởi tạo được cấu hình trong file .env của máy chủ.
          </small>
        </div>
      </div>
    );
  const props = { warehouse, user, navigate: setPage };
  const menu =
    user.role === "ADMIN"
      ? [
          ...entries,
          { key: "users", label: "Người dùng", icon: <AppstoreOutlined /> },
        ]
      : entries;
  const title = menu.find((e) => e.key === page)?.label;
  return (
    <Layout className="app-layout">
      <Layout.Sider
        width={240}
        breakpoint="lg"
        collapsedWidth={70}
        className="sidebar"
      >
        <div className="brand">
          <div className="brand-mark">W</div>
          <div>
            <b>Kho Vật Tư</b>
            <small>WAREHOUSE MANAGEMENT</small>
          </div>
        </div>
        <div className="menu-caption">KHÔNG GIAN LÀM VIỆC</div>
        <Menu
          theme="dark"
          mode="inline"
          items={menu}
          selectedKeys={[page]}
          onClick={({ key }) => setPage(key)}
        />
        <div className="sidebar-note">
          <div className="live-dot" /> Kết nối máy chủ kho
          <br />
          <small>Một nguồn dữ liệu · Nhiều máy trạm</small>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="topbar">
          <div className="breadcrumb">
            Không gian kho <span>/</span> <b>{title}</b>
          </div>
          <Space size="middle">
            <Select
              aria-label="Kho làm việc"
              value={warehouse || undefined}
              onChange={setWarehouse}
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
              style={{ minWidth: 190 }}
            />
            <Tag>
              {user.role === "ADMIN"
                ? "Quản trị"
                : user.role === "VIEWER"
                  ? "Chỉ xem"
                  : "Thủ kho"}
            </Tag>
            <span className="user-name">{user.display_name}</span>
            <Button
              icon={<SettingOutlined />}
              title="Cài đặt hệ thống & Cỡ chữ"
              onClick={() => setSettingsOpen(true)}
            >
              Cài đặt
            </Button>
            <Button
              icon={isDarkTheme ? <SunOutlined /> : <MoonOutlined />}
              title="Đổi giao diện Sáng / Tối"
              onClick={() => {
                const next = !isDarkTheme;
                setIsDarkTheme(next);
                if ((window as any).__toggleTheme) {
                  (window as any).__toggleTheme(next);
                } else {
                  localStorage.setItem("wms_dark", String(next));
                  window.dispatchEvent(new CustomEvent("wms-theme-change", { detail: { isDark: next } }));
                }
              }}
            />
            <Button
              icon={<LogoutOutlined />}
              danger
              onClick={async () => {
                await post("/auth/logout");
                setUser(undefined);
                setCsrf("");
              }}
            >
              Đăng xuất
            </Button>
          </Space>
        </Layout.Header>
        <Layout.Content className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">VẬN HÀNH KHO</span>
              <h1>{title}</h1>
            </div>
            <span className="today">
              {new Intl.DateTimeFormat("vi-VN", {
                dateStyle: "full",
                timeZone: "Asia/Ho_Chi_Minh",
              }).format(new Date())}
            </span>
          </div>
          {warehouse ? (
            <div key={`${page}:${warehouse}`}>
              {page === "dashboard" ? (
                <Dashboard {...props} />
              ) : page === "matrix" ? (
                <OutboundMatrixPage {...props} />
              ) : page === "inventory" ? (
                <Inventory {...props} />
              ) : page === "inbound" ? (
                <Inbound {...props} />
              ) : page === "outbound" ? (
                <Outbound {...props} />
              ) : page === "imports" ? (
                <Imports {...props} />
              ) : page === "reports" ? (
                <Reports {...props} />
              ) : page === "users" ? (
                <Users />
              ) : (
                <Catalog {...props} />
              )}
            </div>
          ) : (
            <p>Chưa được cấp quyền vào kho. Liên hệ quản trị.</p>
          )}
        </Layout.Content>
        <Layout.Footer className="footer">
          Kho Vật Tư · Tồn theo pack · Asia/Ho_Chi_Minh
        </Layout.Footer>
      </Layout>

      <Modal
        title="⚙️ Cài Đặt Hệ Thống & Hiển Thị"
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={[
          <Button
            key="close"
            type="primary"
            onClick={() => setSettingsOpen(false)}
          >
            Hoàn tất
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            🔤 Cỡ chữ hiển thị
          </div>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 10 }}>
            Tùy chỉnh độ lớn chữ trên bảng biểu và giao diện giúp dễ quan sát số liệu kho.
          </p>
          <Segmented
            value={currentFontSize}
            onChange={(val) => {
              const size = Number(val);
              setCurrentFontSize(size);
              if ((window as any).__setFontSize) {
                (window as any).__setFontSize(size);
              } else {
                localStorage.setItem("wms_font_size", String(size));
                window.dispatchEvent(
                  new CustomEvent("wms-font-size-change", {
                    detail: { fontSize: size },
                  }),
                );
              }
            }}
            options={[
              { label: "Nhỏ (13px)", value: 13 },
              { label: "Vừa (14px - Chuẩn)", value: 14 },
              { label: "Lớn (16px)", value: 16 },
              { label: "Rất lớn (18px)", value: 18 },
            ]}
            block
          />
          <div
            style={{
              marginTop: 12,
              padding: "10px 14px",
              background: isDarkTheme ? "#1f1f1f" : "#f1f5f9",
              borderRadius: 6,
              fontSize: currentFontSize,
              fontWeight: 500,
              border: isDarkTheme ? "1px solid #333" : "1px solid #e2e8f0",
            }}
          >
            👀 Xem trước: Mã GH64-10383A · Tồn 24.000 PCS · Lô LOT-202610
          </div>
        </div>

        <div style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            🌓 Giao diện làm việc
          </div>
          <Segmented
            value={isDarkTheme ? "dark" : "light"}
            onChange={(v) => {
              const dark = v === "dark";
              setIsDarkTheme(dark);
              if ((window as any).__toggleTheme) {
                (window as any).__toggleTheme(dark);
              } else {
                localStorage.setItem("wms_dark", String(dark));
                window.dispatchEvent(
                  new CustomEvent("wms-theme-change", {
                    detail: { isDark: dark },
                  }),
                );
              }
            }}
            options={[
              { label: "☀️ Giao diện Sáng (Light)", value: "light" },
              { label: "🌙 Giao diện Tối (Dark Mode)", value: "dark" },
            ]}
            block
          />
        </div>

        {(window as any).chrome?.webview && (
          <div
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: isDarkTheme ? "1px dashed #333" : "1px dashed #cbd5e1",
            }}
          >
            <Button
              block
              onClick={() => {
                (window as any).chrome?.webview?.postMessage("open_settings");
                setSettingsOpen(false);
              }}
            >
              ⚙️ Mở Cài Đặt Ứng Dụng Desktop Nâng Cao (F2)
            </Button>
          </div>
        )}
      </Modal>
    </Layout>
  );
}
