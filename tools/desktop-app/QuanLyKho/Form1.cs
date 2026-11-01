using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QuanLyKho;

public partial class Form1 : Form
{
    private WebView2 webView = null!;
    private Panel topBar = null!;
    private Label lblCountdown = null!;
    private Button btnActivate = null!;
    private Button btnSettings = null!;
    private Button btnDismiss = null!;
    private Button btnFloatingSettings = null!;
    private System.Windows.Forms.Timer countdownTimer = null!;

    // Cấu hình thời hạn dùng thử: Hết hạn lúc 23:59:59 ngày 03/11/2026
    private static readonly DateTime ExpiryDate = new DateTime(2026, 11, 3, 23, 59, 59);

    private static readonly string[] ValidMasterKeys = new string[]
    {
        "WMS-PRO-2026-OFFICIAL",
        "WMS-2026-VIP-LICENSE",
        "WMS-PAID-SUCCESS-2026"
    };

    private const string RegistryKeyPath = @"Software\QuanLyKhoWMS";
    private const string RegValueLicensed = "IsLicensed";
    private const string RegValueLastSeen = "LastSeenTime";
    private const string RegValueServerUrl = "ServerUrl";
    private const string RegValueStoragePath = "StoragePath";
    private const string RegValueDarkMode = "IsDarkMode";
    private const string RegValueTopBarVisible = "TopBarVisible";
    private const string RegValueFontSize = "FontSize";
    private const string RegValueLang = "Language";

    public const string DefaultLocalUrl = "https://localhost";
    public const string DefaultTunnelUrl = "https://biological-candy-instruments-installations.trycloudflare.com";

