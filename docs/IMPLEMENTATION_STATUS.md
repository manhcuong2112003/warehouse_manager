# Trạng thái triển khai WMS

Ngày kiểm tra: 31/10/2026. Nguồn thiết kế: `docs/wms_enhancement_plan.md` phiên bản 2.4; bổ sung công cụ chọn/tạo thư mục backup theo yêu cầu trong chat.

## Phần đã có

| Phần           | Kết quả                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation     | Monorepo NestJS/Fastify + React/Ant Design; migrations PostgreSQL 17; tài khoản, scope kho và CSRF.                                         |
| Inventory Core | Số dư theo pack, reservation duy nhất theo dòng/pack active, ledger bất biến; receive/reserve/ship/cancel và idempotency trong transaction. |
| Nhập/quét      | Parser có số 0 đầu/giới hạn số; scan events tách draft lines; merge theo ID, archive dòng, ACK sau commit, replay so request hash.          |
| Điện thoại     | QR ghép nối, camera, hàng đợi ID ổn định qua mất mạng, refresh/revoke pairing; Redis chuyển tiếp nhiều instance.                            |
| Import         | XLSX/CSV UTF-8, mẫu/ghép cột/profile, preview trước/sau, file lỗi, version kiểm tra lại, nhập tồn đầu kỳ/phiếu nhập và lịch sử nguồn.       |
| Báo cáo        | Dashboard, bộ lọc, 4 báo cáo; NXT từ ledger, tách tồn vật lý/khả dụng và tổng theo UOM.                                                     |
| Excel          | Bản trình bày/streaming, mã Text, date/number thật, filter/freeze, conditional formatting, tổng khi lọc.                                    |
| Vận hành       | Compose HTTPS LAN đang chạy; CA nội bộ; script backup/restore, công cụ WinForms chọn/tạo thư mục và lịch Task Scheduler theo cấu hình.      |

Kho làm việc không được seed tồn giả. Dữ liệu kiểm thử và benchmark chỉ dùng `wms_test`; Compose LAN dùng volume riêng với dev.

## Quyết định triển khai cụ thể

- Reserve dùng blocking row lock theo thứ tự ổn định để giữ thứ tự FEFO thay vì bỏ qua pack đang bị khóa bằng `SKIP LOCKED`. Ship khóa toàn bộ reservation/pack, gộp lượng theo pack và commit cùng ledger/trạng thái.
- Scan khóa draft rồi ghi event + dòng + kết quả ACK trong một transaction. Unique conflict được xử lý sau rollback; không đọc tiếp trong transaction đã abort.
- Import MVP giới hạn 5 MB/1.000 dòng, toàn file atomic; XLSX sau giải nén tối đa 50 MB. Bản hiện tại chưa chạy file nhiều chứng từ theo chế độ commit một phần.
- Tồn đầu kỳ chỉ chốt một lần ở kho chưa có giao dịch; mốc được chốt tại transaction xác nhận. Lịch sử trước chuyển đổi cần migration riêng.
- Excel trình bày tối đa 5.000 dòng; chi tiết 500.000 dòng và 2 lượt/process. Logo PNG tùy cấu hình; streaming không chèn logo vùng ô. Biểu đồ dashboard dùng phần tử web nhẹ, chưa nhúng biểu đồ Excel.
- Công cụ backup lưu thư mục người dùng chọn; chưa chọn thì không tự ghi vào một đích mặc định. Lịch chạy bằng tài khoản Windows hiện tại khi đăng nhập; môi trường luôn bật cần tài khoản dịch vụ hoặc cron phù hợp.

## Kiểm chứng tự động

