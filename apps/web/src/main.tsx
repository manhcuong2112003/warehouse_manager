import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App as AntApp, theme } from "antd";
import viVN from "antd/locale/vi_VN";
import enUS from "antd/locale/en_US";
import koKR from "antd/locale/ko_KR";
import { WmsApp } from "./shell";
import { I18nContext, Lang, translations, TranslationKey } from "./i18n";
const MobileScanner = React.lazy(() =>
  import("./pages/mobile").then((m) => ({ default: m.MobileScanner })),
);
import "./style.css";

function Root() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    return localStorage.getItem("wms_dark") === "true";
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("wms_font_size");
    return saved ? Number(saved) : 14;
  });
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("wms_lang");
    return saved === "en" || saved === "ko" ? saved : "vi";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-font-size", String(fontSize));
    document.documentElement.style.fontSize = fontSize + "px";
  }, [fontSize]);

  useEffect(() => {
    const themeHandler = (e: any) => {
      if (e?.detail?.isDark !== undefined) {
        setIsDark(e.detail.isDark);
      }
    };
    const fontHandler = (e: any) => {
      if (e?.detail?.fontSize !== undefined) {
        setFontSize(e.detail.fontSize);
      }
    };
    const langHandler = (e: any) => {
      if (e?.detail?.lang) {
        setLang(e.detail.lang);
      }
    };
    window.addEventListener("wms-theme-change", themeHandler);
    window.addEventListener("wms-font-size-change", fontHandler);
    window.addEventListener("wms-lang-change", langHandler);

    // Expose global helpers for WebView2 / desktop app
    (window as any).__toggleTheme = (dark: boolean) => {
      localStorage.setItem("wms_dark", String(dark));
      setIsDark(dark);
    };

    (window as any).__setFontSize = (size: number) => {
      localStorage.setItem("wms_font_size", String(size));
      setFontSize(size);
      document.documentElement.setAttribute("data-font-size", String(size));
      document.documentElement.style.fontSize = size + "px";
    };

    (window as any).__setLang = (newLang: Lang) => {
      localStorage.setItem("wms_lang", newLang);
      setLang(newLang);
      window.dispatchEvent(
        new CustomEvent("wms-lang-change", { detail: { lang: newLang } }),
      );
    };

    return () => {
      window.removeEventListener("wms-theme-change", themeHandler);
      window.removeEventListener("wms-font-size-change", fontHandler);
      window.removeEventListener("wms-lang-change", langHandler);
    };
  }, []);

  const updateLang = (newLang: Lang) => {
    localStorage.setItem("wms_lang", newLang);
    setLang(newLang);
    window.dispatchEvent(
      new CustomEvent("wms-lang-change", { detail: { lang: newLang } }),
    );
  };

  const t = (k: TranslationKey) =>
    translations[lang]?.[k] || translations.vi[k] || (k as string);

  const antdLocale = lang === "en" ? enUS : lang === "ko" ? koKR : viVN;

  return (
    <I18nContext.Provider value={{ lang, setLang: updateLang, t }}>
      <ConfigProvider
        locale={antdLocale}
        theme={{
          algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {
            colorPrimary: "#176b80",
            borderRadius: 8,
            fontFamily: "Inter, Segoe UI, sans-serif",
            fontSize: fontSize,
            colorBgLayout: isDark ? "#141414" : "#f3f6f9",
          },
          components: {
            Table: {
              headerBg: isDark ? "#1f1f1f" : "#edf3f7",
              headerColor: isDark ? "#e6e6e6" : "#324b60",
            },
            Button: { controlHeight: fontSize >= 16 ? 42 : 38 },
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
    </I18nContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
