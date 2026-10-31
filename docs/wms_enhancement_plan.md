# KẾ HOẠCH THIẾT KẾ & TRIỂN KHAI HỆ THỐNG WMS (LAN-FIRST + CLOUD-READY)

> **Tài liệu tham chiếu gốc:** `WMS_LAN_HLD_Architecture.docx`  
> **Phiên bản:** 2.4 (Bổ sung xuất Excel dễ đọc, import file có sẵn, tồn đầu kỳ và nghiệm thu dữ liệu)  
> **Thời gian:** 31/10/2026

---

## 1. NGUYÊN TẮC THIẾT KẾ CỐT LÕI (CORE PRINCIPLES)

1. **Single Source of Truth (SSOT) cho số dư:** Đơn vị hạt nhân là **`stock_pack_balances`** (mỗi cuộn/thùng tương ứng 1 dòng). Bảng này là nơi duy nhất giữ `on_hand` và `reserved`.
2. **Quy trình Quét & Ghép Dòng 2 Bước (Multi-Scan Line Lifecycle):** Tách biệt bảng *Sự kiện quét (Scan Events)* và *Dòng phiếu nháp (Draft Lines)*. Cho phép dòng lưu tạm ở trạng thái chờ bổ sung mã pack (`AWAITING_PACK_SCAN`) với `draft_line_id` rõ ràng để không ghép nhầm bao bì.
3. **FEFO 2 Lớp với Khóa Toàn Phần (Full-Lock FEFO):** Khóa thực tế toàn bộ các pack liên quan (`FOR UPDATE`) cả khi Reserve lẫn khi Ship, loại trừ hoàn toàn race condition khi pack bị đổi trạng thái giữa chừng.
4. **Báo cáo và Excel thống nhất số liệu:** Dashboard và file xuất dùng cùng định nghĩa tồn vật lý, giữ chỗ, khả dụng và mốc dữ liệu. Tổng số lượng được tách theo đơn vị tính; báo cáo theo kỳ lấy từ ledger.
5. **Hai chế độ xuất Excel:** Bản trình bày có logo, tóm tắt và định dạng để đọc/in; bản dữ liệu chi tiết lớn dùng `exceljs` streaming với độ rộng cột định trước và định dạng phù hợp khả năng thư viện.
6. **Import có kiểm tra và xem trước:** Hỗ trợ mẫu chuẩn và ghép cột từ file có sẵn; tải file chỉ tạo dữ liệu staging, chưa thay đổi tồn kho. Chỉ ghi dữ liệu sau khi người có quyền kiểm tra và xác nhận.
7. **Import tồn qua Inventory Core:** Tồn đầu kỳ và phiếu nhập phải tạo chứng từ, ledger và số dư trong transaction có idempotency; retry không làm tăng tồn lần hai. Kiểm thử được thực hiện ngay tại phase triển khai tương ứng.
---

## 2. THIẾT KẾ DỮ LIỆU & QUY TRÌNH XUẤT KHO FEFO CHẶT CHẼ

### 2.1. Cấu trúc bảng hạt nhân
```sql
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    part_no VARCHAR(100) UNIQUE NOT NULL,
    specification VARCHAR(255) NOT NULL,
    po_type VARCHAR(50),
    vendor_part_no VARCHAR(100),
    default_vendor_code VARCHAR(50),
    base_uom VARCHAR(20) DEFAULT 'PCS',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stock_pack_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    location_id UUID NOT NULL REFERENCES locations(id),
    lot_no VARCHAR(100) NOT NULL,
    mes_pack_no VARCHAR(100) UNIQUE NOT NULL,
    vendor_code VARCHAR(50) NOT NULL,
    mfg_date DATE,
    expired_date DATE NOT NULL,
    on_hand BIGINT NOT NULL DEFAULT 0,
    reserved BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(30) DEFAULT 'AVAILABLE',      -- AVAILABLE, QUARANTINE, EXPIRED, LOCKED
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_pack_qty CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
);

CREATE TABLE stock_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbound_line_id UUID NOT NULL,
    pack_balance_id UUID NOT NULL REFERENCES stock_pack_balances(id),
    quantity BIGINT NOT NULL,
    status VARCHAR(30) DEFAULT 'ACTIVE',        -- ACTIVE, SHIPPED, RELEASED
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pack_balance_id UUID NOT NULL REFERENCES stock_pack_balances(id),
    product_id UUID NOT NULL REFERENCES products(id),
    location_id UUID NOT NULL REFERENCES locations(id),
    quantity_delta BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    movement_type VARCHAR(50) NOT NULL,
    reference_type VARCHAR(50) NOT NULL,
    reference_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 2.2. Quy trình Xuất kho FEFO 2 Lớp (Đã sửa lỗi khóa khi Ship)

#### Lớp 1: Phân bổ và Giữ hàng FEFO (Reserve Stock)
```sql
CREATE OR REPLACE FUNCTION reserve_stock_fefo(
    p_product_id UUID,
    p_required_qty BIGINT,
    p_outbound_line_id UUID
) RETURNS TABLE(pack_id UUID, allocated_qty BIGINT) AS $$
DECLARE
    v_remaining_qty BIGINT := p_required_qty;
    v_pack RECORD;
    v_alloc BIGINT;
    v_today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE;