- PostgreSQL thật: 20 luồng giữ hàng, FEFO nhiều pack/all-or-nothing, Ship/retry, hết hạn sau giữ, đổi QUARANTINE cạnh tranh, ledger append-only và đối soát.
- Scan: 1D chưa đủ vẫn lưu, merge 2D, event replay, trùng pack đồng thời, ID dòng cho hàng đợi, token sai scope/revoke/phiên PC hết hạn.
- Import: preview không ghi tồn, chuyển đổi tồn hết hạn thành EXPIRED, confirm/retry không tạo thêm movement.
- Báo cáo: tồn đầu 100 + nhập 20 - xuất 30 = tồn cuối 90; hàng cách ly/hết hạn vẫn tính tồn vật lý nhưng không khả dụng.
- Chrome: đăng nhập, tạo danh mục, import 100, xuất 30, quét nhập 10; tồn và ledger khớp 80, XLSX hai chế độ mở lại được và giữ mã Text/freeze. Có kiểm tra CSRF, VIEWER và scope kho.
- Hai instance thực: phone ở B phát scan và ACK, PC ở A nhận thay đổi qua Redis; revoke ở A ngắt phone ở B và từ chối refresh.
- Export 100.000 dòng: các lần đo 8.781–19.069 ms tùy tải máy; RSS peak khoảng 326–350 MB, mức tăng 187–237 MB. Mở lại đủ 100.006 hàng gồm tiêu đề/tổng; test hủy xuất giải phóng kết nối. Hai lượt 100.000 dòng đồng thời với đầu nhận chậm 50 ms/chunk truyền tổng 18.891.410 byte, RSS peak 402 MB; lượt thứ ba bị từ chối bằng `EXPORT_BUSY`. Không diễn giải thành chỉ dùng vài MB.
- Restore drill: 100.000 pack và 100.000 movement khôi phục vào DB mới; số pack lệch ledger và reservation đều bằng 0. Không restore đè database đang dùng.
- Backup runner đọc thư mục tự chọn có dấu từ JSON và tạo dump/checksum thành công; hộp thoại WinForms kiểm tra khởi tạo được. Việc người dùng duyệt thư mục và đăng ký lịch bằng giao diện cần kiểm tra trong phiên desktop tương tác của máy chủ.

## Benchmark tìm kiếm

20.000 sản phẩm, 500.000 pack, 1.000.000 movement; 20 kết nối, 400 mẫu, cache ấm, sau VACUUM/ANALYZE để flush GIN pending list. Đo trên workstation Windows/Docker hiện tại, không đại diện chứng nhận máy chủ 4 core/8 GB.

| Phép đo                                 | p95 (ms) | p99 (ms) |
| --------------------------------------- | -------: | -------: |
| Exact SQL (planning + execution)        |     0,13 |     0,15 |
| Trigram SQL (planning + execution)      |     2,28 |     4,01 |
| Exact DB roundtrip qua driver/network   |     7,29 |    58,17 |
| Trigram DB roundtrip qua driver/network |     9,18 |    11,47 |
| API sản phẩm/từ khóa                    |    45,06 |    79,92 |
| API tồn theo MES Pack chính xác         |    23,84 |    29,37 |
| API tồn theo Part No chính xác          |    33,08 |    36,27 |

Ngưỡng 2/15 ms trong phép đo này áp dụng cho thực thi SQL trên server, không phải roundtrip Windows–Docker. API đã đo đạt p95 < 50 ms. Lần đo ngay sau bulk seed trong lúc build container từng vượt ngưỡng; cần kiểm tra thêm tải ghi/đọc hỗn hợp và cold cache trên máy chủ nghiệm thu. Chạy lại bằng `npm run benchmark`; `-- --reuse` chỉ dùng khi fixture BENCH vẫn còn nguyên. Không chạy đồng thời với core/UI/cluster tests.

## Các bước còn cần nghiệm thu thực tế

1. Cài CA công khai lên PC/Android/iPhone theo `docs/LAN_CERTIFICATES.md`; kiểm tra camera, âm thanh/rung và tem thực tế.
2. Mở Excel/WPS thật để kiểm tra conditional formatting, công thức tổng sau lọc và bản in. Kiểm tra tự động hiện dùng ExcelJS để đọc lại cấu trúc/nội dung file.
3. Chọn NAS/ổ độc lập bằng công cụ backup, lưu lịch và xác nhận tác vụ thực chạy bằng đúng tài khoản/quyền của máy chủ; chưa tự đăng ký lịch khi chưa có lựa chọn đích.
4. Audit dependency hiện còn cảnh báo mức moderate trong chuỗi phụ thuộc ExcelJS (glob/archiver/uuid/rimraf); không có high/critical trong lần audit đã chạy. Cần chốt cách xử lý trước go-live; không ép downgrade ExcelJS hoặc override major thiếu kiểm chứng để làm sạch số cảnh báo.
5. Cloud Run/Cloud SQL/Memorystore có cấu hình/container và kiểm thử đa instance cục bộ; chưa tạo tài nguyên hoặc triển khai lên Google Cloud.
