import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App as AntApp, theme } from "antd";
import viVN from "antd/locale/vi_VN";
import { WmsApp } from "./shell";
const MobileScanner = React.lazy(() =>
  import("./pages/mobile").then((m) => ({ default: m.MobileScanner })),
);
import "./style.css";

function Root() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    return localStorage.getItem("wms_dark") === "true";
  });

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail?.isDark !== undefined) {
        setIsDark(e.detail.isDark);
      }
    };
    window.addEventListener("wms-theme-change", handler);
    // Expose global helper for WebView2
    (window as any).__toggleTheme = (dark: boolean) => {
      localStorage.setItem("wms_dark", String(dark));
      setIsDark(dark);
    };
    return () => window.removeEventListener("wms-theme-change", handler);
  }, []);

  return (
    <ConfigProvider
      locale={viVN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#176b80",
          borderRadius: 8,
          fontFamily: "Inter, Segoe UI, sans-serif",
          colorBgLayout: isDark ? "#141414" : "#f3f6f9",
        },
        components: {
          Table: {
            headerBg: isDark ? "#1f1f1f" : "#edf3f7",
            headerColor: isDark ? "#e6e6e6" : "#324b60",
          },
          Button: { controlHeight: 38 },
        },
      }}
    >
      <AntApp>
        <React.Suspense fallback={<div className="loading">Đang tải…</div>}>
          {location.pathname === "/mobile-scan" ? (
            <MobileScanner />
          ) : (
            <WmsApp />
          )}
        </React.Suspense>
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
