# Kho Vật Tư

WMS tổ chức theo modular monolith/vertical slice, NestJS + Fastify, React + Ant Design và PostgreSQL 17. Kế hoạch được lưu tại [docs/wms_enhancement_plan.md](docs/wms_enhancement_plan.md).

Bản LAN trên máy hiện tại: **https://192.168.1.13**. Xem [hướng dẫn cài CA nội bộ](docs/LAN_CERTIFICATES.md) và [kết quả triển khai/kiểm chứng cùng các bước nghiệm thu còn lại](docs/IMPLEMENTATION_STATUS.md).

## Chạy trên máy Windows này

Yêu cầu Node.js 24 và Docker Desktop chạy Linux containers. Mở PowerShell tại thư mục dự án:

```powershell
./scripts/setup.ps1
npm run dev
```

Giao diện: **http://localhost:5173**. API: **http://localhost:3001/api/v1/health**. Tên đăng nhập và mật khẩu ban đầu nằm trong `.env` (`ADMIN_USERNAME`, `ADMIN_PASSWORD`); setup tự sinh giá trị ngẫu nhiên, không ghi đè file đã có. Không đưa `.env`, private key hoặc backup vào Git.

Máy hiện tại đã được khởi tạo; có thể mở giao diện ngay khi `npm run dev` đang chạy. Seed chỉ tạo kho MAIN, vị trí A-01 và quản trị viên; không tạo dữ liệu tồn giả và không thay mật khẩu người dùng đã có. Người quản trị tạo tài khoản thủ kho/chỉ xem trong màn hình **Người dùng**, cấp phạm vi kho tương ứng.

## Nghiệp vụ đã triển khai

- Danh mục sản phẩm, nhà cung cấp, vị trí; đăng nhập cookie HttpOnly, CSRF, Argon2id và RBAC/phạm vi kho.
- Nhập tồn đầu kỳ từ Excel/CSV cho kho chưa có giao dịch; hỗ trợ hàng hết hạn/cách ly và ghi ledger riêng.
- Quét nhập 1D, QR JSON, GS1 với AI được hỗ trợ; ghép pack/hạn dùng vào dòng đã chọn; draft có thể phục hồi, bỏ dòng trước khi ghi sổ.
- Điện thoại ghép bằng QR, camera web, hàng đợi sự kiện giữ ID khi retry, ACK sau commit, thu hồi và refresh pairing. Hàng đợi chỉ là mã chờ gửi, không phải ghi tồn offline.
- Phiếu xuất nhiều sản phẩm, giữ hàng FEFO, Ship khóa toàn bộ reservation/pack và kiểm tra lại hạn dùng/trạng thái; hủy phiếu giải phóng giữ chỗ.
- Dashboard, tra cứu tồn/quick filters; báo cáo hạn dùng, nhập-xuất-tồn theo kỳ, truy vết MES Pack và nhật ký ledger.
- Excel trình bày và streaming; mẫu import, ghép cột/profile, preview, lỗi theo dòng và xác nhận có idempotency.
- Docker LAN HTTPS, Redis adapter cho nhiều API instance, backup và restore drill vào database tách biệt.

Số dư chỉ có ở `stock_pack_balances`. Ledger chặn UPDATE/DELETE; sai sót sau ghi sổ phải xử lý bằng nghiệp vụ bù. Số lượng dùng đơn vị cơ sở nguyên dương, tối đa 10.000.000/pack. Ngày hết hạn được coi là hết hạn từ đầu ngày đó theo Asia/Ho_Chi_Minh.

## Import dữ liệu có sẵn

1. Tạo/import **nhà cung cấp → sản phẩm → vị trí** trước khi nhập tồn.
2. Chọn loại import và tải mẫu, hoặc dùng file `.xlsx`/CSV UTF-8 đang có. Mã hàng/lot/pack trong Excel phải lưu dạng Text.
3. Chọn sheet/hàng tiêu đề, ghép cột; chọn DMY/MDY rõ ràng nếu ngày không phải ISO. Kiểm tra dữ liệu và tải file lỗi để sửa.
4. Đối soát tổng theo đơn vị tính, giá trị trước/sau và cảnh báo. Xác nhận để ghi dữ liệu; preview không thay đổi tồn.

Giới hạn khởi đầu: **5 MB, 1.000 dòng dữ liệu/file**, tối đa 50 MB sau giải nén XLSX. File có công thức cần chuyển sang giá trị. Không tự dựng pack/lot/hạn dùng từ một bảng tổng tồn thiếu chi tiết.

Bản hiện tại xác nhận **toàn bộ file trong một transaction**, mạnh hơn mức nguyên vẹn từng chứng từ: nếu có lỗi thì toàn file rollback. Không có kết quả ghi một phần; file lớn phải tách trong giới hạn cấu hình. Mỗi kho chỉ chốt tồn chuyển đổi một lần, trong một file, trước giao dịch thường. Master data dùng version để chặn ghi đè sau preview. Cập nhật cấu hình ghép cột phải kiểm tra lại trước xác nhận.

## Excel và báo cáo

