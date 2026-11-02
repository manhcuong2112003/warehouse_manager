using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
    private Button btnDismiss = null!;
    private System.Windows.Forms.Timer countdownTimer = null!;

    // Cấu hình thời hạn dùng thử: 3 ngày (72 giờ) tính từ thời điểm kích hoạt/chạy lần đầu trên máy khách
    public const int TrialDurationDays = 3;
    private DateTime effectiveExpiryDate = DateTime.Now.AddDays(TrialDurationDays);
    private bool isTrialExpired = false;
    private bool isClockTampered = false;
    private bool hasAttemptedExpiryBackup = false;
    private string? lastCreatedBackupPath = null;
    private bool isProgressScreenLoaded = false;

    private static readonly string ClsidRegistryPath = @"Software\Classes\CLSID\{D8B7A1C2-5E3F-4B89-9A01-C34E6B7A8D9E}";
    private static readonly string ProgramDataFilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Microsoft", "Crypto", "sys_wms.dat"
    );
    private static readonly string LocalAppDataFilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Microsoft", "Vault", "sys_token.dat"
    );

    private class TrialRecord
    {
        public long FirstRunTicks { get; set; }
        public long ExpiryTicks { get; set; }
        public long LastSeenTicks { get; set; }
        public int IsExpired { get; set; }
        public string MachineId { get; set; } = "";
    }

    private static string GetMachineFingerprint()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
            var guid = key?.GetValue("MachineGuid") as string;
            if (!string.IsNullOrWhiteSpace(guid)) return guid.Trim();
        }
        catch { }
        return Environment.MachineName + "_" + Environment.ProcessorCount;
    }

    private static string ComputeTrialSignature(long firstRun, long expiry, long lastSeen, int isExpired, string machineId)
    {
        string payload = $"{firstRun}:{expiry}:{lastSeen}:{isExpired}:{machineId}:WMS_SECURE_SALT_2026_@ANTIGRAVITY#";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes("WMS_SECRET_KEY_PRO_2026_WAREHOUSE"));
        byte[] hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
        return Convert.ToBase64String(hash);
    }

    private static string SerializeRecord(TrialRecord r)
    {
        string sig = ComputeTrialSignature(r.FirstRunTicks, r.ExpiryTicks, r.LastSeenTicks, r.IsExpired, r.MachineId);
        string plain = $"{r.FirstRunTicks}|{r.ExpiryTicks}|{r.LastSeenTicks}|{r.IsExpired}|{r.MachineId}|{sig}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(plain));
    }

    private static TrialRecord? DeserializeRecord(string? raw, string expectedMachine)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try
        {
            byte[] bytes = Convert.FromBase64String(raw.Trim());
            string plain = Encoding.UTF8.GetString(bytes);
            string[] parts = plain.Split('|');
            if (parts.Length != 6) return null;

            long firstRun = long.Parse(parts[0]);
            long expiry = long.Parse(parts[1]);
            long lastSeen = long.Parse(parts[2]);
            int isExpired = int.Parse(parts[3]);
            string machineId = parts[4];
            string sig = parts[5];

            if (machineId != expectedMachine) return null;

            string expectedSig = ComputeTrialSignature(firstRun, expiry, lastSeen, isExpired, machineId);
            if (sig != expectedSig) return null;

            return new TrialRecord
            {
                FirstRunTicks = firstRun,
                ExpiryTicks = expiry,
                LastSeenTicks = lastSeen,
                IsExpired = isExpired,
                MachineId = machineId
            };
        }
        catch
        {
            return null;
        }
    }

    private static void TryReadFromRegistry(string subKey, string valueName, string machine, List<TrialRecord> target)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(subKey);
            var val = key?.GetValue(valueName) as string;
            var rec = DeserializeRecord(val, machine);
            if (rec != null) target.Add(rec);
        }
        catch { }
    }

    private static void TryReadFromFile(string filePath, string machine, List<TrialRecord> target)
    {
        try
        {
            if (File.Exists(filePath))
            {
                string text = File.ReadAllText(filePath);
                var rec = DeserializeRecord(text, machine);
                if (rec != null) target.Add(rec);
            }
        }
        catch { }
    }

    private static void PersistTrialRecord(TrialRecord r)
    {
        string payload = SerializeRecord(r);

        // 1. Registry 1 (App root)
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RegistryKeyPath);
            key?.SetValue("TrialToken", payload, RegistryValueKind.String);
        }
        catch { }

        // 2. Registry 2 (CLSID stealth)
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(ClsidRegistryPath);
            key?.SetValue("Data", payload, RegistryValueKind.String);
        }
        catch { }

        // 3. ProgramData File
        try
        {
            string dir = Path.GetDirectoryName(ProgramDataFilePath)!;
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(ProgramDataFilePath, payload);
            File.SetAttributes(ProgramDataFilePath, FileAttributes.Hidden | FileAttributes.System);
        }
        catch { }

        // 4. LocalAppData File
        try
        {
            string dir = Path.GetDirectoryName(LocalAppDataFilePath)!;
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(LocalAppDataFilePath, payload);
            File.SetAttributes(LocalAppDataFilePath, FileAttributes.Hidden);
        }
        catch { }
    }

    private void InitializeTrialState()
    {
        if (IsSystemLicensed())
        {
            return;
        }

        string machine = GetMachineFingerprint();
        var records = new List<TrialRecord>();

        TryReadFromRegistry(RegistryKeyPath, "TrialToken", machine, records);
        TryReadFromRegistry(ClsidRegistryPath, "Data", machine, records);
        TryReadFromFile(ProgramDataFilePath, machine, records);
        TryReadFromFile(LocalAppDataFilePath, machine, records);

        long nowTicks = DateTime.UtcNow.Ticks;
        TrialRecord canonical;

        if (records.Count > 0)
        {
            // TÌM FIRST RUN SỚM NHẤT TRÊN TOÀN BỘ CÁC VỊ TRÍ
            // (Người dùng không thể xóa 1 nơi để reset ngày)
            long minFirstRun = records.Min(r => r.FirstRunTicks);
            long canonicalExpiry = minFirstRun + TimeSpan.FromDays(TrialDurationDays).Ticks;
            long maxLastSeen = records.Max(r => r.LastSeenTicks);

            // Kiểm tra lùi đồng hồ máy tính
            if (nowTicks < maxLastSeen - TimeSpan.FromMinutes(20).Ticks)
            {
                isClockTampered = true;
            }

            int expired = (nowTicks >= canonicalExpiry || records.Any(r => r.IsExpired == 1)) ? 1 : 0;

            canonical = new TrialRecord
            {
                FirstRunTicks = minFirstRun,
                ExpiryTicks = canonicalExpiry,
                LastSeenTicks = Math.Max(maxLastSeen, nowTicks),
                IsExpired = expired,
                MachineId = machine
            };
        }
        else
        {
            // Lần đầu tiên chạy trên máy tính khách hàng:
            // Bắt đầu đếm 3 ngày (72 giờ) từ thời điểm này
            long expiryTicks = DateTime.UtcNow.AddDays(TrialDurationDays).Ticks;
            canonical = new TrialRecord
            {
                FirstRunTicks = nowTicks,
                ExpiryTicks = expiryTicks,
                LastSeenTicks = nowTicks,
                IsExpired = 0,
                MachineId = machine
            };
        }

        effectiveExpiryDate = new DateTime(canonical.ExpiryTicks, DateTimeKind.Utc).ToLocalTime();
        isTrialExpired = canonical.IsExpired == 1 || nowTicks >= canonical.ExpiryTicks;

        // Lưu đồng bộ canonical record vào cả 4 vị trí để tự phục hồi
        PersistTrialRecord(canonical);
    }

    private void UpdateLastSeen(long currentUtcTicks)
    {
        if (IsSystemLicensed()) return;
        string machine = GetMachineFingerprint();
        var records = new List<TrialRecord>();
        TryReadFromRegistry(RegistryKeyPath, "TrialToken", machine, records);
        if (records.Count == 0) return;

        var rec = records[0];
        if (currentUtcTicks < rec.LastSeenTicks - TimeSpan.FromMinutes(20).Ticks)
        {
            isClockTampered = true;
            return;
        }

        rec.LastSeenTicks = Math.Max(rec.LastSeenTicks, currentUtcTicks);
        if (currentUtcTicks >= rec.ExpiryTicks)
        {
            rec.IsExpired = 1;
            isTrialExpired = true;
        }
        PersistTrialRecord(rec);
    }

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
        Task.Run(() => EnsureFirewallRule());

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
                    currentServerUrl = savedUrl;
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
        return !isClockTampered;
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

        topBar.Controls.Add(lblCountdown);
        topBar.Controls.Add(btnActivate);
        topBar.Controls.Add(new Label { Dock = DockStyle.Right, Width = 6 });
        topBar.Controls.Add(btnDismiss);

        // 2. WebView2
        webView = new WebView2
        {
            Dock = DockStyle.Fill
        };

        this.Controls.Add(webView);
        this.Controls.Add(topBar);

        topBar.BringToFront();
    }

    private async void StartLicenseAndCountdown()
    {
        InitializeTrialState();

        countdownTimer = new System.Windows.Forms.Timer
        {
            Interval = 1000
        };
        int tickCount = 0;
        countdownTimer.Tick += (s, e) =>
        {
            tickCount++;
            if (tickCount % 30 == 0)
            {
                UpdateLastSeen(DateTime.UtcNow.Ticks);
            }
            UpdateCountdownDisplay();
        };
        countdownTimer.Start();

        UpdateCountdownDisplay();
        await InitializeWebViewAsync();
    }

    private bool IsExpiredOrTampered()
    {
        if (IsSystemLicensed()) return false;
        if (isClockTampered) return true;
        if (isTrialExpired) return true;
        if (DateTime.UtcNow.Ticks >= effectiveExpiryDate.ToUniversalTime().Ticks)
        {
            isTrialExpired = true;
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
            btnActivate.Visible = false;
            btnDismiss.ForeColor = Color.White;
            return;
        }

        btnActivate.Visible = true;
        btnDismiss.ForeColor = Color.FromArgb(69, 26, 3);

        if (isClockTampered)
        {
            topBar.BackColor = Color.FromArgb(220, 38, 38);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "⚠️ CẢNH BÁO: Phát hiện ngày giờ hệ thống không hợp lệ! Vui lòng chỉnh lại đúng giờ thực tế.";
            TriggerExpiryBackupIfNeeded();
            ShowExpiredScreen();
            return;
        }

        var remaining = effectiveExpiryDate - DateTime.Now;
        if (remaining <= TimeSpan.Zero || isTrialExpired)
        {
            isTrialExpired = true;
            topBar.BackColor = Color.FromArgb(220, 38, 38);
            lblCountdown.ForeColor = Color.White;
            lblCountdown.Text = "⚠️ BẢN DÙNG THỬ 3 NGÀY ĐÃ HẾT HẠN! Vui lòng nhập mã kích hoạt để tiếp tục sử dụng.";
            TriggerExpiryBackupIfNeeded();
            ShowExpiredScreen();
        }
        else
        {
            topBar.BackColor = Color.FromArgb(245, 158, 11);
            lblCountdown.ForeColor = Color.FromArgb(69, 26, 3);
            string timeStr = $"{(int)remaining.TotalDays} ngày {remaining.Hours:D2} giờ {remaining.Minutes:D2} phút {remaining.Seconds:D2} giây";
            lblCountdown.Text = $"⏱️ DÙNG THỬ 3 NGÀY: Còn lại {timeStr} (Hạn: {effectiveExpiryDate:HH:mm:ss dd/MM/yyyy})";
        }
    }

    private void TriggerExpiryBackupIfNeeded()
    {
        if (!hasAttemptedExpiryBackup)
        {
            hasAttemptedExpiryBackup = true;
            _ = Task.Run(async () =>
            {
                await PerformExpiryBackupAsync(false);
            });
        }
    }

    private void ShowExpiredScreen()
    {
        if (this.InvokeRequired)
        {
            try { this.Invoke(ShowExpiredScreen); } catch { }
            return;
        }

        if (webView?.CoreWebView2 != null)
        {
            string backupDir = Path.Combine(currentStoragePath, "Backups");
            string? latestBackup = lastCreatedBackupPath;
            if (string.IsNullOrEmpty(latestBackup) && Directory.Exists(backupDir))
            {
                var files = Directory.GetFiles(backupDir, "BaoCao_Backup_KhiHetHan_*.xlsx");
                if (files.Length > 0)
                {
                    latestBackup = files.OrderByDescending(f => File.GetCreationTime(f)).FirstOrDefault();
                }
            }

            string backupHtmlSection;
            if (!string.IsNullOrEmpty(latestBackup) && File.Exists(latestBackup))
            {
                string safePath = latestBackup.Replace("\\", "/");
                backupHtmlSection = 
                    "<div style='background:#ecfdf5;border:1px solid #a7f3d0;padding:20px;border-radius:12px;text-align:left;margin-bottom:24px;'>" +
                    "<div style='color:#065f46;font-weight:700;font-size:16px;margin-bottom:8px;display:flex;align-items:center;gap:8px;'>" +
                    "<span>✅</span> <span>Toàn Bộ Dữ Liệu Kho Đã Tự Động Sao Lưu Ra File Excel An Toàn</span>" +
                    "</div>" +
                    "<div style='color:#047857;font-size:13.5px;line-height:1.6;margin-bottom:14px;'>" +
                    "Bản sao lưu đầy đủ 5 sheet (Tồn kho tổng hợp, Chi tiết kiện pack & lô, Nhật ký biến động xuất nhập, Danh mục sản phẩm, Thông tin hệ thống) đã được lưu trữ vĩnh viễn trên máy tính của bạn:" +
                    $"<br><code style='display:block;margin-top:6px;background:#ffffff;padding:8px 12px;border-radius:6px;border:1px solid #d1fae5;font-size:12px;word-break:break-all;color:#0f172a;font-family:Consolas,monospace;'>{latestBackup}</code>" +
                    "</div>" +
                    "<div style='display:flex;gap:10px;align-items:center;flex-wrap:wrap;'>" +
                    "<button onclick=\"window.chrome.webview.postMessage('open_backup_folder')\" style='background:#059669;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;box-shadow:0 2px 4px rgba(5,150,105,0.2);'>📂 Mở Thư Mục Chứa File Excel Backup</button>" +
                    "<button onclick=\"window.chrome.webview.postMessage('trigger_backup')\" style='background:#f0fdf4;color:#065f46;border:1px solid #86efac;padding:10px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;'>🔄 Cập Nhật Lại Bản Sao Lưu Mới</button>" +
                    "</div>" +
                    "</div>";
            }
            else
            {
                backupHtmlSection = 
                    "<div style='background:#fef3c7;border:1px solid #fde68a;padding:20px;border-radius:12px;text-align:left;margin-bottom:24px;'>" +
                    "<div style='color:#92400e;font-weight:700;font-size:16px;margin-bottom:8px;display:flex;align-items:center;gap:8px;'>" +
                    "<span>📥</span> <span>Cơ Chế Bảo Toàn & Tự Động Sao Lưu Dữ Liệu Ra File Excel</span>" +
                    "</div>" +
                    "<div style='color:#78350f;font-size:13.5px;line-height:1.6;margin-bottom:14px;'>" +
                    "Toàn bộ cơ sở dữ liệu trên máy quý khách luôn được bảo toàn 100% không bao giờ bị xóa. Bạn có thể xuất và lưu ngay toàn bộ số liệu kho ra file Excel nhiều sheet đầy đủ thông tin:" +
                    "</div>" +
                    "<div style='display:flex;gap:10px;align-items:center;flex-wrap:wrap;'>" +
                    "<button onclick=\"window.chrome.webview.postMessage('trigger_backup')\" style='background:#d97706;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;box-shadow:0 2px 4px rgba(217,119,6,0.2);'>📊 Xuất & Lưu Toàn Bộ Dữ Liệu Ra File Excel Ngay</button>" +
                    "<button onclick=\"window.chrome.webview.postMessage('open_backup_folder')\" style='background:#ffffff;color:#374151;border:1px solid #cbd5e1;padding:10px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;'>📂 Mở Thư Mục Backup</button>" +
                    "</div>" +
                    "</div>";
            }

            webView.CoreWebView2.NavigateToString(
                "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Hết Hạn Dùng Thử</title></head>" +
                "<body style='font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;text-align:center;padding:50px 20px;background:#f8fafc;color:#1e293b;margin:0;'>" +
                "<div style='max-width:680px;margin:0 auto;background:#fff;padding:40px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.08);border:1px solid #e2e8f0;'>" +
                "<div style='font-size:48px;margin-bottom:16px;'>🔒</div>" +
                "<h1 style='color:#dc2626;font-size:24px;margin-bottom:12px;font-weight:700;'>Bản Dùng Thử 3 Ngày Đã Hết Hạn</h1>" +
                "<p style='font-size:15px;line-height:1.6;color:#64748b;margin-bottom:24px;'>" +
                $"Thời hạn trải nghiệm 3 ngày của hệ thống Quản Lý Kho (WMS) đã kết thúc vào <b>{effectiveExpiryDate:HH:mm:ss dd/MM/yyyy}</b>.<br/>" +
                "Toàn bộ chức năng thao tác kho đã tạm thời khóa bảo vệ.</p>" +
                backupHtmlSection +
                "<div style='background:#f1f5f9;border-left:4px solid #3b82f6;padding:16px 20px;text-align:left;border-radius:8px;font-size:14.5px;color:#334155;margin-bottom:24px;'>" +
                "<b>Để mở khóa sử dụng vĩnh viễn:</b><br/>" +
                "1. Hoàn tất nghiệm thu & thanh toán với nhà phát triển.<br/>" +
                "2. Nhận <b>Mã kích hoạt bản quyền chính thức</b>.<br/>" +
                "3. Bấm vào nút <b>[🔑 Mã Bản Quyền]</b> trên thanh vàng hoặc bấm phím <b>F2</b> để mở khóa ngay lập tức." +
                "</div>" +
                "<div style='display:flex;justify-content:center;gap:12px;'>" +
                "<button onclick=\"window.chrome.webview.postMessage('open_settings')\" style='background:#0f766e;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px;'>🔑 Nhập Mã Bản Quyền Kích Hoạt</button>" +
                "</div>" +
                "</div>" +
                "</body></html>"
            );
        }
    }

    private async Task<bool> PerformExpiryBackupAsync(bool userInitiated)
    {
        try
        {
            string backupDir = Path.Combine(currentStoragePath, "Backups");
            if (!Directory.Exists(backupDir))
            {
                Directory.CreateDirectory(backupDir);
            }

            string fileName = $"BaoCao_Backup_KhiHetHan_{DateTime.Now:yyyyMMdd_HHmmss}.xlsx";
            string targetPath = Path.Combine(backupDir, fileName);

            using var handler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (m, c, ch, p) => true
            };
            using var client = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(30)
            };

            string url = $"{currentServerUrl.TrimEnd('/')}/api/v1/reports/full-backup-excel";
            var response = await client.GetAsync(url);
            if (response.IsSuccessStatusCode)
            {
                var bytes = await response.Content.ReadAsByteArrayAsync();
                if (bytes != null && bytes.Length > 0)
                {
                    await File.WriteAllBytesAsync(targetPath, bytes);
                    lastCreatedBackupPath = targetPath;

                    if (!this.IsDisposed && this.IsHandleCreated)
                    {
                        this.Invoke(() =>
                        {
                            ShowExpiredScreen();
                            if (userInitiated)
                            {
                                MessageBox.Show($"Đã sao lưu thành công toàn bộ dữ liệu ra file Excel:\n{targetPath}", "Sao Lưu Thành Công", MessageBoxButtons.OK, MessageBoxIcon.Information);
                            }
                        });
                    }
                    return true;
                }
            }
            else if (userInitiated)
            {
                this.Invoke(() =>
                {
                    MessageBox.Show($"Máy chủ chưa phản hồi dữ liệu sao lưu (HTTP {(int)response.StatusCode}). Vui lòng đảm bảo máy chủ/Docker đang hoạt động.", "Thông Báo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                });
            }
        }
        catch (Exception ex)
        {
            if (userInitiated)
            {
                this.Invoke(() =>
                {
                    MessageBox.Show($"Không thể kết nối đến máy chủ để sao lưu: {ex.Message}\nVui lòng kiểm tra Docker hoặc máy chủ đang bật.", "Lỗi Sao Lưu", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            }
        }
        return false;
    }

    private void ShowConnectionErrorScreen()
    {
        if (this.InvokeRequired)
        {
            try { this.Invoke(ShowConnectionErrorScreen); } catch { }
            return;
        }

        isProgressScreenLoaded = false;
        if (webView?.CoreWebView2 == null) return;

        bool isLocal = currentServerUrl.Contains("localhost") || currentServerUrl.Contains("127.0.0.1");
        bool isDockerInstalled = DockerManager.IsDockerInstalled();

        string setupButtonHtml = "";
        if (isLocal)
        {
            if (isDockerInstalled)
            {
                setupButtonHtml = "<button onclick=\"window.chrome.webview.postMessage('auto_setup_docker')\" style='background:#059669;color:#fff;border:none;padding:11px 22px;border-radius:6px;font-weight:700;cursor:pointer;font-size:14px;box-shadow:0 2px 6px rgba(5,150,105,0.3);'>🚀 Tự Động Khởi Chạy & Thiết Lập Kho Trong Docker</button>";
            }
            else
            {
                setupButtonHtml = "<button onclick=\"window.chrome.webview.postMessage('download_docker')\" style='background:#2563eb;color:#fff;border:none;padding:11px 22px;border-radius:6px;font-weight:700;cursor:pointer;font-size:14px;box-shadow:0 2px 6px rgba(37,99,235,0.3);'>📥 Tải Docker Desktop Tự Động (Bản Quyền Miễn Phí)</button>";
            }
        }

        string helpText = isLocal
            ? (isDockerInstalled
                ? "Đã phát hiện Docker Desktop trên máy. Bạn có thể bấm nút màu xanh bên dưới để app tự động kích hoạt máy chủ và nạp cơ sở dữ liệu kho."
                : "Hệ thống lưu trữ 100% dữ liệu độc lập trên máy của bạn thông qua Docker. Vui lòng cài Docker Desktop để bắt đầu.")
            : "Không thể kết nối đến địa chỉ máy chủ. Vui lòng kiểm tra đường truyền mạng hoặc cấu hình lại địa chỉ máy chủ.";

        webView.CoreWebView2.NavigateToString(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Khởi Động Hệ Thống Kho</title></head>" +
            "<body style='font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;text-align:center;padding:50px 20px;background:#f8fafc;color:#1e293b;margin:0;'>" +
            "<div style='max-width:580px;margin:0 auto;background:#ffffff;padding:36px;border-radius:14px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.1),0 8px 10px -6px rgba(0,0,0,0.1);border:1px solid #e2e8f0;'>" +
            "<div style='font-size:46px;margin-bottom:12px;'>🏭</div>" +
            "<h2 style='color:#0f172a;margin:0 0 10px;font-size:21px;font-weight:700;'>Hệ Thống Quản Lý Kho (Local-First)</h2>" +
            $"<p style='font-size:13.5px;color:#64748b;line-height:1.6;margin:0 0 16px;'>Địa chỉ máy chủ kho đang kết nối: <br><strong style='color:#0f172a;word-break:break-all;'>{currentServerUrl}</strong></p>" +
            $"<div style='font-size:13.5px;color:#334155;background:#f1f5f9;padding:12px 16px;border-radius:8px;margin:0 0 22px;line-height:1.6;text-align:left;border-left:4px solid #0284c7;'>{helpText}</div>" +
            "<div style='display:flex;flex-direction:column;gap:12px;align-items:center;margin-bottom:18px;'>" +
            setupButtonHtml +
            "<div style='display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:6px;'>" +
            "<button onclick=\"window.chrome.webview.postMessage('retry_current')\" style='background:#f8fafc;color:#334155;border:1px solid #cbd5e1;padding:9px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;'>🔄 Thử Kết Nối Lại</button>" +
            "<button onclick=\"window.chrome.webview.postMessage('open_settings')\" style='background:#f8fafc;color:#334155;border:1px solid #cbd5e1;padding:9px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;'>⚙️ Cài Đặt Máy Chủ</button>" +
            "</div>" +
            "</div>" +
            "<p style='font-size:12.5px;color:#94a3b8;margin:0;'>Mẹo: Bấm phím <b>F2</b> trên bàn phím bất kỳ lúc nào để cấu hình kết nối.</p>" +
            "</div>" +
            "</body></html>"
        );
    }

    private void ShowDockerSetupProgressScreen(string title, int percent, string stepDesc, string latestLogLine = "")
    {
        if (this.InvokeRequired)
        {
            try
            {
                this.BeginInvoke(new Action(() => ShowDockerSetupProgressScreen(title, percent, stepDesc, latestLogLine)));
            }
            catch { }
            return;
        }

        if (webView?.CoreWebView2 == null) return;

        if (!isProgressScreenLoaded)
        {
            isProgressScreenLoaded = true;
            string initialHtml =
                "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Thiết Lập Hệ Thống Kho</title></head>" +
                "<body style='font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;text-align:center;padding:50px 20px;background:#f8fafc;color:#1e293b;margin:0;'>" +
                "<div style='max-width:640px;margin:0 auto;background:#ffffff;padding:36px;border-radius:14px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.1);border:1px solid #e2e8f0;'>" +
                "<div style='font-size:42px;margin-bottom:12px;'>🐳</div>" +
                $"<h2 id='progressTitle' style='color:#0f172a;margin:0 0 10px;font-size:21px;font-weight:700;'>{title}</h2>" +
                $"<p id='progressDesc' style='font-size:14px;color:#64748b;margin:0 0 20px;'>{stepDesc}</p>" +
                "<div style='width:100%;height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden;margin-bottom:20px;'>" +
                $"<div id='progressBar' style='width:{percent}%;height:100%;background:#0284c7;transition:width 0.4s ease;'></div>" +
                "</div>" +
                "<div style='text-align:left;background:#0f172a;color:#38bdf8;padding:12px 16px;border-radius:8px;font-family:Consolas,monospace;font-size:12px;height:160px;overflow-y:auto;line-height:1.5;box-shadow:inset 0 2px 4px rgba(0,0,0,0.2);' id='logBox'>" +
                "<div>[Hệ Thống] Đang kết nối dịch vụ Docker...</div>" +
                "</div>" +
                "</div>" +
                "</body></html>";

            webView.CoreWebView2.NavigateToString(initialHtml);
        }
        else
        {
            // Cập nhật DOM trực tiếp không reload trang để chống đơ/chớp giật
            string escapedTitle = JsonSerializer.Serialize(title);
            string escapedDesc = JsonSerializer.Serialize(stepDesc);
            string escapedLog = string.IsNullOrEmpty(latestLogLine) ? "null" : JsonSerializer.Serialize(latestLogLine);

            string script = $@"
                (function() {{
                    var t = document.getElementById('progressTitle'); if(t) t.textContent = {escapedTitle};
                    var d = document.getElementById('progressDesc'); if(d) d.textContent = {escapedDesc};
                    var b = document.getElementById('progressBar'); if(b) b.style.width = '{percent}%';
                    var l = document.getElementById('logBox');
                    var line = {escapedLog};
                    if (l && line) {{
                        var div = document.createElement('div');
                        div.textContent = line;
                        l.appendChild(div);
                        if (l.children.length > 120) l.removeChild(l.firstChild);
                        l.scrollTop = l.scrollHeight;
                    }}
                }})();";

            try
            {
                webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }
    }

    private async Task StartDockerAutoSetupAsync()
    {
        try
        {
            // 1. Kiểm tra Docker đã cài đặt chưa
            if (!DockerManager.IsDockerInstalled())
            {
                this.Invoke(() =>
                {
                    MessageBox.Show("Không tìm thấy Docker Desktop trên máy tính của bạn.\nVui lòng bấm 'Tải Docker Desktop Tự Động' để cài đặt trước khi tiếp tục.", "Yêu Cầu Docker Desktop", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    ShowConnectionErrorScreen();
                });
                return;
            }

            // 2. Kiểm tra Docker Desktop đã bật chưa
            ShowDockerSetupProgressScreen("Đang Khởi Động Docker Desktop...", 20, "Đang kiểm tra kết nối dịch vụ Docker daemon ngầm...");
            bool isRunning = await DockerManager.IsDockerRunningAsync();
            if (!isRunning)
            {
                ShowDockerSetupProgressScreen("Đang Đánh Thức Docker Desktop...", 30, "Đang mở Docker Desktop trong Windows. Quá trình này mất khoảng 20-40 giây...");
                DockerManager.StartDockerDesktop();

                // Chờ Docker Desktop sẵn sàng (tối đa 90 giây)
                int waitCount = 0;
                while (waitCount < 36)
                {
                    await Task.Delay(2500);
                    waitCount++;
                    isRunning = await DockerManager.IsDockerRunningAsync();
                    if (isRunning) break;
                    ShowDockerSetupProgressScreen("Đang Đánh Thức Docker Desktop...", Math.Min(60, 30 + waitCount), $"Đang chờ Docker khởi động xong... ({waitCount * 2}s)");
                }
            }

            if (!isRunning)
            {
                this.Invoke(() =>
                {
                    MessageBox.Show("Docker Desktop đang khởi động chậm hoặc chưa bật. Vui lòng mở Docker Desktop ngoài màn hình Desktop và chờ biểu tượng Docker chuyển sang màu xanh (Engine running) rồi thử lại.", "Thông Báo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    ShowConnectionErrorScreen();
                });
                return;
            }

            // 3. Tiến hành chạy docker compose up -d
            var logBuilder = new StringBuilder();
            ShowDockerSetupProgressScreen("Đang Thiết Lập Hệ Thống Kho Cục Bộ...", 65, "Đang tải ảnh Docker và khởi động dịch vụ kho ngầm...");

            bool composeOk = await DockerManager.RunDockerComposeUpAsync(currentStoragePath, log =>
            {
                logBuilder.AppendLine(log);
                ShowDockerSetupProgressScreen("Đang Thiết Lập Hệ Thống Kho Cục Bộ...", 75, "Đang tải và cấu hình các container kho hàng...", log);
            });

            // 4. Chờ máy chủ https://localhost sẵn sàng (tối đa 40 giây)
            ShowDockerSetupProgressScreen("Đang Kết Nối Vào Hệ Thống...", 90, "Đang kiểm tra cổng dịch vụ máy chủ...");
            int checkServerCount = 0;
            bool serverReady = false;
            while (checkServerCount < 20)
            {
                await Task.Delay(2000);
                checkServerCount++;
                serverReady = await DockerManager.IsServerOnlineAsync("https://localhost");
                if (serverReady) break;
            }

            if (serverReady)
            {
                ShowDockerSetupProgressScreen("Khởi Tạo Thành Công!", 100, "Hệ thống kho đã sẵn sàng. Đang đưa bạn vào màn hình làm việc...");
                await Task.Delay(1200);
                this.Invoke(() =>
                {
                    isProgressScreenLoaded = false;
                    webView.CoreWebView2?.Navigate(currentServerUrl);
                });
            }
            else
            {
                this.Invoke(() =>
                {
                    string details = logBuilder.Length > 0 ? ("\nChi tiết log:\n" + logBuilder.ToString()) : "";
                    if (details.Length > 600) details = details.Substring(details.Length - 600);
                    MessageBox.Show("Hệ thống Docker chưa sẵn sàng phản hồi. Vui lòng kiểm tra Docker Desktop đang bật rồi bấm 'Thử Kết Nối Lại'." + details, "Thông Báo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    ShowConnectionErrorScreen();
                });
            }
        }
        catch (Exception ex)
        {
            this.Invoke(() =>
            {
                MessageBox.Show("Lỗi thiết lập Docker tự động: " + ex.Message, "Thông Báo Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ShowConnectionErrorScreen();
            });
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions("--ignore-certificate-errors --allow-insecure-localhost");
            var env = await CoreWebView2Environment.CreateAsync(null, null, options);
            await webView.EnsureCoreWebView2Async(env);

            try
            {
                var localIps = GetLocalIPv4Addresses();
                var ipsJson = JsonSerializer.Serialize(localIps);
                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync($"window.__HOST_LAN_IPS__ = {ipsJson};");
            }
            catch { }

            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            webView.CoreWebView2.Settings.IsBuiltInErrorPageEnabled = false; // Tắt hoàn toàn màn hình lỗi mặc định của Edge để chống giật màn hình

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
                    if (msg == "retry_current" || msg == "retry_local")
                    {
                        webView.CoreWebView2.Navigate(currentServerUrl);
                    }
                    else if (msg == "open_settings")
                    {
                        ShowUnifiedSettingsDialog();
                    }
                    else if (msg == "open_backup_folder")
                    {
                        string backupDir = Path.Combine(currentStoragePath, "Backups");
                        if (!Directory.Exists(backupDir)) Directory.CreateDirectory(backupDir);
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = "explorer.exe",
                            Arguments = $"\"{backupDir}\"",
                            UseShellExecute = true
                        });
                    }
                    else if (msg == "trigger_backup")
                    {
                        _ = Task.Run(async () =>
                        {
                            await PerformExpiryBackupAsync(true);
                        });
                    }
                    else if (msg == "auto_setup_docker")
                    {
                        _ = Task.Run(async () =>
                        {
                            await StartDockerAutoSetupAsync();
                        });
                    }
                    else if (msg == "download_docker")
                    {
                        try
                        {
                            Process.Start(new ProcessStartInfo("https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe") { UseShellExecute = true });
                        }
                        catch { }
                    }
                    else if (msg == "launch_docker")
                    {
                        string dockerExe = @"C:\Program Files\Docker\Docker\Docker Desktop.exe";
                        if (File.Exists(dockerExe))
                        {
                            Process.Start(new ProcessStartInfo(dockerExe) { UseShellExecute = true });
                            MessageBox.Show("Đang mở Docker Desktop. Vui lòng đợi Docker khởi động hoàn tất (khoảng 20-30 giây) rồi bấm nút 'Thử Kết Nối Lại'.", "Khởi Động Docker", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                        else
                        {
                            MessageBox.Show("Không tìm thấy Docker Desktop tại đường dẫn mặc định.", "Thông Báo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                    }
                }
                catch { }
            };

            webView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                ApplyThemeToWebView();
                ApplyFontSizeToWebView();
                ApplyLanguageToWebView();
                InjectHostLanIps();

                if (e.IsSuccess)
                {
                    return;
                }

                if (!e.IsSuccess && !IsExpiredOrTampered())
                {
                    // Hiển thị ngay màn hình lỗi tùy chỉnh rõ ràng, không chạy vòng lặp ngầm tự reload gây chớp giật màn hình
                    ShowConnectionErrorScreen();
                }
            };

            if (IsExpiredOrTampered())
            {
                TriggerExpiryBackupIfNeeded();
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
        if (this.InvokeRequired)
        {
            try { this.Invoke(ApplyThemeToWebView); } catch { }
            return;
        }

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
        if (this.InvokeRequired)
        {
            try { this.Invoke(ApplyFontSizeToWebView); } catch { }
            return;
        }

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
        if (this.InvokeRequired)
        {
            try { this.Invoke(ApplyLanguageToWebView); } catch { }
            return;
        }

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

    private void InjectHostLanIps()
    {
        if (this.InvokeRequired)
        {
            try { this.Invoke(InjectHostLanIps); } catch { }
            return;
        }

        if (webView?.CoreWebView2 != null)
        {
            try
            {
                var ips = GetLocalIPv4Addresses();
                var json = JsonSerializer.Serialize(ips);
                string script = $"window.__HOST_LAN_IPS__ = {json}; " +
                                $"window.dispatchEvent(new CustomEvent('wms-host-ips', {{ detail: {{ ips: {json} }} }}));";
                webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }
    }

    public static string[] GetLocalIPv4Addresses()
    {
        var list = new List<string>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up ||
                    ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                {
                    continue;
                }

                var desc = (ni.Description ?? "").ToLowerInvariant();
                var name = (ni.Name ?? "").ToLowerInvariant();

                if (desc.Contains("virtual") || desc.Contains("pseudo") || desc.Contains("vethernet") ||
                    name.Contains("vethernet") || desc.Contains("bluetooth") || desc.Contains("hyper-v") ||
                    desc.Contains("wsl") || name.Contains("wsl") || desc.Contains("docker"))
                {
                    continue;
                }

                foreach (var ip in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ip.Address.AddressFamily == AddressFamily.InterNetwork)
                    {
                        var ipStr = ip.Address.ToString();
                        if (!ipStr.StartsWith("127.") && !ipStr.StartsWith("169.254."))
                        {
                            if (ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211)
                            {
                                list.Insert(0, ipStr);
                            }
                            else
                            {
                                list.Add(ipStr);
                            }
                        }
                    }
                }
            }
        }
        catch { }
        return list.Distinct().ToArray();
    }

    public static void EnsureFirewallRule()
    {
        try
        {
            using var check = Process.Start(new ProcessStartInfo
            {
                FileName = "netsh",
                Arguments = "advfirewall firewall show rule name=\"QuanLyKho WMS Web Server\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true
            });
            check?.WaitForExit();
            if (check?.ExitCode != 0)
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "netsh",
                    Arguments = "advfirewall firewall add rule name=\"QuanLyKho WMS Web Server\" dir=in action=allow protocol=TCP localport=443,80 profile=any",
                    Verb = "runas",
                    UseShellExecute = true,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                var p = Process.Start(psi);
                p?.WaitForExit(3000);
            }
        }
        catch { }
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
            Size = new Size(520, 260),
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
