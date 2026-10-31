using System;
using System.Drawing;
using System.Net.Http;
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
    private Button btnServerConfig = null!;
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

    public const string DefaultLocalUrl = "https://localhost";
    public const string DefaultTunnelUrl = "https://biological-candy-instruments-installations.trycloudflare.com";

    private string currentServerUrl = DefaultLocalUrl;

    public Form1()
    {
        InitializeComponent();
        this.Text = "HỆ THỐNG QUẢN LÝ KHO (WMS) - LOCAL-FIRST EDITION";
        this.Size = new Size(1366, 850);
        this.MinimumSize = new Size(1024, 700);
        this.StartPosition = FormStartPosition.CenterScreen;

        LoadSavedSettings();
        BuildUI();
        StartLicenseAndCountdown();
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
                    // Tự động sửa nếu trước đó lỡ nhập cổng 3000
                    if (savedUrl.Contains(":3000"))
                    {
                        currentServerUrl = DefaultLocalUrl;
                    }
                    else
                    {
                        currentServerUrl = savedUrl;
                    }
                }
            }
        }
        catch { }

        if (string.IsNullOrWhiteSpace(currentServerUrl))
        {
            currentServerUrl = DefaultLocalUrl;
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
                    return false; // Gian lận lùi giờ máy tính
                }
            }

            key?.SetValue(RegValueLastSeen, now.ToString("o"));
        }
        catch { }
        return true;
    }

    private void BuildUI()
    {
        topBar = new Panel
        {
            Dock = DockStyle.Top,
            Height = 44,
            BackColor = Color.FromArgb(245, 158, 11),
            Padding = new Padding(12, 6, 12, 6)
        };

        lblCountdown = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Segoe UI", 10.0f, FontStyle.Bold),
            ForeColor = Color.FromArgb(69, 26, 3),
            Text = "Đang kiểm tra thời hạn bản quyền..."
        };

        btnActivate = new Button
        {
            Dock = DockStyle.Right,
            Width = 175,
            Text = "🔑 Nhập Mã Bản Quyền",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            BackColor = Color.White,
            ForeColor = Color.FromArgb(180, 83, 9),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnActivate.FlatAppearance.BorderSize = 0;
        btnActivate.Click += (s, e) => ShowActivationDialog();

        btnServerConfig = new Button
        {
            Dock = DockStyle.Right,
            Width = 145,
            Text = "⚙️ Đổi Máy Chủ",
            Font = new Font("Segoe UI", 9.0f, FontStyle.Regular),
            BackColor = Color.FromArgb(254, 243, 199),
            ForeColor = Color.FromArgb(146, 64, 14),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnServerConfig.FlatAppearance.BorderSize = 0;
        btnServerConfig.Click += (s, e) => ShowServerConfigDialog();

        topBar.Controls.Add(lblCountdown);
        topBar.Controls.Add(btnServerConfig);
        topBar.Controls.Add(new Label { Dock = DockStyle.Right, Width = 8 });
        topBar.Controls.Add(btnActivate);

        webView = new WebView2
        {
            Dock = DockStyle.Fill
        };

        // Thứ tự thêm controls rất quan trọng trong WinForms:
        this.Controls.Add(webView);
        this.Controls.Add(topBar);
        topBar.BringToFront();
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

        if (!CheckClockRollback())
        {
            return true;
        }

        if (DateTime.Now > ExpiryDate)
        {
            return true;
        }

        return false;
    }

    private void UpdateCountdownDisplay()
    {
        if (IsSystemLicensed())
        {
            topBar.BackColor = Color.FromArgb(22, 163, 74);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "✅ BẢN QUYỀN CHÍNH THỨC (VĨNH VIỄN) - HỆ THỐNG ĐÃ KÍCH HOẠT THÀNH CÔNG";
            btnActivate.Text = "🔄 Đổi Mã Bản Quyền";
            btnActivate.ForeColor = Color.FromArgb(22, 163, 74);
            return;
        }

        btnActivate.Text = "🔑 Nhập Mã Bản Quyền";
        btnActivate.ForeColor = Color.FromArgb(180, 83, 9);

        if (!CheckClockRollback())
        {
            topBar.BackColor = Color.FromArgb(220, 38, 38);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "⚠️ CẢNH BÁO: Phát hiện ngày giờ hệ thống không hợp lệ! Vui lòng liên hệ nhà phát triển.";
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
            lblCountdown.Text = $"⏱️ BẢN DÙNG THỬ: Còn lại {timeStr} (Hạn chót: 23:59:59 03/11/2026)";
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
                "3. Bấm vào nút <b>[🔑 Nhập Mã Bản Quyền]</b> ở góc trên bên phải để mở khóa ngay lập tức mà không mất dữ liệu." +
                "</div>" +
                "<p style='font-size:14px;color:#94a3b8;'>Hệ thống Local-First - Dữ liệu lưu trữ an toàn tuyệt đối tại máy trạm.</p>" +
                "</div>" +
                "</body></html>"
            );
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            // Bỏ qua lỗi SSL self-signed của Docker Nginx nội bộ máy local
            var options = new CoreWebView2EnvironmentOptions("--ignore-certificate-errors --allow-insecure-localhost");
            var env = await CoreWebView2Environment.CreateAsync(null, null, options);
            await webView.EnsureCoreWebView2Async(env);

            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true; // Cho phép F12 nếu cần inspect

            // Chấp nhận SSL tự ký mạng LAN
            webView.CoreWebView2.ServerCertificateErrorDetected += (s, e) =>
            {
                e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
            };

            // Tự động cấp quyền Camera khi quét mã Barcode/QR
            webView.CoreWebView2.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Camera)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                }
            };

            webView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                if (!e.IsSuccess && !IsExpiredOrTampered())
                {
                    // Nếu kết nối https://localhost thất bại, tự động thử sang tunnel dự phòng
                    if (currentServerUrl == DefaultLocalUrl)
                    {
                        currentServerUrl = DefaultTunnelUrl;
                        webView.CoreWebView2.Navigate(currentServerUrl);
                        return;
                    }

                    webView.CoreWebView2.NavigateToString(
                        "<html><head><meta charset='utf-8'></head>" +
                        "<body style='font-family:sans-serif;text-align:center;padding:80px 20px;background:#f8fafc;color:#1e293b;'>" +
                        "<div style='max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);'>" +
                        "<h2 style='color:#ea580c;margin-bottom:16px;'>⚠️ Chưa Kết Nối Được Đến Máy Chủ Kho</h2>" +
                        $"<p style='font-size:15px;color:#64748b;line-height:1.6;'>Địa chỉ máy chủ đang kết nối: <code>{currentServerUrl}</code></p>" +
                        "<p style='font-size:14px;color:#64748b;'>Vui lòng kiểm tra Docker máy chủ đã khởi động hoặc bấm <b>[⚙️ Đổi Máy Chủ]</b> ở góc phải để chuyển đổi giữa Local và Online.</p>" +
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

    private void ShowServerConfigDialog()
    {
        using var form = new Form
        {
            Text = "Cài Đặt Máy Chủ Quản Lý Kho",
            Size = new Size(540, 290),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            BackColor = Color.White
        };

        var lblPrompt = new Label
        {
            Text = "Chọn hoặc nhập địa chỉ máy chủ kết nối:",
            Dock = DockStyle.Top,
            Height = 35,
            Padding = new Padding(20, 12, 20, 0),
            Font = new Font("Segoe UI", 10.0f, FontStyle.Bold)
        };

        var rbLocal = new RadioButton
        {
            Location = new Point(24, 45),
            Size = new Size(470, 25),
            Text = "Máy chủ Local nội bộ: https://localhost (Docker trên máy này)",
            Font = new Font("Segoe UI", 9.5f),
            Checked = currentServerUrl == DefaultLocalUrl
        };

        var rbTunnel = new RadioButton
        {
            Location = new Point(24, 75),
            Size = new Size(470, 25),
            Text = "Máy chủ Online Cloudflare Tunnel (Dùng được cho cả điện thoại)",
            Font = new Font("Segoe UI", 9.5f),
            Checked = currentServerUrl == DefaultTunnelUrl
        };

        var rbCustom = new RadioButton
        {
            Location = new Point(24, 105),
            Size = new Size(470, 25),
            Text = "Tùy chỉnh IP máy trạm LAN khác:",
            Font = new Font("Segoe UI", 9.5f),
            Checked = currentServerUrl != DefaultLocalUrl && currentServerUrl != DefaultTunnelUrl
        };

        var txtCustom = new TextBox
        {
            Location = new Point(44, 135),
            Width = 450,
            Font = new Font("Segoe UI", 10.0f),
            Text = currentServerUrl
        };

        rbLocal.CheckedChanged += (s, e) => { if (rbLocal.Checked) txtCustom.Text = DefaultLocalUrl; };
        rbTunnel.CheckedChanged += (s, e) => { if (rbTunnel.Checked) txtCustom.Text = DefaultTunnelUrl; };

        var btnSave = new Button
        {
            Text = "Lưu & Kết Nối Lại",
            Location = new Point(170, 190),
            Size = new Size(180, 42),
            BackColor = Color.FromArgb(16, 185, 129),
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 10.0f, FontStyle.Bold),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };
        btnSave.FlatAppearance.BorderSize = 0;

        btnSave.Click += (s, e) =>
        {
            var newUrl = txtCustom.Text.Trim();
            if (!string.IsNullOrEmpty(newUrl))
            {
                currentServerUrl = newUrl;
                try
                {
                    using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
                    key?.SetValue(RegValueServerUrl, currentServerUrl);
                }
                catch { }

                MessageBox.Show("Đã lưu địa chỉ máy chủ thành công!", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Information);
                form.Close();
                if (webView.CoreWebView2 != null && !IsExpiredOrTampered())
                {
                    webView.CoreWebView2.Navigate(currentServerUrl);
                }
            }
        };

        form.Controls.Add(lblPrompt);
        form.Controls.Add(rbLocal);
        form.Controls.Add(rbTunnel);
        form.Controls.Add(rbCustom);
        form.Controls.Add(txtCustom);
        form.Controls.Add(btnSave);

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
}
