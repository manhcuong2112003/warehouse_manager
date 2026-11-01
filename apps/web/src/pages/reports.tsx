import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { FileExcelOutlined, SearchOutlined } from "@ant-design/icons";
import { api, params, fmt } from "../api";
import type { PageProps } from "./operations";
const names = [
  { value: "aging", label: "Hạn sử dụng & tuổi hàng" },
  { value: "period", label: "Nhập – Xuất – Tồn theo kỳ" },
  { value: "trace", label: "Truy vết Lot / MES Pack" },
  { value: "movements", label: "Nhật ký biến động kho" },
];
const labels: Record<string, string> = {
  part_no: "Part No",
  specification: "Tên / quy cách",
  base_uom: "ĐVT",
  lot_no: "Lot",
  mes_pack_no: "MES Pack",
  vendor_code: "NCC",
  location: "Vị trí",
  on_hand: "Tồn vật lý",
  reserved: "Giữ chỗ",
  available: "Khả dụng",
  expired_date: "Hạn dùng",
  days_left: "Ngày còn lại",
  aging: "Cảnh báo",
  status: "Trạng thái",
  opening: "Tồn đầu",
  inbound: "Nhập",
  outbound: "Xuất",
  adjustment: "Điều chỉnh / chuyển",
  closing: "Tồn cuối",
  effective_at: "Thời điểm nghiệp vụ",
  quantity_delta: "Biến động",
  balance_after: "Tồn sau",
  movement_type: "Nghiệp vụ",
  reference_id: "Chứng từ",
  actor: "Người thực hiện",
  import_job_id: "Nguồn import",
};
export function Reports({ warehouse }: PageProps) {
  const { message } = App.useApp();
  const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    }),
    tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    });
  const [type, setType] = useState("aging"),
    [from, setFrom] = useState(today),
    [to, setTo] = useState(tomorrow),
    [pack, setPack] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<any>({ rows: [], total: 0 }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const query = { warehouseId: warehouse, from, to, pack };
  const load = async () => {
    if (type === "trace" && !pack) return;
    setLoading(true);
    setError("");
    try {
      setData(
        await api(
          `/reports/${type}?${params({ ...query, offset: (page - 1) * 100 })}`,
        ),
      );
    } catch (e: any) {
      setError(e.message);
      setData({ rows: [], total: 0 });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [type, page]);
  const exportFile = (mode: string) => {
    if (type === "trace" && !pack) {
      message.warning("Nhập mã pack cần truy vết.");
      return;
    }
    window.open(
      `/api/v1/reports/${type}/export?${params({ ...query, mode })}`,
      "_blank",
      "noopener",
    );
  };
  const keys = data.rows[0]
    ? Object.keys(data.rows[0]).filter((k) => labels[k])
    : [];
  return (
    <Card>
      <div className="toolbar">
        <Select
          value={type}
          onChange={(v) => {
            setType(v);
            setPage(1);
          }}
          options={names}
          style={{ minWidth: 300 }}
        />
        <Space>
          <Button
            icon={<FileExcelOutlined />}
            onClick={() => exportFile("presentation")}
          >
            Excel trình bày
          </Button>
          <Button
            type="primary"
            icon={<FileExcelOutlined />}
            onClick={() => exportFile("detail")}
          >
            Excel chi tiết
          </Button>
        </Space>
      </div>
      <div className="report-controls">
        {type === "period" && (
          <>
            <label>
              Từ ngày
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              Đến trước ngày
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </>
        )}
        {type === "trace" && (
          <Input
            placeholder="Nhập chính xác MES Pack No"
            style={{ width: 360 }}
            value={pack}
            onChange={(e) => setPack(e.target.value)}
            onPressEnter={load}
          />
        )}
        <Button
          icon={<SearchOutlined />}
          onClick={() => {
            setPage(1);
            load();
          }}
        >
          Xem báo cáo
        </Button>
        <span className="muted">{fmt(data.total)} dòng · Asia/Ho_Chi_Minh</span>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 16 }}
        />
      )}
      {type === "period" && (
        <Alert
          type="info"
          showIcon
          message="Tồn đầu + Nhập − Xuất + Điều chỉnh/chuyển ròng = Tồn cuối. Tồn đầu kỳ chuyển đổi không được tính thành nhập mua hàng."
          style={{ marginBottom: 16 }}
        />
      )}
      <Table<any>
        rowKey={(r) => r.id || r.part_no}
        loading={loading}
        dataSource={data.rows}
        scroll={{ x: Math.max(1000, keys.length * 150) }}
        pagination={{
          current: page,
          total: data.total,
          pageSize: 100,
          pageSizeOptions: ["50", "100", "200"],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) =>
            `${range[0]}-${range[1]} / ${fmt(total)} bản ghi`,
          onChange: setPage,
        }}
        columns={keys.map((key, i) => ({
          title: labels[key],
          dataIndex: key,
          width: key === "specification" ? 250 : 170,
          fixed: i === 0 ? ("left" as const) : undefined,
          render: (v: any) => {
            if (v === null) return "—";
            if (
              [
                "on_hand",
                "reserved",
                "available",
                "opening",
                "inbound",
                "outbound",
                "adjustment",
                "closing",
                "quantity_delta",
                "balance_after",
              ].includes(key)
            )
              return <b>{fmt(v)}</b>;
            if (key === "aging")
              return (
                <Tag
                  color={
                    v === "HẾT HẠN"
                      ? "red"
                      : v === "CẬN HẠN"
                        ? "orange"
                        : "green"
                  }
                >
                  {v}
                </Tag>
              );
            if (key.endsWith("_at")) return new Date(v).toLocaleString("vi-VN");
            return String(v);
          },
        }))}
      />
      <div className="snapshot">
        {data.asOf
          ? `Chốt dữ liệu lúc ${new Date(data.asOf).toLocaleString("vi-VN")}. `
          : ""}
        Bản trình bày tối đa 5.000 dòng; bản chi tiết hỗ trợ đến 500.000 dòng.
      </div>
    </Card>
  );
}
