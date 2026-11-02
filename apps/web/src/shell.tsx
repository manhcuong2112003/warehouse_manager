import { useEffect, useState } from "react";
import {
  Alert,
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
  Typography,
} from "antd";
import {
  resolveInitialHostIp,
  getDetectedHostIps,
  saveLanIp,
  buildMobileScanUrl,
} from "./lan-utils";
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
  MobileOutlined,
} from "@ant-design/icons";
import QRCode from "qrcode";
import { api, post, setCsrf } from "./api";
import { Dashboard, Inventory, Catalog, Outbound, OutboundMatrixPage } from "./pages/operations";
import { Inbound } from "./pages/inbound";
import { Imports } from "./pages/imports";
import { Reports } from "./pages/reports";
import { Users } from "./pages/users";
import { useI18n, Lang } from "./i18n";

export function WmsApp() {
  const { message } = App.useApp();
  const { lang, setLang, t } = useI18n();
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
    }),
    [mobileLookupOpen, setMobileLookupOpen] = useState(false),
    [lookupQrUrl, setLookupQrUrl] = useState<string>(""),
    [hostLanIp, setHostLanIp] = useState<string>(() => resolveInitialHostIp()),
    [detectedIps, setDetectedIps] = useState<string[]>(() => getDetectedHostIps()),
    [fullScanUrl, setFullScanUrl] = useState<string>("");

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.ips && Array.isArray(e.detail.ips)) {
        setDetectedIps(e.detail.ips);
        setHostLanIp((prev) => {
          if (!prev || !e.detail.ips.includes(prev)) {
            return e.detail.ips[0] || "";
          }
          return prev;
        });
      }
    };
    window.addEventListener("wms-host-ips", handler);
    return () => window.removeEventListener("wms-host-ips", handler);
  }, []);

  const generateLookupQr = async (ipToUse: string) => {
    try {
      const fullUrl = buildMobileScanUrl("/mobile-scan", "mode=lookup", ipToUse);
      setFullScanUrl(fullUrl);
      setLookupQrUrl(await QRCode.toDataURL(fullUrl, { width: 300, margin: 1 }));
    } catch {}
  };

  const openMobileLookup = async () => {
    const fresh = getDetectedHostIps();
    if (fresh.length > 0) {
      setDetectedIps(fresh);
    }
    const ip = resolveInitialHostIp() || (fresh[0] ?? hostLanIp);
    setHostLanIp(ip);
    await generateLookupQr(ip);
    setMobileLookupOpen(true);
  };

  const handleIpChange = async (newIp: string) => {
    const trimmed = newIp.trim();
    setHostLanIp(trimmed);
    saveLanIp(trimmed);
    await generateLookupQr(trimmed);
  };

  const entries = [
    { key: "dashboard", label: t("menu_dashboard"), icon: <DashboardOutlined /> },
    { key: "matrix", label: t("menu_matrix"), icon: <TableOutlined /> },
    { key: "inventory", label: t("menu_inventory"), icon: <InboxOutlined /> },
    { key: "inbound", label: t("menu_inbound"), icon: <ScanOutlined /> },
    { key: "outbound", label: t("menu_outbound"), icon: <ExportOutlined /> },
    { key: "imports", label: t("menu_imports"), icon: <ImportOutlined /> },
    { key: "reports", label: t("menu_reports"), icon: <FileExcelOutlined /> },
    { key: "catalog", label: t("menu_catalog"), icon: <AppstoreOutlined /> },
  ];
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
          { key: "users", label: t("menu_users"), icon: <AppstoreOutlined /> },
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
        <div className="menu-caption">{t("workspace_caption")}</div>
        <div className="sidebar-menu-scroll">
          <Menu
            theme="dark"
            mode="inline"
            items={menu}
            selectedKeys={[page]}
            onClick={({ key }) => setPage(key)}
          />
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-actions">
            <Button
              className="sidebar-action-btn"
              icon={<SettingOutlined />}
              title={t("settings_title")}
              onClick={() => setSettingsOpen(true)}
              block
            >
              {t("settings_btn")}
            </Button>
            <Button
              className="sidebar-action-btn sidebar-logout-btn"
              icon={<LogoutOutlined />}
              danger
              onClick={async () => {
                await post("/auth/logout");
                setUser(undefined);
                setCsrf("");
              }}
              block
            >
              {t("logout_btn")}
            </Button>
          </div>
          <div className="sidebar-note">
            <div className="live-dot" /> {t("server_connected")}
            <br />
            <small>{t("server_subtitle")}</small>
          </div>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="topbar">
          <div className="breadcrumb">
            {t("header_space")} <span>/</span> <b>{title}</b>
          </div>
          <Space size="middle">
            <Select
              aria-label={t("warehouse_label")}
              value={warehouse || undefined}
              onChange={setWarehouse}
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
              style={{ minWidth: 190 }}
            />
            <Select
              value={lang}
              onChange={(val) => setLang(val as Lang)}
              options={[
                { value: "vi", label: "🇻🇳 VI" },
                { value: "en", label: "🇬🇧 EN" },
                { value: "ko", label: "🇰🇷 KO" },
              ]}
              style={{ minWidth: 95 }}
              title="Ngôn ngữ / Language / 언어"
            />
            <Tag>
              {user.role === "ADMIN"
                ? t("role_admin")
                : user.role === "VIEWER"
                  ? t("role_viewer")
                  : t("role_clerk")}
            </Tag>
            <span className="user-name">{user.display_name}</span>
            <Button
              icon={<MobileOutlined />}
              onClick={openMobileLookup}
              title="Quét mã tra cứu hàng hóa trên điện thoại"
            >
              📱 Tra Cứu ĐT
            </Button>
            <Button
              icon={isDarkTheme ? <SunOutlined /> : <MoonOutlined />}
              title={t("theme_btn")}
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
          </Space>
        </Layout.Header>
        <Layout.Content className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">{t("header_op")}</span>
              <h1>{title}</h1>
            </div>
            <span className="today">
              {new Intl.DateTimeFormat(
                lang === "en" ? "en-US" : lang === "ko" ? "ko-KR" : "vi-VN",
                {
                  dateStyle: "full",
                  timeZone: "Asia/Ho_Chi_Minh",
                },
              ).format(new Date())}
            </span>
          </div>
          {warehouse ? (
            <div key={warehouse}>
              <div style={{ display: page === "dashboard" ? "block" : "none" }}>
                <Dashboard {...props} />
              </div>
              <div style={{ display: page === "matrix" ? "block" : "none" }}>
                <OutboundMatrixPage {...props} />
              </div>
              <div style={{ display: page === "inventory" ? "block" : "none" }}>
                <Inventory {...props} />
              </div>
              <div style={{ display: page === "inbound" ? "block" : "none" }}>
                <Inbound {...props} />
              </div>
              <div style={{ display: page === "outbound" ? "block" : "none" }}>
                <Outbound {...props} />
              </div>
              <div style={{ display: page === "imports" ? "block" : "none" }}>
                <Imports {...props} />
              </div>
              <div style={{ display: page === "reports" ? "block" : "none" }}>
                <Reports {...props} />
              </div>
              {user.role === "ADMIN" && (
                <div style={{ display: page === "users" ? "block" : "none" }}>
                  <Users />
                </div>
              )}
              <div style={{ display: page === "catalog" ? "block" : "none" }}>
                <Catalog {...props} />
              </div>
            </div>
          ) : (
            <p>Chưa được cấp quyền vào kho. Liên hệ quản trị.</p>
          )}
        </Layout.Content>
        <Layout.Footer className="footer">
          {t("footer_text")}
        </Layout.Footer>
      </Layout>

      <Modal
        title={t("settings_title")}
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={[
          <Button
            key="close"
            type="primary"
            onClick={() => setSettingsOpen(false)}
          >
            {t("done_btn")}
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {t("settings_lang_title")}
          </div>
          <Segmented
            value={lang}
            onChange={(val) => setLang(val as Lang)}
            options={[
              { label: t("lang_vi"), value: "vi" },
              { label: t("lang_en"), value: "en" },
              { label: t("lang_ko"), value: "ko" },
            ]}
            block
          />
        </div>

        <div style={{ marginBottom: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {t("settings_font_title")}
          </div>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 10 }}>
            {t("settings_font_desc")}
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
              { label: t("font_small"), value: 13 },
              { label: t("font_normal"), value: 14 },
              { label: t("font_large"), value: 16 },
              { label: t("font_xlarge"), value: 18 },
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
            {t("preview_sample")}
          </div>
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
              {t("desktop_settings_btn")}
            </Button>
          </div>
        )}
      </Modal>

      <Modal
        open={mobileLookupOpen}
        onCancel={() => setMobileLookupOpen(false)}
        footer={null}
        title="📱 Quét Mã Để Mở Máy Quét Tra Cứu Trên Điện Thoại"
        centered
        width={480}
      >
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          {/* Cấu hình IP máy tính trong mạng Wifi */}
          <div
            style={{
              textAlign: "left",
              background: isDarkTheme ? "#1f1f1f" : "#f1f5f9",
              padding: "10px 14px",
              borderRadius: 8,
              border: isDarkTheme ? "1px solid #333" : "1px solid #cbd5e1",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <b style={{ fontSize: 13 }}>🌐 Địa chỉ IP máy tính (trong mạng Wifi):</b>
              {detectedIps.length > 0 && (
                <Tag color="cyan">Tự động nhận diện</Tag>
              )}
            </div>
            <Input
              value={hostLanIp}
              onChange={(e) => handleIpChange(e.target.value)}
              placeholder="Nhập IP máy tính (vd: 10.2.80.86 hoặc 192.168.1.10)"
              style={{ fontWeight: 600 }}
              allowClear
            />
            {detectedIps.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <small style={{ color: "#64748b" }}>IP tìm thấy:</small>
                {detectedIps.map((ip) => (
                  <Tag
                    key={ip}
                    color={hostLanIp === ip ? "blue" : "default"}
                    style={{ cursor: "pointer" }}
                    onClick={() => handleIpChange(ip)}
                  >
                    {ip}
                  </Tag>
                ))}
              </div>
            )}
            <small style={{ display: "block", color: "#64748b", marginTop: 6, lineHeight: 1.4 }}>
              💡 Điện thoại và máy tính cần kết nối chung một mạng Wifi (hoặc điện thoại bật Điểm phát sóng/Hotspot cho máy tính).
            </small>
          </div>

          {/* Ảnh mã QR */}
          {lookupQrUrl && (
            <img
              src={lookupQrUrl}
              alt="QR Code"
              style={{
                width: 230,
                height: 230,
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
              }}
            />
          )}

          {/* Đường dẫn trực tiếp có nút sao chép */}
          {fullScanUrl && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text copyable={{ text: fullScanUrl }} style={{ fontSize: 13, color: "#0284c7", fontWeight: 600 }}>
                {fullScanUrl}
              </Typography.Text>
            </div>
          )}

          {/* Hướng dẫn vượt cảnh báo SSL lần đầu */}
          <Alert
            style={{ marginTop: 14, textAlign: "left" }}
            type="info"
            showIcon
            message="Lưu ý khi điện thoại mở lần đầu:"
            description={
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                Nếu điện thoại báo <b>"Kết nối không phải là riêng tư"</b>, hãy bấm <b>"Nâng cao" (Advanced)</b> ➔ chọn <b>"Tiếp tục truy cập (không an toàn)"</b> để vào máy quét.
              </div>
            }
          />
        </div>
      </Modal>
    </Layout>
  );
}