    private string currentServerUrl = DefaultLocalUrl;
    private string currentStoragePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "QuanLyKho_Data");
    private bool isDarkMode = false;
    private bool isTopBarVisible = true;
    private int currentFontSize = 14;
    private double currentZoomFactor = 1.0;
    private string currentLang = "vi";
    private int retryCount = 0;

    public Form1()
    {
        InitializeComponent();
        this.Text = "HỆ THỐNG QUẢN LÝ KHO (WMS) - LOCAL-FIRST EDITION";
        this.Size = new Size(1366, 850);
        this.MinimumSize = new Size(1024, 700);
        this.StartPosition = FormStartPosition.CenterScreen;
        this.KeyPreview = true;
        this.KeyDown += Form1_KeyDown;

        EnsureDesktopShortcut(false);

        LoadSavedSettings();
        BuildUI();
        StartLicenseAndCountdown();
    }

    private void Form1_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.F2)
        {
            ShowUnifiedSettingsDialog();
            e.Handled = true;
        }
    }

    private void LoadSavedSettings()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath);
            if (key != null)
            {
                var savedUrl = key.GetValue(RegValueServerUrl) as string;
                if (!string.IsNullOrWhiteSpace(savedUrl))
                {
                    if (savedUrl.Contains(":3000") || savedUrl.Contains("trycloudflare.com")) currentServerUrl = DefaultLocalUrl;
                    else currentServerUrl = savedUrl;
                }

                var savedPath = key.GetValue(RegValueStoragePath) as string;
                if (!string.IsNullOrWhiteSpace(savedPath))
                {
                    currentStoragePath = savedPath;
                }

                var savedDark = key.GetValue(RegValueDarkMode) as string;
                isDarkMode = savedDark == "1" || savedDark == "TRUE";

                var savedBarVisible = key.GetValue(RegValueTopBarVisible) as string;
                if (savedBarVisible != null)
                {
                    isTopBarVisible = savedBarVisible == "1" || savedBarVisible == "TRUE";
                }

                var savedFontSize = key.GetValue(RegValueFontSize) as string;
                if (!string.IsNullOrWhiteSpace(savedFontSize) && int.TryParse(savedFontSize, out int fs))
                {
                    currentFontSize = (fs == 13 || fs == 14 || fs == 16 || fs == 18) ? fs : 14;
                    currentZoomFactor = currentFontSize == 13 ? 0.92 : currentFontSize == 16 ? 1.15 : currentFontSize == 18 ? 1.28 : 1.0;
                }

                var savedLang = key.GetValue(RegValueLang) as string;
                if (!string.IsNullOrWhiteSpace(savedLang))
                {
                    currentLang = (savedLang == "en" || savedLang == "ko") ? savedLang : "vi";
                }
            }
        }
        catch { }

        if (!Directory.Exists(currentStoragePath))
        {
            try { Directory.CreateDirectory(currentStoragePath); } catch { }
        }
    }

    private bool IsSystemLicensed()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath);
            if (key != null)
            {
                var val = key.GetValue(RegValueLicensed) as string;
                return val == "1" || val == "TRUE";
            }
        }
        catch { }
        return false;
    }

    private void SaveLicensedStatus(bool isLicensed)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
            key?.SetValue(RegValueLicensed, isLicensed ? "1" : "0", RegistryValueKind.String);
        }
        catch { }
    }

    private void SaveTopBarVisibility(bool visible)
    {
        isTopBarVisible = visible;
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
            key?.SetValue(RegValueTopBarVisible, visible ? "1" : "0", RegistryValueKind.String);
        }
        catch { }
    }

    private void SaveServerUrl(string url)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
            key?.SetValue(RegValueServerUrl, url, RegistryValueKind.String);
        }
        catch { }
    }

    private bool CheckClockRollback()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
            var lastStr = key?.GetValue(RegValueLastSeen) as string;
            DateTime now = DateTime.UtcNow;

            if (!string.IsNullOrEmpty(lastStr) && DateTime.TryParse(lastStr, out var lastSeen))
            {
                if (now < lastSeen.AddMinutes(-30))
                {
                    return false;
                }
            }

            key?.SetValue(RegValueLastSeen, now.ToString("o"));
        }
        catch { }
        return true;
    }

    private void BuildUI()
    {
        // 1. Top Bar
        topBar = new Panel
        {
            Dock = DockStyle.Top,
            Height = 38,
            BackColor = Color.FromArgb(245, 158, 11),
            Padding = new Padding(12, 4, 8, 4),
            Visible = isTopBarVisible
        };

        lblCountdown = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(69, 26, 3),
            Text = "Đang kiểm tra thời hạn bản quyền..."
        };

        btnDismiss = new Button
        {
            Dock = DockStyle.Right,
            Width = 32,
            Text = "✕",
            Font = new Font("Segoe UI", 11.0f, FontStyle.Bold),
            BackColor = Color.Transparent,
            ForeColor = Color.FromArgb(69, 26, 3),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            Margin = new Padding(4, 0, 0, 0)
        };
        btnDismiss.FlatAppearance.BorderSize = 0;
        btnDismiss.Click += (s, e) =>
        {
            topBar.Visible = false;
            SaveTopBarVisibility(false);
            btnFloatingSettings.Visible = true;
        };

        btnActivate = new Button
        {
            Dock = DockStyle.Right,
            Width = 150,
            Text = "🔑 Mã Bản Quyền",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Bold),
            BackColor = Color.White,
            ForeColor = Color.FromArgb(180, 83, 9),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnActivate.FlatAppearance.BorderSize = 0;
        btnActivate.Click += (s, e) => ShowActivationDialog();

        btnSettings = new Button
        {
            Dock = DockStyle.Right,
            Width = 120,
            Text = "⚙️ Cài Đặt (F2)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Bold),
            BackColor = Color.FromArgb(254, 243, 199),
            ForeColor = Color.FromArgb(146, 64, 14),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnSettings.FlatAppearance.BorderSize = 0;
        btnSettings.Click += (s, e) => ShowUnifiedSettingsDialog();

        topBar.Controls.Add(lblCountdown);
        topBar.Controls.Add(btnSettings);
        topBar.Controls.Add(new Label { Dock = DockStyle.Right, Width = 6 });
        topBar.Controls.Add(btnActivate);
        topBar.Controls.Add(new Label { Dock = DockStyle.Right, Width = 6 });
        topBar.Controls.Add(btnDismiss);

        // 2. Floating Settings Button (Hiển thị khi topBar bị ẩn)
        btnFloatingSettings = new Button
        {
            Size = new Size(110, 32),
            Text = "⚙️ Cài đặt (F2)",
            Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
            BackColor = Color.FromArgb(30, 41, 59),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            Visible = !isTopBarVisible,
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            Location = new Point(this.ClientSize.Width - 125, 8)
        };
        btnFloatingSettings.FlatAppearance.BorderSize = 0;
        btnFloatingSettings.Click += (s, e) => ShowUnifiedSettingsDialog();

        // 3. WebView2
        webView = new WebView2
        {
            Dock = DockStyle.Fill
        };

        this.Controls.Add(btnFloatingSettings);
        this.Controls.Add(webView);
        this.Controls.Add(topBar);

        topBar.BringToFront();
        btnFloatingSettings.BringToFront();

        this.Resize += (s, e) =>
        {
            btnFloatingSettings.Location = new Point(this.ClientSize.Width - 125, 8);
            btnFloatingSettings.BringToFront();
        };
    }

    private async void StartLicenseAndCountdown()
    {
        countdownTimer = new System.Windows.Forms.Timer
        {
            Interval = 1000
        };
        countdownTimer.Tick += (s, e) => UpdateCountdownDisplay();
        countdownTimer.Start();

        UpdateCountdownDisplay();
        await InitializeWebViewAsync();
    }

    private bool IsExpiredOrTampered()
    {
        if (IsSystemLicensed()) return false;
        if (!CheckClockRollback()) return true;
        if (DateTime.Now > ExpiryDate) return true;
        return false;
    }

    private void UpdateCountdownDisplay()
    {
        if (IsSystemLicensed())
        {
            topBar.BackColor = Color.FromArgb(22, 163, 74);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "✅ BẢN QUYỀN CHÍNH THỨC (VĨNH VIỄN) - HỆ THỐNG ĐÃ KÍCH HOẠT THÀNH CÔNG";
            btnActivate.Visible = false;
            btnSettings.BackColor = Color.FromArgb(220, 252, 231);
            btnSettings.ForeColor = Color.FromArgb(21, 128, 61);
            btnDismiss.ForeColor = Color.White;
            return;
        }

        btnActivate.Visible = true;
        btnDismiss.ForeColor = Color.FromArgb(69, 26, 3);

        if (!CheckClockRollback())
        {
            topBar.BackColor = Color.FromArgb(220, 38, 38);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "⚠️ CẢNH BÁO: Phát hiện ngày giờ hệ thống không hợp lệ!";
            ShowExpiredScreen();
            return;
        }

        var remaining = ExpiryDate - DateTime.Now;
        if (remaining <= TimeSpan.Zero)
        {
            topBar.BackColor = Color.FromArgb(220, 38, 38);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "⚠️ BẢN DÙNG THỬ ĐÃ HẾT HẠN! Vui lòng nhập mã kích hoạt để tiếp tục sử dụng.";
            ShowExpiredScreen();
        }
        else
        {
            topBar.BackColor = Color.FromArgb(245, 158, 11);
            lblCountdown.ForeColor = Color.FromArgb(69, 26, 3);
            string timeStr = $"{(int)remaining.TotalDays} ngày {remaining.Hours:D2} giờ {remaining.Minutes:D2} phút {remaining.Seconds:D2} giây";
            lblCountdown.Text = $"⏱️ DÙNG THỬ: Còn lại {timeStr} (Hạn: 23:59:59 03/11/2026)";
        }
    }

    private void ShowExpiredScreen()
    {
        if (webView.CoreWebView2 != null)
        {
            webView.CoreWebView2.NavigateToString(
                "<html><head><meta charset='utf-8'></head>" +
                "<body style='font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;text-align:center;padding:80px 20px;background:#f8fafc;color:#1e293b;'>" +
                "<div style='max-width:650px;margin:0 auto;background:#fff;padding:48px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.08);border:1px solid #e2e8f0;'>" +
                "<div style='font-size:48px;margin-bottom:16px;'>🔒</div>" +
                "<h1 style='color:#dc2626;font-size:26px;margin-bottom:16px;'>Bản Dùng Thử 3 Ngày Đã Hết Hạn</h1>" +
                "<p style='font-size:16px;line-height:1.6;color:#64748b;margin-bottom:24px;'>" +
                "Thời hạn trải nghiệm hệ thống Quản Lý Kho (WMS) đã kết thúc vào ngày <b>03/11/2026</b>.<br/>" +
                "Toàn bộ chức năng thao tác kho đã tạm thời khóa bảo vệ.</p>" +
                "<div style='background:#f1f5f9;border-left:4px solid #3b82f6;padding:16px;text-align:left;border-radius:8px;font-size:15px;color:#334155;margin-bottom:28px;'>" +
                "<b>Để mở khóa sử dụng vĩnh viễn:</b><br/>" +
                "1. Hoàn tất nghiệm thu & thanh toán với nhà phát triển.<br/>" +
                "2. Nhận <b>Mã kích hoạt bản quyền chính thức</b>.<br/>" +
                "3. Bấm vào nút <b>[⚙️ Cài Đặt (F2)]</b> hoặc <b>[🔑 Mã Bản Quyền]</b> để mở khóa ngay lập tức." +
                "</div>" +
                "</div>" +
                "</body></html>"
            );
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions("--ignore-certificate-errors --allow-insecure-localhost");
            var env = await CoreWebView2Environment.CreateAsync(null, null, options);
            await webView.EnsureCoreWebView2Async(env);

            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;

            webView.CoreWebView2.ServerCertificateErrorDetected += (s, e) =>
            {
                e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
            };

            webView.CoreWebView2.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Camera)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                }
            };

            // Tự động lưu file tải về (Excel, Báo cáo) vào thư mục lưu trữ đã chọn
            webView.CoreWebView2.DownloadStarting += (s, e) =>
            {
                if (!string.IsNullOrEmpty(currentStoragePath) && Directory.Exists(currentStoragePath))
                {
                    var fileName = Path.GetFileName(e.ResultFilePath);
                    e.ResultFilePath = Path.Combine(currentStoragePath, fileName);
                    e.Handled = true;
                }
            };

            webView.CoreWebView2.WebMessageReceived += (s, e) =>
            {
                try
                {
                    var msg = e.TryGetWebMessageAsString();
                    if (msg == "retry_local")
                    {
                        currentServerUrl = DefaultLocalUrl;
                        SaveServerUrl(DefaultLocalUrl);
                        webView.CoreWebView2.Navigate(currentServerUrl);
                    }
                    else if (msg == "open_settings")
                    {
                        ShowUnifiedSettingsDialog();
                    }
                }
                catch { }
            };

            webView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                ApplyThemeToWebView();
                ApplyFontSizeToWebView();
                ApplyLanguageToWebView();

                if (e.IsSuccess)
                {
                    retryCount = 0;
                    return;
                }

                if (!e.IsSuccess && !IsExpiredOrTampered())
                {
                    // 1. Nếu đang kết nối Online / Tunnel mà lỗi -> Tự động chuyển ngay về Localhost
                    if (currentServerUrl != DefaultLocalUrl)
                    {
                        currentServerUrl = DefaultLocalUrl;
                        SaveServerUrl(DefaultLocalUrl);
                        webView.CoreWebView2.Navigate(currentServerUrl);
                        return;
                    }

                    // 2. Nếu là Localhost mà lỗi (ví dụ docker vừa khởi động lại) -> thử lại 1 lần sau 1.5s
                    if (retryCount < 2)
                    {
                        retryCount++;
                        Task.Delay(1500).ContinueWith(_ =>
                        {
                            if (!this.IsDisposed && this.IsHandleCreated)
                            {
                                this.Invoke(() => webView.CoreWebView2?.Navigate(DefaultLocalUrl));
                            }
                        });
                        return;
                    }

                    retryCount = 0;
                    webView.CoreWebView2.NavigateToString(
                        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Lỗi Kết Nối</title></head>" +
                        "<body style='font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;text-align:center;padding:60px 20px;background:#f8fafc;color:#1e293b;margin:0;'>" +
                        "<div style='max-width:540px;margin:0 auto;background:#ffffff;padding:36px;border-radius:12px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.1),0 8px 10px -6px rgba(0,0,0,0.1);border:1px solid #e2e8f0;'>" +
                        "<div style='font-size:42px;margin-bottom:12px;'>⚠️</div>" +
                        "<h2 style='color:#ea580c;margin:0 0 12px;font-size:20px;font-weight:700;'>Chưa Kết Nối Được Đến Máy Chủ Kho</h2>" +
                        $"<p style='font-size:14px;color:#64748b;line-height:1.6;margin:0 0 20px;'>Địa chỉ máy chủ đang thử kết nối: <br><strong style='color:#0f172a;word-break:break-all;'>{currentServerUrl}</strong></p>" +
                        "<div style='display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:16px;'>" +
                        "<button onclick=\"window.chrome.webview.postMessage('retry_local')\" style='background:#0284c7;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13.5px;'>🔄 Kết Nối Máy Chủ Cục Bộ (Localhost)</button>" +
                        "<button onclick=\"window.chrome.webview.postMessage('open_settings')\" style='background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13.5px;'>⚙️ Cài Đặt (F2)</button>" +
                        "</div>" +
                        "<p style='font-size:12.5px;color:#94a3b8;margin:0;'>Mẹo: Bấm <b>F2</b> trên bàn phím bất kỳ lúc nào để mở bảng Cài đặt nhanh.</p>" +
                        "</div>" +
                        "</body></html>"
                    );
                }
            };

            if (IsExpiredOrTampered())
            {
                ShowExpiredScreen();
            }
            else
            {
                webView.CoreWebView2.Navigate(currentServerUrl);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Lỗi khởi tạo hệ thống: " + ex.Message, "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void ApplyThemeToWebView()
    {
        if (webView?.CoreWebView2 != null)
        {
            try
            {
                webView.CoreWebView2.Profile.PreferredColorScheme = isDarkMode
                    ? CoreWebView2PreferredColorScheme.Dark
                    : CoreWebView2PreferredColorScheme.Light;

                string script = $"if (window.__toggleTheme) {{ window.__toggleTheme({(isDarkMode ? "true" : "false")}); }} " +
                                $"localStorage.setItem('wms_dark', '{(isDarkMode ? "true" : "false")}'); " +
                                $"window.dispatchEvent(new CustomEvent('wms-theme-change', {{ detail: {{ isDark: {(isDarkMode ? "true" : "false")} }} }}));";
                webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }
    }

    private void ApplyFontSizeToWebView()
    {
        if (webView?.CoreWebView2 != null)
        {
            try
            {
                webView.ZoomFactor = currentZoomFactor;
                string script = $"if (window.__setFontSize) {{ window.__setFontSize({currentFontSize}); }} " +
                                $"localStorage.setItem('wms_font_size', '{currentFontSize}'); " +
                                $"document.documentElement.setAttribute('data-font-size', '{currentFontSize}'); " +
                                $"document.documentElement.style.fontSize = '{currentFontSize}px'; " +
                                $"window.dispatchEvent(new CustomEvent('wms-font-size-change', {{ detail: {{ fontSize: {currentFontSize} }} }}));";
                webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }
    }

    private async void ApplyLanguageToWebView()
    {
        if (webView?.CoreWebView2 != null)
        {
            try
            {
                string script = $"if (window.__setLang) {{ window.__setLang('{currentLang}'); }} " +
                                $"localStorage.setItem('wms_lang', '{currentLang}'); " +
                                $"window.dispatchEvent(new CustomEvent('wms-lang-change', {{ detail: {{ lang: '{currentLang}' }} }}));";
                await webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }
    }

    public void ShowUnifiedSettingsDialog()
    {
        using var form = new Form
        {
            Text = "Cài Đặt Hệ Thống WMS",
            Size = new Size(620, 720),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = Color.White
        };

        int y = 16;

        // --- 1. Thư mục lưu trữ & Tải file ---
        var grpStorage = new GroupBox
        {
            Text = "📁 1. Thư mục lưu trữ & Xuất file báo cáo",
            Location = new Point(20, y),
            Size = new Size(560, 85),
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
        };
        var txtStorage = new TextBox
        {
            Location = new Point(16, 32),
            Size = new Size(355, 25),
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Text = currentStoragePath
        };
        var btnBrowse = new Button
        {
            Location = new Point(380, 30),
            Size = new Size(80, 28),
            Text = "Chọn...",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            BackColor = Color.FromArgb(241, 245, 249),
            FlatStyle = FlatStyle.Flat
        };
        btnBrowse.Click += (s, e) =>
        {
            using var fbd = new FolderBrowserDialog();
            fbd.SelectedPath = currentStoragePath;
            if (fbd.ShowDialog() == DialogResult.OK)
            {
                txtStorage.Text = fbd.SelectedPath;
            }
        };
        var btnOpenFolder = new Button
        {
            Location = new Point(468, 30),
            Size = new Size(76, 28),
            Text = "Mở",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            BackColor = Color.FromArgb(241, 245, 249),
            FlatStyle = FlatStyle.Flat
        };
        btnOpenFolder.Click += (s, e) =>
        {
            if (Directory.Exists(txtStorage.Text))
            {
                Process.Start("explorer.exe", txtStorage.Text);
            }
        };
        grpStorage.Controls.Add(txtStorage);
        grpStorage.Controls.Add(btnBrowse);
        grpStorage.Controls.Add(btnOpenFolder);
        form.Controls.Add(grpStorage);

        y += 98;

        // --- 2. Giao diện Sáng / Tối ---
        var grpTheme = new GroupBox
        {
            Text = "🌓 2. Giao diện (Theme)",
            Location = new Point(20, y),
            Size = new Size(560, 70),
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
        };
        var rbLight = new RadioButton
        {
            Location = new Point(20, 28),
            Size = new Size(220, 24),
            Text = "☀️ Giao diện Sáng (Light)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = !isDarkMode
        };
        var rbDark = new RadioButton
        {
            Location = new Point(260, 28),
            Size = new Size(220, 24),
            Text = "🌙 Giao diện Tối (Dark Mode)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = isDarkMode
        };
        grpTheme.Controls.Add(rbLight);
        grpTheme.Controls.Add(rbDark);
        form.Controls.Add(grpTheme);

        y += 82;

        // --- 3. Cỡ chữ & Tỷ lệ hiển thị ---
        var grpFont = new GroupBox
        {
            Text = "🔤 3. Cỡ chữ hiển thị (Font Size)",
            Location = new Point(20, y),
            Size = new Size(560, 70),
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
        };
        var rbFontSmall = new RadioButton
        {
            Location = new Point(20, 28),
            Size = new Size(115, 24),
            Text = "Nhỏ (13px)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentFontSize == 13
        };
        var rbFontNormal = new RadioButton
        {
            Location = new Point(140, 28),
            Size = new Size(130, 24),
            Text = "Vừa (14px - Chuẩn)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentFontSize == 14
        };
        var rbFontLarge = new RadioButton
        {
            Location = new Point(280, 28),
            Size = new Size(115, 24),
            Text = "Lớn (16px)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentFontSize == 16
        };
        var rbFontXLarge = new RadioButton
        {
            Location = new Point(405, 28),
            Size = new Size(135, 24),
            Text = "Rất lớn (18px)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentFontSize == 18
        };
        grpFont.Controls.Add(rbFontSmall);
        grpFont.Controls.Add(rbFontNormal);
        grpFont.Controls.Add(rbFontLarge);
        grpFont.Controls.Add(rbFontXLarge);
        form.Controls.Add(grpFont);

        y += 82;

        // --- 4. Ngôn ngữ (Language / 언어) ---
        var grpLang = new GroupBox
        {
            Text = "🌐 4. Ngôn ngữ hiển thị (Language / 언어)",
            Location = new Point(20, y),
            Size = new Size(560, 70),
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
        };
        var rbLangVi = new RadioButton
        {
            Location = new Point(20, 28),
            Size = new Size(160, 24),
            Text = "🇻🇳 Tiếng Việt (VN)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentLang == "vi"
        };
        var rbLangEn = new RadioButton
        {
            Location = new Point(190, 28),
            Size = new Size(160, 24),
            Text = "🇬🇧 English (EN)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentLang == "en"
        };
        var rbLangKo = new RadioButton
        {
            Location = new Point(360, 28),
            Size = new Size(160, 24),
            Text = "🇰🇷 한국어 (KO)",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Checked = currentLang == "ko"
        };
        grpLang.Controls.Add(rbLangVi);
        grpLang.Controls.Add(rbLangEn);
        grpLang.Controls.Add(rbLangKo);
        form.Controls.Add(grpLang);

        y += 82;

        // --- 5. Đăng xuất / Đổi tài khoản ---
        var grpAccount = new GroupBox
        {
            Text = "👤 5. Tài khoản người dùng",
            Location = new Point(20, y),
            Size = new Size(560, 70),
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
        };
        var btnLogout = new Button
        {
            Location = new Point(16, 26),
            Size = new Size(240, 32),
            Text = "🚪 Đăng Xuất / Đổi Tài Khoản",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Bold),
            BackColor = Color.FromArgb(254, 226, 226),
            ForeColor = Color.FromArgb(185, 28, 28),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnLogout.FlatAppearance.BorderSize = 0;
        btnLogout.Click += async (s, e) =>
        {
            form.Close();
            if (webView?.CoreWebView2 != null)
            {
                await webView.CoreWebView2.ExecuteScriptAsync(
                    "fetch('/api/auth/logout', {method: 'POST'}).finally(() => { localStorage.removeItem('csrfToken'); window.location.reload(); });"
                );
            }
        };

        var btnCreateShortcut = new Button
        {
            Location = new Point(275, 26),
            Size = new Size(270, 32),
            Text = "🖥️ Tạo Icon Vào Nhanh Trên Desktop",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Bold),
            BackColor = Color.FromArgb(241, 245, 249),
            ForeColor = Color.FromArgb(15, 23, 42),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnCreateShortcut.FlatAppearance.BorderSize = 0;
        btnCreateShortcut.Click += (s, e) =>
        {
            EnsureDesktopShortcut(true);
            MessageBox.Show("Đã tạo biểu tượng 'Quản Lý Kho WMS' trên màn hình Desktop của bạn thành công!", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Information);
        };

        grpAccount.Controls.Add(btnLogout);
        grpAccount.Controls.Add(btnCreateShortcut);
        form.Controls.Add(grpAccount);

        y += 82;

        // --- 6. Máy chủ kho ---
        var grpServer = new GroupBox
        {
            Text = "🌐 6. Địa chỉ máy chủ kho (LAN / Online)",
            Location = new Point(20, y),
            Size = new Size(560, 85),
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold)
        };
        var txtServer = new TextBox
        {
            Location = new Point(16, 32),
            Size = new Size(390, 25),
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            Text = currentServerUrl
        };
        var btnLocalFast = new Button
        {
            Location = new Point(415, 30),
            Size = new Size(65, 28),
            Text = "Local",
            Font = new Font("Segoe UI", 8.5f),
            BackColor = Color.FromArgb(241, 245, 249),
            FlatStyle = FlatStyle.Flat
        };
        btnLocalFast.Click += (s, e) => txtServer.Text = DefaultLocalUrl;
        var btnTunnelFast = new Button
        {
            Location = new Point(485, 30),
            Size = new Size(60, 28),
            Text = "Cloud",
            Font = new Font("Segoe UI", 8.5f),
            BackColor = Color.FromArgb(241, 245, 249),
            FlatStyle = FlatStyle.Flat
        };
        btnTunnelFast.Click += (s, e) => txtServer.Text = DefaultTunnelUrl;

        grpServer.Controls.Add(txtServer);
        grpServer.Controls.Add(btnLocalFast);
        grpServer.Controls.Add(btnTunnelFast);
        form.Controls.Add(grpServer);

        y += 98;

        // --- 5. Tùy chọn hiển thị & Nút Lưu ---
        var chkShowTopBar = new CheckBox
        {
            Location = new Point(24, y),
            Size = new Size(320, 24),
            Text = "Hiển thị thanh trạng thái bản quyền trên cùng",
            Font = new Font("Segoe UI", 9.0f),
            Checked = isTopBarVisible
        };
        form.Controls.Add(chkShowTopBar);

        var btnSaveAll = new Button
        {
            Location = new Point(380, y),
            Size = new Size(200, 38),
            Text = "💾 Lưu Tất Cả Cài Đặt",
            Font = new Font("Segoe UI", 10.0f, FontStyle.Bold),
            BackColor = Color.FromArgb(37, 99, 235),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnSaveAll.FlatAppearance.BorderSize = 0;
        btnSaveAll.Click += (s, e) =>
        {
            // 1. Lưu thư mục
            var p = txtStorage.Text.Trim();
            if (!string.IsNullOrEmpty(p) && Directory.Exists(p))
            {
                currentStoragePath = p;
            }

            // 2. Lưu Theme
            isDarkMode = rbDark.Checked;
            ApplyThemeToWebView();

            // 3. Lưu Cỡ chữ
            currentFontSize = rbFontSmall.Checked ? 13 : rbFontLarge.Checked ? 16 : rbFontXLarge.Checked ? 18 : 14;
            currentZoomFactor = currentFontSize == 13 ? 0.92 : currentFontSize == 16 ? 1.15 : currentFontSize == 18 ? 1.28 : 1.0;
            ApplyFontSizeToWebView();

            // 4. Lưu Ngôn ngữ
            currentLang = rbLangEn.Checked ? "en" : rbLangKo.Checked ? "ko" : "vi";
            ApplyLanguageToWebView();

            // 5. Lưu Server
            var sUrl = txtServer.Text.Trim();
            bool serverChanged = false;
            if (!string.IsNullOrEmpty(sUrl) && sUrl != currentServerUrl)
            {
                currentServerUrl = sUrl;
                serverChanged = true;
            }

            // 6. Lưu Hiển thị TopBar
            SaveTopBarVisibility(chkShowTopBar.Checked);
            topBar.Visible = isTopBarVisible;
            btnFloatingSettings.Visible = !isTopBarVisible;

            // Lưu Registry
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
                key?.SetValue(RegValueStoragePath, currentStoragePath);
                key?.SetValue(RegValueDarkMode, isDarkMode ? "1" : "0");
                key?.SetValue(RegValueFontSize, currentFontSize.ToString());
                key?.SetValue(RegValueLang, currentLang);
                key?.SetValue(RegValueServerUrl, currentServerUrl);
            }
            catch { }

            MessageBox.Show("Đã lưu các cài đặt thành công!", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Information);
            form.Close();

            if (serverChanged && webView.CoreWebView2 != null && !IsExpiredOrTampered())
            {
                webView.CoreWebView2.Navigate(currentServerUrl);
            }
        };
        form.Controls.Add(btnSaveAll);

        form.ShowDialog(this);
    }

    private void ShowActivationDialog()
    {
        using var form = new Form
        {
            Text = "Kích Hoạt Bản Quyền Chính Thức",
            Size = new Size(520, 290),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = Color.White
        };

        var lblPrompt = new Label
        {
            Text = "Nhập Mã Bản Quyền Chính Thức (License Key) do nhà phát triển cung cấp:",
            Dock = DockStyle.Top,
            Height = 40,
            Padding = new Padding(20, 15, 20, 0),
            Font = new Font("Segoe UI", 10.0f)
        };

        var txtKey = new TextBox
        {
            Location = new Point(24, 65),
            Width = 455,
            Font = new Font("Consolas", 12.0f, FontStyle.Bold),
            TextAlign = HorizontalAlignment.Center
        };

        var lblStatus = new Label
        {
            Location = new Point(24, 105),
            Width = 455,
            Height = 35,
            ForeColor = Color.DimGray,
            Font = new Font("Segoe UI", 9.0f),
            Text = "Gợi ý: Mã kích hoạt có dạng WMS-PRO-2026-..."
        };

        var btnSubmit = new Button
        {
            Text = "Xác Nhận Kích Hoạt Vĩnh Viễn",
            Location = new Point(130, 150),
            Size = new Size(240, 42),
            BackColor = Color.FromArgb(37, 99, 235),
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnSubmit.FlatAppearance.BorderSize = 0;

        var btnResetTrial = new Button
        {
            Text = "Quay lại chế độ Dùng Thử 3 Ngày (Reset Test)",
            Location = new Point(130, 200),
            Size = new Size(240, 30),
            BackColor = Color.FromArgb(241, 245, 249),
            ForeColor = Color.FromArgb(71, 85, 105),
            Font = new Font("Segoe UI", 8.5f),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnResetTrial.FlatAppearance.BorderSize = 0;
        btnResetTrial.Click += (s, e) =>
        {
            SaveLicensedStatus(false);
            MessageBox.Show("Đã chuyển về chế độ Dùng Thử 3 Ngày để kiểm tra!", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Information);
            form.Close();
            UpdateCountdownDisplay();
            if (webView.CoreWebView2 != null && !IsExpiredOrTampered())
            {
                webView.CoreWebView2.Navigate(currentServerUrl);
            }
        };

        btnSubmit.Click += (s, e) =>
        {
            var input = txtKey.Text.Trim();
            if (ValidateLicenseKey(input))
            {
                SaveLicensedStatus(true);
                MessageBox.Show(
                    "Chúc mừng! Phần mềm Quản Lý Kho (WMS) đã được kích hoạt BẢN QUYỀN CHÍNH THỨC VĨNH VIỄN!\n\nToàn bộ giới hạn dùng thử đã được gỡ bỏ.",
                    "Kích Hoạt Thành Công",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                form.Close();
                UpdateCountdownDisplay();
                if (webView.CoreWebView2 != null)
                {
                    webView.CoreWebView2.Navigate(currentServerUrl);
                }
            }
            else
            {
                lblStatus.ForeColor = Color.Red;
                lblStatus.Text = "❌ Mã bản quyền không chính xác. Vui lòng kiểm tra lại!";
            }
        };

        form.Controls.Add(lblPrompt);
        form.Controls.Add(txtKey);
        form.Controls.Add(lblStatus);
        form.Controls.Add(btnSubmit);
        form.Controls.Add(btnResetTrial);

        form.ShowDialog(this);
    }

    private bool ValidateLicenseKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return false;

        key = key.Trim().ToUpperInvariant();

        foreach (var masterKey in ValidMasterKeys)
        {
            if (key == masterKey) return true;
        }

        if (key.StartsWith("WMS-PRO-") && key.Length >= 16)
        {
            using var sha = SHA256.Create();
            var hashBytes = sha.ComputeHash(Encoding.UTF8.GetBytes("WMS_SECRET_SALT_2026_" + key.Substring(0, 12)));
            var expectedSuffix = BitConverter.ToString(hashBytes).Replace("-", "").Substring(0, 4);
            if (key.EndsWith(expectedSuffix))
            {
                return true;
            }
        }

        return false;
    }

    public static void EnsureDesktopShortcut(bool force = false)
    {
        try
        {
            string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            string shortcutPath = Path.Combine(desktopPath, "Quan Ly Kho WMS.lnk");
            string? exePath = Environment.ProcessPath ?? Application.ExecutablePath;

            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return;

            if (!File.Exists(shortcutPath) || force)
            {
                Type? shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType)!;
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = exePath;
                    shortcut.WorkingDirectory = Path.GetDirectoryName(exePath);
                    shortcut.Description = "Hệ thống Quản Lý Kho (WMS) - Local-First Edition";
                    shortcut.IconLocation = exePath + ",0";
                    shortcut.Save();
                }
            }
        }
        catch { }
    }
}