BEGIN
    FOR v_pack IN
        SELECT id, (on_hand - reserved) AS available_qty
        FROM stock_pack_balances
        WHERE product_id = p_product_id
          AND status = 'AVAILABLE'
          AND expired_date > v_today
          AND (on_hand - reserved) > 0
        ORDER BY expired_date ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
    LOOP
        IF v_remaining_qty <= 0 THEN EXIT; END IF;

        v_alloc := LEAST(v_pack.available_qty, v_remaining_qty);

        UPDATE stock_pack_balances
        SET reserved = reserved + v_alloc,
            version = version + 1,
            updated_at = NOW()
        WHERE id = v_pack.id;

        INSERT INTO stock_reservations (outbound_line_id, pack_balance_id, quantity, status)
        VALUES (p_outbound_line_id, v_pack.id, v_alloc, 'ACTIVE');

        v_remaining_qty := v_remaining_qty - v_alloc;
        pack_id := v_pack.id;
        allocated_qty := v_alloc;
        RETURN NEXT;
    END LOOP;

    IF v_remaining_qty > 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK: Thieu % san pham kha dung con han', v_remaining_qty;
    END IF;
END;
$$ LANGUAGE plpgsql;
```

#### Lớp 2: Kiểm tra lại & Khóa toàn phần lúc Xuất kho thực tế (Ship Verification)
```sql
BEGIN;

-- 1. Khóa toàn bộ các reservation và pack tương ứng
SELECT sr.id AS reservation_id, spb.id AS pack_id, spb.status, spb.expired_date, spb.on_hand, spb.reserved, sr.quantity
FROM stock_reservations sr
JOIN stock_pack_balances spb ON sr.pack_balance_id = spb.id
WHERE sr.outbound_line_id = :outbound_line_id
  AND sr.status = 'ACTIVE'
FOR UPDATE OF spb, sr;

-- 2. Thẩm định trong ứng dụng:
-- Kiểm tra nếu tồn tại bất kỳ pack nào có status != 'AVAILABLE' -> ROLLBACK với 'PACK_NOT_AVAILABLE'
-- Kiểm tra nếu tồn tại pack có expired_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE
-- -> ROLLBACK với 'EXPIRED_DURING_RESERVATION'

-- 3. Cập nhật số dư và kiểm tra số lượng dòng cập nhật khớp 100%
WITH updated_packs AS (
    UPDATE stock_pack_balances spb
    SET on_hand = spb.on_hand - sr.quantity,
        reserved = spb.reserved - sr.quantity,
        version = spb.version + 1,
        updated_at = NOW()
    FROM stock_reservations sr
    WHERE sr.outbound_line_id = :outbound_line_id
      AND sr.pack_balance_id = spb.id
      AND sr.status = 'ACTIVE'
      AND spb.status = 'AVAILABLE'
      AND spb.expired_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE
    RETURNING spb.id
)
SELECT COUNT(*) FROM updated_packs;
-- NẾU COUNT(*) != số reservation dự kiến -> ROLLBACK TOÀN PHIẾU!

-- 4. Đóng reservation và ghi sổ cái bất biến stock_movements
UPDATE stock_reservations 
SET status = 'SHIPPED', updated_at = NOW() 
WHERE outbound_line_id = :outbound_line_id AND status = 'ACTIVE';

COMMIT;
```

---

## 3. THIẾT KẾ TÁCH BIỆT SCAN EVENTS & DRAFT LINES (HỖ TRỢ MÃ 1D)

```sql
CREATE TABLE inbound_scan_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id UUID NOT NULL REFERENCES inbound_drafts(id),
    scan_event_id UUID NOT NULL,
    pairing_id UUID NOT NULL,
    raw_payload TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_scan_event UNIQUE (draft_id, scan_event_id)
);