- Bản trình bày tối đa 5.000 dòng: có header, metadata, freeze, filter, màu cảnh báo, tổng theo đơn vị và layout in. Có thể cấu hình `COMPANY_LOGO_PATH` trỏ tới PNG của doanh nghiệp; chưa có logo thì dùng tên báo cáo bằng chữ. Trên 100 dòng có sheet Tổng quan đứng trước Chi tiết.
- Bản chi tiết tối đa 500.000 dòng, tối đa hai lượt đồng thời mỗi API process; cursor theo snapshot, commit từng dòng, xử lý hủy tải. Dùng độ rộng cột cố định; không chèn logo trong vùng ô theo streaming writer.
- Tổng hiển thị theo đơn vị dùng helper `SUBTOTAL` và `SUMIF`; workbook giữ cached result và yêu cầu tính lại khi mở. Cần nghiệm thu lọc/in bằng Excel/WPS thật tại kho.
- Nhập-xuất-tồn sử dụng ledger theo `[from,to)`, tách tồn chuyển đổi khỏi nhập mua hàng. Ngày đầu chuyển đổi bắt đầu từ đúng mốc chốt; lịch sử trước chuyển đổi không được suy ra từ tồn hiện tại.

## Kiểm thử

```powershell
npm run db:test
npm test
npm run build
npm run test:ui
npm run test:cluster
```

`npm test` chỉ chấp nhận database có hậu tố `_test`. Test có reset fixture trong database đó; **không chạy đồng thời** với `test:ui` hoặc benchmark vì dùng chung database kiểm thử. `test:ui` cần Chrome, tự chạy API/web trên 3002/5174 và kiểm tra import, FEFO, scan và XLSX bằng trình duyệt. Kết quả/chụp màn hình nằm trong `test-results/` và được bỏ qua bởi Git.

`test:cluster` dùng Redis kiểm thử ở cổng 63799, chạy hai API instance và xác minh scan/revoke qua Redis. `npm run benchmark` tạo 20.000 sản phẩm, 500.000 pack và 1.000.000 movement trong database `_test`, rồi đo 20 kết nối đồng thời; chỉ dùng khi không chạy các test khác.

## Triển khai LAN HTTPS

Chuẩn bị `deploy/certs/fullchain.pem` và `deploy/certs/privkey.pem` cho tên miền/IP thật; điện thoại phải tin cậy CA. Ưu tiên tên miền sở hữu của doanh nghiệp, DNS nội bộ và chứng chỉ DNS-01. Với CA nội bộ, cài **chứng chỉ gốc công khai** vào thiết bị và bật tin cậy đầy đủ theo hệ điều hành; giữ private key CA riêng trên máy chủ.

Thêm `LAN_ORIGIN=https://ten-mien-kho` vào `.env`, rồi:

```powershell
docker compose -f deploy/compose.lan.yml --env-file .env up -d --build
```

Compose LAN có database/volume **tách khỏi môi trường dev**; bootstrap tạo schema và quản trị viên, không copy tồn dev sang LAN. Chỉ Nginx công bố 443, PostgreSQL/API/Redis chỉ trong mạng container. Dùng IP cố định/DHCP reservation. Cần camera Android/iPhone thật để nghiệm thu HTTPS/âm thanh trước vận hành.

## Sao lưu và phục hồi

Trên máy chủ Windows, mở **`tools/CauHinhSaoLuu.cmd`**. Công cụ có nút **Chọn / tạo thư mục**, nhận đường dẫn ổ đĩa hoặc NAS, chọn môi trường LAN/dev và giờ sao lưu. **Lưu cấu hình và lịch** ghi lựa chọn vào `deploy/backup-settings.json`; **Backup ngay** và lịch hằng ngày đọc cùng cấu hình đó. Đường dẫn không được gắn cố định vào mã. Có thể tạo thư mục trực tiếp trong hộp thoại hoặc nhập đường dẫn thư mục mới rồi lưu. Tác vụ chạy ẩn bằng tài khoản Windows hiện tại khi đang đăng nhập; kết quả ở `deploy/backup-last.json`.

Nếu cần chạy lúc chưa đăng nhập, cấu hình tài khoản dịch vụ/Task Scheduler có quyền truy cập NAS phù hợp với chính sách máy chủ. Công cụ không lưu mật khẩu Windows/NAS vào file cấu hình.

```powershell
./scripts/backup.ps1 -Profile local -BackupDirectory 'D:\WMS-Backup'
./scripts/restore-drill.ps1 -Profile local -BackupFile 'D:\WMS-Backup\ten-file.dump'
```

Chọn `-Profile lan` cho Compose LAN. Backup tạo pg_dump custom format và SHA-256; restore drill chỉ tạo database mới có tên `wms_restore_*_test`, kiểm tra ledger/số dư/reservation rồi giữ lại để kiểm tra. Không xóa hoặc khôi phục đè database đang chạy.

Trên Ubuntu Server có `deploy/backup.sh` và `deploy/restore-drill.sh`; đặt `BACKUP_DIR` trên NAS/ổ độc lập, phân quyền và mã hóa bản sao theo quy trình doanh nghiệp. Cấu hình lịch chạy hằng ngày bằng Task Scheduler/cron sau khi chốt NAS và RPO; giám sát kết quả, dung lượng và diễn tập restore định kỳ. Bản sao chỉ nằm trên cùng máy chủ chưa đáp ứng mục tiêu phục hồi khi hỏng máy.

## Cloud Run

Image API nghe cổng từ `PORT`. Dùng Cloud SQL PostgreSQL và `REDIS_URL` trỏ Redis/Memorystore dùng chung; chạy migration bằng job riêng trước rollout. Client/server chỉ dùng WebSocket và reconnect; cấu hình request timeout 3600 giây, `WEB_ORIGIN` đúng frontend HTTPS và cookie Secure. Các replica phải dùng cùng DB và Redis để chuyển tiếp scan/thu hồi phiên.

Chưa tự triển khai hoặc tạo tài nguyên Google Cloud. Chứng chỉ/thiết bị, NAS, cấu hình Cloud SQL/Memorystore và chi phí vận hành phụ thuộc hạ tầng thực tế của doanh nghiệp.
