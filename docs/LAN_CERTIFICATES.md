# HTTPS nội bộ cho kho

Máy chủ hiện tại phục vụ WMS tại **https://192.168.1.13**. Địa chỉ này nằm trong `.env` (`LAN_ORIGIN`), chứng chỉ có SAN cho IP đó, localhost và `wms.internal`. Thiết bị phải ở mạng truy cập được máy chủ. Nếu IP đổi, cần cấp lại chứng chỉ và sửa cấu hình; nên dùng DHCP reservation/IP cố định.

Chứng chỉ gốc công khai để cài lên máy trạm/điện thoại: **`deploy/certs/rootCA.cer`** hoặc `rootCA.pem`. Tên CA là **QuanLyKho Internal Root CA**. Private key CA nằm trong `deploy/pki`, không đưa vào điện thoại hoặc mount vào Nginx.

## Windows

Mở `rootCA.cer`, chọn **Install Certificate**, chọn phạm vi Current User và kho **Trusted Root Certification Authorities** theo quy trình quản trị thiết bị. Sau khi cài, mở lại trình duyệt và truy cập đúng URL HTTPS ở trên.

## Android

Chuyển file chứng chỉ công khai vào thiết bị, mở mục cài chứng chỉ trong phần bảo mật/thông tin xác thực và chọn chứng chỉ CA. Tên menu tùy hãng và phiên bản Android. Xem [hướng dẫn của Google](https://support.google.com/pixelphone/answer/2844832). Sau khi thiết bị tin cậy CA, mở WMS bằng Chrome và quét QR ghép nối từ PC.

## iPhone và iPad

Cài profile chứa chứng chỉ công khai, sau đó vào **Settings → General → About → Certificate Trust Settings** và bật tin cậy đầy đủ cho **QuanLyKho Internal Root CA**. Profile cài thủ công chưa tự động được tin cậy cho SSL; xem [hướng dẫn của Apple](https://support.apple.com/en-us/102390). Mở WMS bằng Safari và cho phép camera khi bắt đầu quét.

## Nghiệm thu tại kho

- Truy cập đúng địa chỉ HTTPS, không có lỗi chứng chỉ sau khi đã cài CA.
- Tạo phiếu nhập trên PC, ghép điện thoại bằng QR; camera nhận mã và chỉ phát bíp sau ACK.
- Quét 1D, bổ sung pack/2D và ngày theo tem; PC cập nhật đúng dòng.
- Tắt Wi-Fi khi quét: không có bíp thành công, mã chờ còn trên thiết bị; nối lại và retry không tạo thêm dòng.
- Thu hồi phiên trên PC: điện thoại bị ngắt và không được refresh hoặc gửi thêm mã.

Kiểm tra tự động đã xác minh TLS chain/SAN bằng CA này qua `npm run check:lan`. Quyền camera, âm thanh, rung và độ đọc tem cần thiết bị Android/iPhone thật; chưa được xác nhận bởi kiểm thử desktop.