CREATE TABLE inbound_draft_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id UUID NOT NULL REFERENCES inbound_drafts(id),
    line_number INT NOT NULL,
    product_id UUID NOT NULL REFERENCES products(id),
    lot_no VARCHAR(100) NOT NULL,
    quantity BIGINT NOT NULL,
    vendor_code VARCHAR(50) NOT NULL,
    po_type VARCHAR(50),
    mes_pack_no VARCHAR(100),                 -- NULL khi mới chỉ quét mã 1D
    expired_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'AWAITING_PACK_SCAN',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_draft_line_mes_pack UNIQUE (draft_id, mes_pack_no)
);
```

---

## 4. BẢO MẬT PHIÊN GHÉP NỐI & XỬ LÝ XUNG ĐỘT NGUYÊN TỬ

1. **Quản lý phiên ghép nối (`scanner_pairings`):** Mọi sự kiện quét và yêu cầu refresh token bắt buộc kiểm tra `pairing_id` có `status = 'ACTIVE'` và chưa quá hạn.
2. **Xử lý xung đột nguyên tử (Atomic Conflict):** Bắt trực tiếp mã lỗi PostgreSQL `23505`:
   - Vi phạm `uq_scan_event` $\rightarrow$ Trả `ACCEPTED_IDEMPOTENT` kèm dữ liệu cũ.
   - Vi phạm `uq_draft_line_mes_pack` $\rightarrow$ Ném lỗi `DUPLICATE_PACK_SCANNED`.

---

## 5. MODULE BÁO CÁO, XUẤT EXCEL VÀ IMPORT DỮ LIỆU CÓ SẴN

### 5.1. Dashboard và định nghĩa số liệu dùng chung

Dashboard dùng Recharts hoặc Chart.js, hiển thị tổng quan và cho phép mở báo cáo chi tiết bằng cùng bộ lọc kho, vị trí, sản phẩm và nhà cung cấp.

* **Tồn vật lý (`on_hand`):** Bao gồm số lượng đang ở trong kho ở mọi trạng thái, kể cả `QUARANTINE`, `LOCKED` và `EXPIRED`.
* **Giữ chỗ (`reserved`):** Tổng số lượng đã giữ cho đơn xuất. Báo cáo có thể phân tích thêm phần reservation trên hàng không còn đủ điều kiện xuất.
* **Khả dụng để xuất:** Chỉ cộng `on_hand - reserved` của pack có `status = 'AVAILABLE'` và `expired_date > ngày kho tại mốc báo cáo`.
* **Số pack đang tồn:** Chỉ đếm pack có `on_hand > 0`; không đếm pack đã hết tồn vào KPI tồn kho.
* **Đơn vị tính:** Tổng số lượng tách theo `base_uom`; không cộng PCS, mét hoặc các đơn vị khác thành một tổng. Số pack được trình bày riêng, không suy từ một định mức đóng gói giả định.
* **Mốc dữ liệu:** UI và file xuất ghi rõ `as_of`, múi giờ kho `Asia/Ho_Chi_Minh` và phạm vi lọc. Bảng chi tiết, KPI và tổng cộng trong cùng báo cáo phải lấy từ một snapshot nhất quán.

Cảnh báo hạn dùng chỉ tính pack còn tồn. `Ngày còn lại = expired_date - ngày kho tại as_of`: đỏ khi `<= 0`, cam khi `1..30`, vàng khi `31..90`, an toàn khi `> 90`. Mỗi màu luôn kèm chữ trạng thái. Báo cáo lịch sử giữ ngày đánh giá theo `as_of`, không dùng `TODAY()` để tự đổi kết quả khi mở file vào ngày khác.

Biểu đồ gồm nhập/xuất theo ngày và phân bổ tồn theo nhà cung cấp hoặc vị trí. Nhập/xuất lấy từ chứng từ đã ghi sổ; số lượt scan hiển thị riêng và không được dùng thay cho số lượng nhập kho.

### 5.2. Bốn báo cáo kho và nguồn tính toán

| Báo cáo | Nội dung và nguồn dữ liệu |
| :--- | :--- |
| Nhập - Xuất - Tồn theo kỳ | Tồn đầu kỳ, nhập, xuất, điều chỉnh/chuyển kho và tồn cuối kỳ từ ledger đã ghi sổ, theo sản phẩm, kho/vị trí và đơn vị tính. |
| Hạn sử dụng và tuổi hàng | Pack còn tồn, hạn dùng, ngày còn lại tại `as_of`, trạng thái và số lượng cần xử lý. |
| Truy vết Lot/MES Pack | Chuỗi chứng từ nhập, xuất, chuyển, điều chỉnh và tồn hiện tại của pack; giữ liên kết nguồn import nếu có. |
| Nhật ký biến động | Ledger bất biến, thời điểm ghi sổ, loại nghiệp vụ, delta, tồn sau, chứng từ và người thực hiện. |

**Quy tắc báo cáo theo kỳ:** Dùng khoảng `[from, to)` theo múi giờ kho; chuyển sang timestamp để truy vấn. Tồn đầu kỳ là số dư ledger tại đầu kỳ, đã bao gồm tồn chuyển đổi đúng một lần. `Tồn cuối = Tồn đầu + Nhập - Xuất + Điều chỉnh ròng + Chuyển kho ròng`. Phân loại chuyển kho theo phạm vi báo cáo; chuyển nội bộ trong cùng phạm vi có tác động ròng bằng 0. Bút toán `OPENING_BALANCE` là số dư chuyển đổi, không tính thành nhập mua hàng trong kỳ. Giai đoạn đầu chỉ cho báo cáo tồn theo kỳ từ mốc chuyển đổi đã chốt; không suy diễn lịch sử trước mốc từ số dư hiện tại.

View sau chỉ phục vụ **tồn hiện tại**, không thay thế truy vấn ledger theo kỳ. Backend áp dụng quyền và phạm vi kho trước khi tổng hợp; view minh họa giữ `warehouse_id` để hỗ trợ điều đó:

```sql
CREATE OR REPLACE VIEW view_inventory_summary AS
SELECT
    l.warehouse_id,
    p.id AS product_id,
    p.part_no,
    p.specification,
    p.base_uom,
    SUM(spb.on_hand) AS total_on_hand,
    SUM(spb.reserved) AS total_reserved,
    COALESCE(SUM(spb.on_hand - spb.reserved) FILTER (
        WHERE spb.status = 'AVAILABLE'
          AND spb.expired_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE
    ), 0) AS total_available,
    COUNT(*) FILTER (WHERE spb.on_hand > 0) AS total_packs
