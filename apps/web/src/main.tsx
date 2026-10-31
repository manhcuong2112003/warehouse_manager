import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import viVN from "antd/locale/vi_VN";
import { WmsApp } from "./shell";
const MobileScanner = React.lazy(() =>
  import("./pages/mobile").then((m) => ({ default: m.MobileScanner })),
);
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={viVN}
      theme={{
        token: {
          colorPrimary: "#176b80",
          borderRadius: 8,
          fontFamily: "Inter, Segoe UI, sans-serif",
          colorBgLayout: "#f3f6f9",
        },
        components: {
          Table: { headerBg: "#edf3f7", headerColor: "#324b60" },
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
  </React.StrictMode>,
);
