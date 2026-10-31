using System;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QuanLyKho;

public partial class Form1 : Form
{
    private WebView2 webView;
    private const string ServerUrl = "https://biological-candy-instruments-installations.trycloudflare.com";

    public Form1()
    {
        InitializeComponent();
        this.Text = "HỆ THỐNG QUẢN LÝ KHO (WMS) - BẢN TRẢI NGHIỆM";
        this.Size = new Size(1366, 850);
        this.MinimumSize = new Size(1024, 700);
        this.StartPosition = FormStartPosition.CenterScreen;

        InitializeWebView();
    }

    private async void InitializeWebView()
    {
        webView = new WebView2
        {
            Dock = DockStyle.Fill
        };
        this.Controls.Add(webView);

        try
        {
            var env = await CoreWebView2Environment.CreateAsync();
            await webView.EnsureCoreWebView2Async(env);

            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;

            // Tự động cấp quyền Camera khi quét mã
            webView.CoreWebView2.PermissionRequested += (s, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Camera)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                }
            };

            webView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                if (!e.IsSuccess)
                {
                    webView.CoreWebView2.NavigateToString(
                        "<html><body style='font-family:sans-serif;text-align:center;padding:100px 20px;background:#f8fafc;color:#1e293b;'>" +
                        "<div style='max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);'>" +
                        "<h1 style='color:#dc2626;margin-bottom:16px;'>⚠️ Phiên Trải Nghiệm Đã Hết Hạn</h1>" +
                        "<p style='font-size:16px;line-height:1.6;color:#475569;'>Không thể kết nối đến máy chủ quản lý kho. Phiên bản dùng thử nghiệm 3 ngày đã kết thúc hoặc máy chủ đang tạm ngắt.</p>" +
                        "<div style='margin-top:24px;padding:16px;background:#f1f5f9;border-radius:8px;font-size:15px;color:#0f172a;'>" +
                        "<b>Vui lòng liên hệ nhà phát triển để nghiệm thu và bàn giao bản quyền chính thức.</b>" +
                        "</div>" +
                        "</div>" +
                        "</body></html>"
                    );
                }
            };

            webView.CoreWebView2.Navigate(ServerUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Lỗi khởi tạo hệ thống: " + ex.Message, "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