FROM stock_pack_balances spb
JOIN products p ON p.id = spb.product_id
JOIN locations l ON l.id = spb.location_id
GROUP BY l.warehouse_id, p.id, p.part_no, p.specification, p.base_uom;
```

Danh mục chưa có tồn được ghép ở read model khi cần hiển thị số 0; không tạo pack giả để đưa sản phẩm vào báo cáo. Đối với báo cáo tại mốc quá khứ, phải dùng read model/ledger phù hợp, không áp dụng view hiện tại rồi đổi nhãn thời gian.

### 5.3. Thiết kế file Excel dễ đọc

Báo cáo ngắn dùng một sheet, phần tóm tắt nằm trên bảng. Báo cáo dài có hai sheet **Tổng quan** và **Chi tiết**; chỉ thêm sheet khi có mục đích sử dụng riêng.

| Thành phần | Quy chuẩn |
| :--- | :--- |
| Đầu báo cáo | Tên doanh nghiệp, tên báo cáo, kho, kỳ hoặc `as_of`, bộ lọc, người lập và thời điểm tạo file. Logo áp dụng cho bản trình bày. |
| Tóm tắt | Tổng pack, tồn vật lý, giữ chỗ, khả dụng và hàng hết hạn; số lượng tách theo đơn vị tính. |
| Tiêu đề cột | Nền navy `#1F4E78`, chữ trắng, đậm; font Calibri/Segoe UI cỡ 11-12 cho dữ liệu. |
| Dòng dữ liệu | Xen kẽ trắng/xanh rất nhạt, viền mảnh; không gộp ô trong vùng bảng cần lọc. |
| Cuộn và lọc | Freeze hàng tiêu đề và cột nhận diện phù hợp; Auto-filter; tổng theo phần dữ liệu đang lọc bằng `SUBTOTAL` hoặc cơ chế tương đương đã kiểm chứng. |
| Mã hàng/lot/pack/vendor | Giá trị chuỗi và định dạng Text (`@`) để giữ số 0 đầu, mã dài; không chuyển mã sang kiểu số. |
| Số lượng và ngày | Số lượng là số thật với `#,##0`; ngày là giá trị ngày hợp lệ với `yyyy-mm-dd`, không chỉ là chuỗi đã tô định dạng. |
| Cảnh báo | Màu kèm chữ; rule đỏ `<= 0`, cam `1..30`, vàng `31..90` không chồng lấn. |
| Độ rộng cột | Bản trình bày tính độ rộng có giới hạn tối đa và wrap text; bản streaming dùng độ rộng định trước hoặc tính trước từ cùng snapshot. |
| In giấy | A4 ngang, lặp hàng tiêu đề, vừa một trang theo chiều rộng; cho phép nhiều trang theo chiều dọc, có số trang. |

**Hai chế độ xuất:**

1. **Xuất báo cáo trình bày:** Dùng document workbook của `exceljs`, có logo trong vùng ô, tóm tắt và biểu đồ nếu công cụ đã được kiểm chứng hỗ trợ. Có giới hạn dung lượng/số dòng được quyết định bằng benchmark; file vượt giới hạn được hướng dẫn dùng chế độ chi tiết.
2. **Xuất dữ liệu chi tiết:** Dùng streaming writer, có tiêu đề bằng chữ, metadata, bộ lọc, freeze panes, định dạng số/ngày và độ rộng cột đã chốt. Không yêu cầu chèn logo vào vùng ô hoặc auto-fit sau khi đã stream dữ liệu. Không quảng bá hai chế độ có tính năng định dạng hoàn toàn giống nhau.

Tham chiếu triển khai: [ExcelJS Images](https://github.com/exceljs/exceljs#images) và [Streaming XLSX Writer](https://github.com/exceljs/exceljs#streaming-xlsx-writer); chốt phiên bản thư viện và kiểm chứng các tính năng định dạng trên phiên bản đó.

Đoạn khởi tạo đúng API streaming, nhận `Writable` để không phụ thuộc HTTP adapter Express/Fastify:

```typescript
import * as ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';

function createDetailWriter(destination: Writable) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: destination,
    useStyles: true,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet('Chi tiet', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 5 }],
  });
  // Thiết lập metadata ở dòng 1-4, tiêu đề cột ở dòng 5 và độ rộng trước khi commit dòng đầu.
  return { workbook, sheet };
}
```

Đây là đoạn khởi tạo, không phải endpoint hoàn chỉnh. Khi triển khai phải đọc DB bằng cursor theo snapshot nhất quán, commit từng dòng, cuối cùng commit sheet/workbook; áp dụng backpressure hoặc giới hạn buffer qua các tầng DB/ZIP/HTTP. Khi client hủy tải, phải hủy đọc cursor, giải phóng kết nối và dừng xử lý export. Xử lý lỗi stream trước/sau khi đã gửi response; không trả file XLSX dở dang như một kết quả thành công. File lớn hoặc tác vụ kéo dài có thể chạy dưới dạng export job có trạng thái và tải xuống sau.

### 5.4. Import file mẫu và dữ liệu có sẵn

MVP hỗ trợ `.xlsx` và CSV UTF-8. File Excel cũ `.xls` được yêu cầu lưu lại thành `.xlsx`. Có hai cách bắt đầu: **Tải mẫu chuẩn** hoặc **Chọn file đang có và ghép cột**.

| Loại import | Dữ liệu và kết quả |
| :--- | :--- |
| Danh mục hàng | Part No, tên/quy cách, đơn vị tính, nhà cung cấp; tạo mới hoặc cập nhật theo khóa đã chọn, xem giá trị trước/sau. Không cập nhật số dư qua danh mục. |
| Vị trí và nhà cung cấp | Mã kho/vị trí, mã và tên nhà cung cấp; kiểm tra trùng và khóa tham chiếu trước khi dùng trong nhập tồn. |
| Tồn đầu kỳ | Part No, kho/vị trí, lot, MES Pack No, vendor, số lượng, hạn dùng, trạng thái và mốc chuyển đổi; tạo chứng từ chuyển đổi cùng ledger `OPENING_BALANCE`. |
| Phiếu nhập hàng | Mã chứng từ nguồn, dòng nguồn và dữ liệu pack; tạo phiếu nhập nháp để kiểm tra, sau đó xác nhận qua Inbound/Inventory Core. |

**Mẫu chuẩn:** Sheet `Du lieu` là bảng phẳng với header cố định và tên trường bắt buộc rõ ràng; kèm hướng dẫn ngắn và dòng ví dụ được đánh dấu để không nhập nhầm. Chỉ thêm sheet danh mục tra cứu khi cần dropdown mã kho, vị trí, đơn vị hoặc trạng thái. Mẫu có `template_version`, cột mã được định dạng Text, số lượng là số, ngày hiển thị `yyyy-mm-dd`. Mẫu import và file báo cáo có mục đích riêng; chọn file báo cáo để nhập vẫn phải đi qua ghép cột và validation, không tự hiểu tổng cộng là dòng hàng.

**Nhập từ file cũ:** Cho chọn sheet, hàng tiêu đề, vùng dữ liệu; xem trước dữ liệu gốc. Người dùng ghép cột, ví dụ `Mã vật tư -> part_no`, `Số cuộn -> mes_pack_no`, `SL tồn -> quantity`, `HSD -> expired_date`. Lưu profile ghép cột theo người dùng/đơn vị và loại import, kiểm tra lại khi cấu trúc file thay đổi. Cho chọn quy tắc ngày và dấu phân cách số; ngày mơ hồ phải được xác nhận, không tự đoán.

**Luồng xử lý:**

```text
Chọn loại nhập -> Tải file -> Chọn sheet/header/vùng dữ liệu -> Ghép cột
-> Kiểm tra dữ liệu -> Xem trước và tải file lỗi -> Xác nhận -> Theo dõi kết quả
```

1. **Tải file:** Chỉ tạo staging/import job; chưa tạo stock balance hay movement. Giới hạn dung lượng, số dòng và quyền truy cập phải được cấu hình và công bố trên UI.
2. **Chuẩn hóa và kiểm tra:** Kiểm tra trường bắt buộc, mã tham chiếu, trùng trong file/DB, số lượng nguyên dương trong giới hạn nghiệp vụ, đơn vị tính và ngày hợp lệ. Dòng tồn bằng 0 được hiển thị là không tạo pack, cần được người dùng nhìn thấy trước khi xác nhận. Đọc ngày Excel theo metadata/date system của workbook; giữ giá trị mã dạng chuỗi. Mã đã mất số 0 hoặc bị làm tròn trong file nguồn phải được báo để sửa, không tự tái tạo. Công thức được báo để người dùng chuyển thành giá trị; backend không thực thi công thức/macro từ file nhập.
3. **Xem trước:** Hiển thị dòng hợp lệ/lỗi/trùng, tạo mới/cập nhật/không đổi, tổng pack và số lượng theo đơn vị tính, giá trị trước/sau. Có hành động sửa mapping hoặc tải file lỗi; không ghi dữ liệu chỉ vì người dùng xem preview.
4. **File lỗi:** Giữ giá trị nguồn và thêm `Sheet`, `Dòng nguồn`, `Cột lỗi`, `Mã lỗi`, `Lý do`, `Gợi ý sửa`; màu đi kèm nội dung chữ. Tải lại bản đã sửa tạo phiên kiểm tra mới, giữ liên kết với phiên trước.
5. **Xác nhận:** Server kiểm tra lại quyền kho, nội dung staging, mã tham chiếu, phiên bản dữ liệu và chống trùng; chặn nếu dữ liệu đã thay đổi so với preview. Chỉ nhập khi không còn lỗi chặn và các cảnh báo đã được xác nhận theo quyền.
6. **Kết quả:** Hiển thị số chứng từ/dòng đã ghi, bị lỗi hoặc còn chờ, liên kết chứng từ và lịch sử import. Danh mục có thể xử lý theo batch với kết quả rõ ràng. Tồn kho ghi nguyên vẹn từng chứng từ, không bỏ dòng lỗi rồi ghi phần còn lại của cùng chứng từ; file nhiều chứng từ có thể hoàn tất một phần và phải liệt kê chính xác chứng từ đã commit.

### 5.5. Tồn chuyển đổi, tính nguyên tử và truy vết import

**Quy tắc dữ liệu đang có:**

* File chỉ có Part No và tổng tồn chưa đủ tạo tồn theo pack. Giữ ở staging để bổ sung vị trí/lot/MES Pack/hạn dùng hoặc thống nhất một phương án chuyển đổi riêng trước khi ghi. Không tự tạo thông tin tem, lot hoặc hạn dùng giả để vượt validation.
* Tồn đầu kỳ có thể có hàng hết hạn hoặc cách ly: ghi đúng tồn vật lý, trạng thái chặn xuất; pack có `expired_date <= ngày kho tại mốc chuyển đổi` bắt buộc ở trạng thái `EXPIRED`. Phiếu nhập thông thường giữ quy tắc chặn hàng hết hạn, không dùng ngoại lệ chuyển đổi để bỏ qua kiểm soát này.
* Chốt một mốc chuyển đổi theo kho và kiểm kê tại mốc đó; tạm dừng giao dịch ảnh hưởng dữ liệu đang chốt cho đến khi hoàn tất và đối soát. Người có quyền duyệt tồn đầu kỳ mới được xác nhận. Không dùng import để ghi đè trực tiếp `on_hand`/`reserved` của pack hiện hữu.
* Nếu bổ sung lịch sử cũ, phải có thiết kế migration riêng và đối soát với mốc chuyển đổi; không nhập đồng thời số dư đầu kỳ và toàn bộ delta lịch sử rồi cộng tồn hai lần. Sửa sai sau ghi sổ bằng chứng từ bù có tham chiếu, không xóa ledger đã hoàn tất.

**Dữ liệu quản lý import:**

| Thành phần | Trách nhiệm |
| :--- | :--- |
| `import_jobs` | Loại import, người thực hiện, phạm vi kho, tên/hash file, template/profile mapping, mốc chuyển đổi, phiên bản preview, trạng thái và tổng kết quả. |
| `import_rows` | Sheet/dòng nguồn, dữ liệu gốc, dữ liệu chuẩn hóa, lỗi/cảnh báo, nhóm chứng từ và kết quả xử lý. |
| `import_mapping_profiles` | Cấu hình ghép cột, quy tắc ngày/số và loại import; có phạm vi sở hữu/quyền truy cập. |
| Liên kết chứng từ nguồn | Lưu `import_job_id`, mã chứng từ nguồn và dòng nguồn để truy từ file tới chứng từ, pack và movement. |

Job đi qua `UPLOADED -> MAPPED -> VALIDATED -> CONFIRMING -> COMPLETED / PARTIAL_FAILED / FAILED`; có thể hủy trước khi ghi. Preview hết hiệu lực nếu thay file, mapping hoặc dữ liệu đầu vào liên quan.

Inventory Core ghi chứng từ, ledger, số dư, idempotency result và kết quả dòng import của chứng từ trong cùng transaction. Đặt unique business reference cho nguồn import/chứng từ để cùng dữ liệu không được ghi lần nữa dù request đổi key. Retry job chỉ xử lý chứng từ chưa commit; chứng từ đã thành công trả lại kết quả cũ. Hash file giúp cảnh báo file đã từng nhập, không tự động cấm mọi lần dùng lại một file hợp lệ. Cập nhật danh mục phải kiểm tra phiên bản để không ghi đè thay đổi xảy ra sau preview.

API tối thiểu: `POST /api/v1/imports` để tải file/staging; `PUT /api/v1/imports/:id/mapping`; `POST /api/v1/imports/:id/validate`; `POST /api/v1/imports/:id/confirm` kèm `Idempotency-Key`; `GET /api/v1/imports/:id` và `GET /api/v1/imports/:id/errors.xlsx`. Tất cả endpoint và tải file phải kiểm tra người dùng, quyền nghiệp vụ và phạm vi kho.

### 5.6. Tiêu chí nghiệm thu Excel và import

1. Mở file trên Microsoft Excel và WPS: header, filter, freeze, wrap text, định dạng số/ngày, mã có số 0 đầu/mã dài và tổng sau lọc đều đúng; bản trình bày in A4 ngang rõ chữ và lặp tiêu đề.
2. Kiểm tra các mốc hạn dùng `0, 1, 30, 31, 90, 91` ngày; màu và trạng thái thống nhất giữa Dashboard và file, theo cùng `as_of`.
3. Đối soát dữ liệu biết trước: tồn đầu 100, nhập 20, xuất 30, không có điều chỉnh thì tồn cuối 90; thêm điều chỉnh, chuyển nội bộ và tồn đầu kỳ để chứng minh không cộng trùng. Hàng cách ly/hết hạn vẫn có trong tồn vật lý nhưng không trong khả dụng.
4. Export ít nhất 100.000 dòng và nhiều lượt đồng thời, gồm client tải chậm/hủy tải. Đo RSS, buffer, thời gian và số kết nối DB trước/trong/sau; đặt ngưỡng RAM và thời gian theo môi trường benchmark. Không khẳng định chỉ tốn vài MB khi chưa đo; hủy tải phải giải phóng tài nguyên.
5. Import thử mẫu chuẩn và file cũ khác tên/thứ tự cột, chọn sheet/header, profile mapping, số 0 đầu, ngày Excel/ngày chuỗi và số có phân cách. Không tự sửa ngày mơ hồ hoặc mã đã mất chính xác.
6. File thiếu dữ liệu, trùng pack, sai UOM/ngày/số lượng hoặc không có quyền kho phải bị chặn trước ghi; file lỗi chỉ đúng sheet/dòng/cột. Tổng preview và tổng sau ghi phải khớp theo chứng từ/đơn vị.
7. Retry/double-click xác nhận, lỗi giữa transaction, crash sau commit trước response và chạy đồng thời cùng chứng từ nguồn: không tạo thêm pack/movement; job phục hồi đúng trạng thái. Chứng từ lỗi rollback toàn bộ; file nhiều chứng từ phản ánh chính xác phần đã commit.
8. Tồn chuyển đổi có hàng hết hạn/cách ly, thiếu pack hoặc chồng lịch sử phải được xử lý theo §5.5; kiểm tra đầy đủ liên kết file -> dòng -> chứng từ -> ledger và đối soát số dư sau chuyển đổi.

---
## 6. HẠ TẦNG GOOGLE CLOUD RUN & TÌM KIẾM

1. **Cấu hình Cloud Run:** Deploy với `--timeout=3600` và ép buộc WebSocket-only (`transports: ['websocket']`).
2. **Benchmark Tìm kiếm định lượng:**
   - Exact Lookup (B-Tree): **p95 < 2ms, p99 < 5ms**.
   - Trigram Search (3 - 10 ký tự): **p95 < 15ms, p99 < 30ms**.
   - Tổng phản hồi API tra cứu: **p95 < 50ms** trên 500k bản ghi.

---

## 7. LỘ TRÌNH 4 GIAI ĐOẠN TÍCH HỢP KIỂM THỬ LIÊN TỤC

| Giai đoạn | Nội dung kỹ thuật | Nghiệm thu kiểm thử bắt buộc (Gates) |
| :--- | :--- | :--- |
| **Phase 1: Core Foundation & Concurrency** | • Schema hạt nhân `stock_pack_balances`, `stock_movements`<br/>• Hàm FEFO `reserve_stock_fefo` và quy trình Ship Full-Lock | **Gate 1:**<br/>1. Chạy Concurrency: 20 luồng đồng thời tranh chấp pack $\rightarrow$ Không oversell.<br/>2. Test Race Condition Ship: Khóa toàn phần pack, nếu bị đổi sang `QUARANTINE` thì hủy ship và rollback 100%. |
| **Phase 2: Inbound, Import & Active Security** | • Scan events/draft lines, pairing và thu hồi socket<br/>• Import danh mục, vị trí/NCC, tồn đầu kỳ và phiếu nhập nháp<br/>• Mẫu chuẩn, ghép cột file cũ, staging/preview, file lỗi, transaction và idempotency theo chứng từ | **Gate 2:**<br/>1. Camera LAN HTTPS và quét 1D rồi bổ sung 2D hoạt động trên thiết bị thật.<br/>2. Hai request đồng thời cùng event: một `ACCEPTED`, một `ACCEPTED_IDEMPOTENT`; cùng pack nhưng khác event: một thành công, một `DUPLICATE_PACK_SCANNED`.<br/>3. Import mẫu/file cũ và tải file lỗi theo §5.6, mục 5-6.<br/>4. Preview không đổi tồn; retry/crash/concurrency không ghi trùng, lỗi rollback nguyên chứng từ theo §5.6, mục 7.<br/>5. Tồn đầu kỳ, hàng hết hạn/cách ly và truy vết nguồn được đối soát theo §5.5 và §5.6, mục 8. |
| **Phase 3: Outbound, Search, Reporting & Excel** | • UI Omni-search/Quick Pills và Trigram Index<br/>• Dashboard và 4 báo cáo dùng chung định nghĩa/snapshot<br/>• Excel bản trình bày và bản chi tiết streaming, định dạng dễ đọc | **Gate 3:**<br/>1. SLA tìm kiếm 500k dòng đạt p95 < 50ms theo điều kiện benchmark đã chốt.<br/>2. File Excel/WPS, số liệu NXT và cảnh báo hạn dùng đạt §5.6, mục 1-3.<br/>3. Export >= 100.000 dòng, nhiều lượt đồng thời, client chậm/hủy tải; đạt ngưỡng tài nguyên đã chốt và giải phóng cursor/kết nối theo §5.6, mục 4. |
| **Phase 4: Cloud Scaling & Diễn tập Khôi phục** | • Docker Cloud Run WebSocket-only & Redis Adapter<br/>• Diễn tập khôi phục Database từ bản backup | **Gate 4:**<br/>1. **Diễn tập Restore Backup:** Khôi phục database từ file dump $\rightarrow$ Khớp số liệu 100%.<br/>2. Multi-instance test: Điện thoại ở Instance A bắn sự kiện sang PC ở Instance B thành công. |
