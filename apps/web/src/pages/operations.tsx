import { useEffect, useState, useRef } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tabs,
} from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  InboxOutlined,
  ScanOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  FilterOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { api, post, params, fmt } from "../api";
import { useI18n, getWeekdayName } from "../i18n";
export type PageProps = {
  warehouse: string;
  user: any;
  navigate: (page: string) => void;
};
export function Dashboard({ warehouse, navigate }: PageProps) {
  const { t } = useI18n();
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [unit, setUnit] = useState("");

  const load = () =>
    api(`/reports/dashboard?${params({ warehouseId: warehouse })}`)
      .then((d) => {
        setData(d);
        setUnit((old) => old || d.units[0]?.base_uom || "PCS");
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [warehouse]);

  if (error) return <Alert type="error" message={error} />;
  const d = data?.units.find((u: any) => u.base_uom === unit) || {};
  const series = (data?.days || [])
      .filter((v: any) => v.base_uom === unit)
      .slice(-14),
    max = Math.max(
      1,
      ...series.flatMap((v: any) => [Number(v.inbound), Number(v.outbound)]),
    );

  return (
    <>
      <div className="intro-row">
        <div>
          <h2>Kho hàng đang vận hành thế nào?</h2>
          <p>Số dư thực tế, hàng đang giữ và các ưu tiên xử lý trong ngày.</p>
        </div>
        <Space>
          <Select
            value={unit || "PCS"}
            onChange={setUnit}
            options={(data?.units.length
              ? data.units
              : [{ base_uom: "PCS" }]
            ).map((u: any) => ({ value: u.base_uom, label: u.base_uom }))}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>
            {t("btn_refresh")}
          </Button>
        </Space>
      </div>
      <Row gutter={[18, 18]}>
        {[
          {
            title: t("stat_on_hand"),
            value: d.on_hand,
            note: t("stat_on_hand_sub"),
            icon: <InboxOutlined />,
          },
          {
            title: t("stat_available"),
            value: d.available,
            note: t("stat_available_sub"),
            icon: <ArrowUpOutlined />,
          },
          {
            title: t("stat_reserved"),
            value: d.reserved,
            note: t("stat_reserved_sub"),
            icon: <ArrowDownOutlined />,
          },
          {
            title: t("stat_packs"),
            value: d.packs,
            note: `${fmt(d.expired)} ${t("expired_packs")} · ${fmt(d.expiring)} ${t("expiring_packs")}`,
            icon: <ScanOutlined />,
          },
        ].map((v, i) => (
          <Col xs={24} sm={12} xl={6} key={v.title}>
            <Card className={`metric metric-${i}`} loading={!data}>
              <div className="metric-label">
                {v.title}
                <span>{v.icon}</span>
              </div>
              <Statistic
                value={Number(v.value || 0)}
                groupSeparator="."
                suffix={i < 3 ? <small>{unit}</small> : undefined}
              />
              <div className="metric-note">{v.note}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[18, 18]} className="section-gap">
        <Col xs={24} xl={16}>
          <Card
            title={t("stat_flow_title")}
            extra={
              <span className="muted">
                {t("stat_flow_sub")}
              </span>
            }
          >
            <div className="chart-legend">
              <span>
                <i className="inbound-dot" /> {t("inbound_label")}
              </span>
              <span>
                <i className="outbound-dot" /> {t("outbound_label")}
              </span>
            </div>
            {series.length ? (
              <div className="bar-chart">
                {series.map((v: any) => (
                  <div className="bar-group" key={v.day}>
                    <div className="bars">
                      <div
                        title={`${t("inbound_label")}: ${fmt(v.inbound)}`}
                        style={{
                          height: `${Math.max(2, (Number(v.inbound) / max) * 150)}px`,
                        }}
                      />
                      <div
                        title={`${t("outbound_label")}: ${fmt(v.outbound)}`}
                        style={{
                          height: `${Math.max(2, (Number(v.outbound) / max) * 150)}px`,
                        }}
                      />
                    </div>
                    <small>{v.day.slice(5)}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-chart">
                <Empty description="Chưa có giao dịch nhập / xuất để hiển thị" />
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title={t("priority_title")}>
            <div className="priority">
              <span className="priority-icon danger">!</span>
              <div>
                <b>{fmt(d.expired)} {t("expired_packs")}</b>
                <p>{t("expired_desc")}</p>
              </div>
            </div>
            <div className="priority">
              <span className="priority-icon warning">↗</span>
              <div>
                <b>{fmt(d.expiring)} {t("expiring_packs")}</b>
                <p>{t("expiring_desc")}</p>
              </div>
            </div>
            <Button block onClick={() => navigate("reports")}>
              {t("open_expiry_report")}
            </Button>
          </Card>
        </Col>
      </Row>

      <Card className="section-gap">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>
              {t("daily_report_title")}
            </h3>
            <p style={{ margin: 0, color: "#64748b" }}>
              {t("daily_report_desc")}
            </p>
          </div>
          <Button type="primary" onClick={() => navigate("matrix")}>
            {t("daily_report_btn")}
          </Button>
        </div>
      </Card>

      <Card title={t("quick_start")} className="section-gap">
        <Row gutter={[16, 16]}>
          {[
            {
              key: "inbound",
              title: "Quét nhập hàng",
              desc: "Quét liên tục, đối soát rồi ghi sổ.",
              icon: <ScanOutlined />,
            },
            {
              key: "outbound",
              title: "Tạo phiếu xuất",
              desc: "Giữ hàng theo hạn dùng và kiểm tra khi xuất.",
              icon: <ArrowUpOutlined />,
            },
            {
              key: "imports",
              title: "Nhập dữ liệu có sẵn",
              desc: "Ghép cột, xem trước và nhập từ Excel / CSV.",
              icon: <ImportOutlined />,
            },
          ].map((v) => (
            <Col xs={24} md={8} key={v.key}>
              <button className="quick-action" onClick={() => navigate(v.key)}>
                {v.icon}
                <div>
                  <b>{v.title}</b>
                  <p>{v.desc}</p>
                </div>
                <span>→</span>
              </button>
            </Col>
          ))}
        </Row>
      </Card>
      <div className="snapshot">
        Chốt dữ liệu:{" "}
        {data ? new Date(data.asOf).toLocaleString("vi-VN") : "Đang tải…"} ·
        Không cộng gộp các đơn vị tính khác nhau.
      </div>
    </>
  );
}
export function Inventory({ warehouse, user }: PageProps) {
  const { message } = App.useApp();
  const [filters, setFilters] = useState<any>({}),
    [filterOpen, setFilterOpen] = useState(false),
    [locations, setLocations] = useState<any[]>([]);
  const [filterForm] = Form.useForm();
  const searchInput = useRef<any>(null);
  useEffect(() => {
    api(`/locations?warehouseId=${warehouse}`)
      .then(setLocations)
      .catch((e) => message.error(e.message));
    const key = (e: KeyboardEvent) => {
      if (e.key === "F3") {
        e.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const [q, setQ] = useState(""),
    [preset, setPreset] = useState(""),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(50),
    [data, setData] = useState<any>({ rows: [], total: 0 }),
    [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      setLoading(true);
      api(
        `/inventory/packs?${params({
          ...filters,
          warehouseId: warehouse,
          q,
          preset,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        })}`,
      )
        .then((d) => {
          if (active) setData(d);
        })
        .catch((e) => message.error(e.message))
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [q, preset, page, pageSize, reload, filters]);
  return (
    <Card>
      <div className="toolbar">
        <Input
          size="large"
          prefix={<SearchOutlined />}
          placeholder="Part No, MES Pack, Lot, Vendor hoặc tên hàng…"
          ref={searchInput}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          allowClear
        />
        <Button
          icon={<FilterOutlined />}
          onClick={() => {
            filterForm.setFieldsValue(filters);
            setFilterOpen(true);
          }}
        >
          Bộ lọc nâng cao
        </Button>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => setReload((v) => v + 1)}
        >
          Làm mới
        </Button>
      </div>
      <div className="filter-row">
        <Segmented
          value={preset}
          onChange={(v) => {
            setPreset(String(v));
            setPage(1);
          }}
          options={[
            { label: "Tất cả", value: "" },
            { label: "Cận hạn ≤ 30 ngày", value: "expiring" },
            { label: "Đã hết hạn", value: "expired" },
            { label: "Hết tồn", value: "empty" },
            { label: "Mới nhập hôm nay", value: "today" },
          ]}
        />
        <span className="muted">{fmt(data.total)} pack</span>
      </div>
      <Table<any>
        rowKey="id"
        loading={loading}
        dataSource={data.rows}
        scroll={{ x: 1400 }}
        pagination={{
          current: page,
          pageSize: pageSize,
          total: data.total,
          pageSizeOptions: ["20", "50", "100", "200"],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) =>
            `${range[0]}-${range[1]} / ${fmt(total)} pack`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        columns={[
          {
            title: "Code / Quy cách",
            dataIndex: "part_no",
            fixed: "left",
            width: 260,
            render: (v, r) => (
              <>
                {v ? (
                  <b className="code">{v}</b>
                ) : (
                  <span
                    style={{
                      background: "#fef08a",
                      border: "1px dashed #eab308",
                      borderRadius: 4,
                      padding: "2px 6px",
                      color: "#854d0e",
                      fontWeight: "bold",
                      fontSize: 11,
                    }}
                  >
                    ⚠️ Chưa có mã
                  </span>
                )}
                <div>{r.specification}</div>
                {(r.model || r.finished_goods_code) && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {r.model ? `Model: ${r.model}` : ""}
                    {r.model && r.finished_goods_code ? " · " : ""}
                    {r.finished_goods_code ? `TP: ${r.finished_goods_code}` : ""}
                  </div>
                )}
              </>
            ),
          },
          {
            title: "MES Pack / Lot",
            dataIndex: "mes_pack_no",
            width: 280,
            render: (v, r) => (
              <>
                <span className="code">{v}</span>
                <div className="muted">Lot: {r.lot_no}</div>
              </>
            ),
          },
          { title: "Vị trí", dataIndex: "location_code" },
          {
            title: "Tồn vật lý",
            dataIndex: "on_hand",
            align: "right",
            render: fmt,
          },
          {
            title: "Giữ chỗ",
            dataIndex: "reserved",
            align: "right",
            render: fmt,
          },
          {
            title: "Khả dụng",
            dataIndex: "available",
            align: "right",
            render: (v) => <b>{fmt(v)}</b>,
          },
          { title: "ĐVT", dataIndex: "base_uom" },
          {
            title: "Hạn dùng",
            dataIndex: "expiry",
            render: (v, r) => (
              <>
                {v}
                <div>
                  <Tag
                    color={
                      r.days_left <= 0
                        ? "red"
                        : r.days_left <= 30
                          ? "orange"
                          : r.days_left <= 90
                            ? "gold"
                            : "green"
                    }
                  >
                    {r.days_left <= 0 ? "Hết hạn" : `${r.days_left} ngày`}
                  </Tag>
                </div>
              </>
            ),
          },
          {
            title: "Trạng thái kho",
            dataIndex: "status",
            width: 170,
            render: (v, r) =>
              user.role === "VIEWER" ? (
                <Tag>{v}</Tag>
              ) : (
                <Select
                  size="small"
                  value={v}
                  options={["AVAILABLE", "QUARANTINE", "LOCKED", "EXPIRED"].map(
                    (value) => ({ value, label: value }),
                  )}
                  onChange={async (status) => {
                    try {
                      await post(
                        `/inventory/packs/${r.id}/status`,
                        { status },
                        "PUT",
                      );
                      setReload((v) => v + 1);
                    } catch (e: any) {
                      message.error(e.message);
                    }
                  }}
                />
              ),
          },
        ]}
      />
      <Drawer
        title="Bộ lọc tồn kho"
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        extra={
          <Button
            onClick={() => {
              filterForm.resetFields();
              setFilters({});
              setPage(1);
            }}
          >
            Xóa bộ lọc
          </Button>
        }
      >
        <Form
          form={filterForm}
          layout="vertical"
          onFinish={(values) => {
            setFilters(values);
            setPage(1);
            setFilterOpen(false);
          }}
        >
          <Form.Item name="locationId" label="Vị trí">
            <Select
              allowClear
              options={locations.map((l) => ({
                value: l.id,
                label: `${l.code} · ${l.name}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="status" label="Trạng thái kho">
            <Select
              allowClear
              options={["AVAILABLE", "QUARANTINE", "LOCKED", "EXPIRED"].map(
                (value) => ({ value, label: value }),
              )}
            />
          </Form.Item>
          <Form.Item name="expiryFrom" label="Hạn dùng từ ngày">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="expiryTo" label="Hạn dùng đến ngày">
            <Input type="date" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            Áp dụng bộ lọc
          </Button>
        </Form>
      </Drawer>
    </Card>
  );
}
export function Catalog({ warehouse, user }: PageProps) {
  const { message } = App.useApp();
  const [tab, setTab] = useState("products"),
    [q, setQ] = useState(""),
    [rows, setRows] = useState<any[]>([]),
    [open, setOpen] = useState(false),
    [catPage, setCatPage] = useState(1),
    [catPageSize, setCatPageSize] = useState(15),
    [form] = Form.useForm();
  const load = () =>
    api(
      tab === "locations"
        ? `/locations?warehouseId=${warehouse}`
        : tab === "products"
          ? `/products?q=${encodeURIComponent(q)}`
          : "/vendors",
    )
      .then(setRows)
      .catch((e) => message.error(e.message));
  useEffect(() => {
    setCatPage(1);
    load();
  }, [tab, q]);
  return (
    <Card>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "products", label: "Sản phẩm" },
          { key: "vendors", label: "Nhà cung cấp" },
          { key: "locations", label: "Vị trí kho" },
        ]}
      />
      <div className="toolbar">
        <Input
          prefix={<SearchOutlined />}
          placeholder="Tìm theo mã hoặc tên sản phẩm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={tab !== "products"}
        />
        {user.role === "ADMIN" && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setOpen(true);
            }}
          >
            Thêm{" "}
            {tab === "products"
              ? "sản phẩm"
              : tab === "vendors"
                ? "nhà cung cấp"
                : "vị trí"}
          </Button>
        )}
      </div>
      <Table<any>
        rowKey={(r) => r.id || r.code}
        dataSource={rows}
        pagination={{
          current: catPage,
          pageSize: catPageSize,
          pageSizeOptions: ["10", "15", "20", "50", "100"],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total} mục`,
          onChange: (p, ps) => {
            setCatPage(p);
            setCatPageSize(ps);
          },
        }}
        columns={
          tab === "products"
            ? [
                {
                  title: "STT",
                  key: "stt",
                  width: 60,
                  align: "center",
                  render: (_: any, __: any, index: number) =>
                    (catPage - 1) * catPageSize + index + 1,
                },
                {
                  title: "Code linh kiện (Part No)",
                  dataIndex: "part_no",
                  render: (v) =>
                    v ? (
                      <b className="code">{v}</b>
                    ) : (
                      <span
                        style={{
                          background: "#fef08a",
                          border: "1px dashed #eab308",
                          borderRadius: 4,
                          padding: "2px 8px",
                          color: "#854d0e",
                          fontWeight: "bold",
                          fontSize: 12,
                        }}
                      >
                        ⚠️ Chưa có mã (Null)
                      </span>
                    ),
                },
                { title: "Tên vật liệu (Quy cách)", dataIndex: "specification" },
                { title: "Model sử dụng", dataIndex: "model", render: (v) => v || "—" },
                { title: "Code thành phẩm", dataIndex: "finished_goods_code", render: (v) => v || "—" },
                { title: "ĐVT", dataIndex: "base_uom" },
                { title: "NCC mặc định", dataIndex: "default_vendor_code", render: (v) => v || "—" },
              ]
            : [
                {
                  title: "STT",
                  key: "stt",
                  width: 60,
                  align: "center",
                  render: (_: any, __: any, index: number) =>
                    (catPage - 1) * catPageSize + index + 1,
                },
                {
                  title: "Mã",
                  dataIndex: "code",
                  render: (v) => <b className="code">{v}</b>,
                },
                { title: "Tên", dataIndex: "name" },
              ]
        }
        locale={{
          emptyText: (
            <Empty description="Chưa có danh mục. Tạo mới hoặc nhập từ Excel." />
          ),
        }}
      />
      <Modal
        title="Thêm danh mục"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (v) => {
            try {
              await post(`/${tab}`, { ...v, warehouseId: warehouse });
              setOpen(false);
              load();
              message.success("Đã lưu danh mục.");
            } catch (e: any) {
              message.error(e.message);
            }
          }}
        >
          {tab === "products" ? (
            <>
              <Form.Item
                label="Code linh kiện (Part No)"
                name="partNo"
                rules={[{ required: false }]}
                extra="Có thể để trống nếu linh kiện chưa có mã code chính thức"
              >
                <Input placeholder="Ví dụ: GH64-10383A-LA (hoặc để trống)" />
              </Form.Item>
              <Form.Item
                label="Tên vật liệu (Quy cách)"
                name="specification"
                rules={[{ required: true }]}
              >
                <Input placeholder="Ví dụ: DECO RATION CAM LOWER" />
              </Form.Item>
              <Form.Item
                label="Model sử dụng"
                name="model"
              >
                <Input placeholder="Ví dụ: SM-S741U (R14)" />
              </Form.Item>
              <Form.Item
                label="Code thành phẩm"
                name="finishedGoodsCode"
              >
                <Input placeholder="Ví dụ: GH98-51260A" />
              </Form.Item>
              <Form.Item
                label="Đơn vị tính"
                name="baseUom"
                initialValue="PCS"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item label="Mã NCC mặc định" name="vendorCode">
                <Input placeholder="Ví dụ: DQUU" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item label="Mã" name="code" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item label="Tên" name="name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
export function Outbound({ warehouse, user }: PageProps) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<any[]>([]),
    [products, setProducts] = useState<any[]>([]),
    [operators, setOperators] = useState<any[]>([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(""),
    [outPage, setOutPage] = useState(1),
    [outPageSize, setOutPageSize] = useState(15),
    [form] = Form.useForm();
  const load = () =>
    api(`/outbound/orders?warehouseId=${warehouse}`)
      .then(setRows)
      .catch((e) => message.error(e.message));
  useEffect(() => {
    load();
    api("/products").then(setProducts);
    api("/outbound/operators")
      .then(setOperators)
      .catch(() => {});
  }, []);
  const action = async (id: string, op: string) => {
    setBusy(id);
    try {
      await post(`/outbound/orders/${id}/${op}`);
      message.success("Đã cập nhật phiếu xuất.");
      load();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <Card
      title="Phiếu xuất hàng"
      extra={
        user.role !== "VIEWER" && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setOpen(true);
            }}
          >
            Tạo phiếu xuất
          </Button>
        )
      }
    >
      <Alert
        type="info"
        showIcon
        message="Giữ hàng theo FEFO; khi xuất, hệ thống kiểm tra lại hạn dùng và trạng thái của toàn bộ pack."
        style={{ marginBottom: 20 }}
      />
      <Table<any>
        rowKey="id"
        dataSource={rows}
        pagination={{
          current: outPage,
          pageSize: outPageSize,
          pageSizeOptions: ["10", "15", "20", "50", "100"],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total} phiếu xuất`,
          onChange: (p, ps) => {
            setOutPage(p);
            setOutPageSize(ps);
          },
        }}
        columns={[
          {
            title: "STT",
            key: "stt",
            width: 60,
            align: "center",
            render: (_: any, __: any, index: number) =>
              (outPage - 1) * outPageSize + index + 1,
          },
          {
            title: "Mã phiếu",
            dataIndex: "reference",
            render: (v) => <b className="code">{v}</b>,
          },
          {
            title: "Người xuất kho",
            render: (_, r) => (
              <span style={{ fontWeight: 500, color: "#1e293b" }}>
                {r.actor_name || r.actor_username || "—"}
              </span>
            ),
          },
          {
            title: "Nội dung",
            dataIndex: "lines",
            render: (lines) =>
              lines.map((l: any) => (
                <div key={l.id}>
                  {l.part_no} · <b>{fmt(l.quantity)}</b>
                </div>
              )),
          },
          {
            title: "Trạng thái",
            dataIndex: "status",
            render: (v) => (
              <Tag
                color={
                  v === "SHIPPED"
                    ? "green"
                    : v === "RESERVED"
                      ? "blue"
                      : v === "CANCELLED"
                        ? "default"
                        : "gold"
                }
              >
                {
                  (
                    {
                      DRAFT: "Nháp",
                      RESERVED: "Đã giữ hàng",
                      SHIPPED: "Đã xuất",
                      CANCELLED: "Đã hủy",
                    } as any
                  )[v]
                }
              </Tag>
            ),
          },
          {
            title: "Ngày tạo",
            dataIndex: "created_at",
            render: (v) => new Date(v).toLocaleString("vi-VN"),
          },
          {
            title: "Thao tác",
            render: (_, r) =>
              user.role !== "VIEWER" && (
                <Space>
                  {r.status === "DRAFT" && (
                    <Button
                      loading={busy === r.id}
                      onClick={() => action(r.id, "reserve")}
                    >
                      Giữ hàng FEFO
                    </Button>
                  )}
                  {r.status === "RESERVED" && (
                    <Popconfirm
                      title="Xác nhận xuất toàn bộ hàng trên phiếu?"
                      onConfirm={() => action(r.id, "ship")}
                    >
                      <Button type="primary" loading={busy === r.id}>
                        Xác nhận xuất
                      </Button>
                    </Popconfirm>
                  )}
                  {["DRAFT", "RESERVED"].includes(r.status) && (
                    <Popconfirm
                      title="Hủy phiếu và giải phóng giữ chỗ?"
                      onConfirm={() => action(r.id, "cancel")}
                    >
                      <Button danger>Hủy</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <Modal
        title="Tạo phiếu xuất kho"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (v) => {
            try {
              await post("/outbound/orders", { ...v, warehouseId: warehouse });
              setOpen(false);
              load();
            } catch (e: any) {
              message.error(e.message);
            }
          }}
        >
          <Form.Item
            name="reference"
            label="Mã phiếu / tham chiếu"
            rules={[{ required: true, message: "Vui lòng nhập mã phiếu" }]}
          >
            <Input placeholder="Ví dụ: XK-20261030-01" />
          </Form.Item>
          <Form.Item
            name="operatorId"
            label="Người xuất kho / Phụ trách"
            initialValue={user?.id}
            rules={[{ required: true, message: "Vui lòng chọn người xuất kho" }]}
          >
            <Select
              placeholder="Chọn người xuất kho"
              showSearch
              optionFilterProp="label"
              options={operators.map((u) => ({
                value: u.id,
                label: `${u.display_name} (@${u.username}) · ${u.role === "ADMIN" ? "Quản trị" : "Thủ kho"}`,
              }))}
            />
          </Form.Item>
          <Form.List name="lines" initialValue={[{ quantity: 1 }]}>
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline">
                    <Form.Item
                      name={[f.name, "productId"]}
                      rules={[{ required: true }]}
                    >
                      <Select
                        placeholder="Sản phẩm"
                        showSearch
                        optionFilterProp="label"
                        style={{ width: 270 }}
                        options={products.map((p) => ({
                          value: p.id,
                          label: `${p.part_no || p.specification} · ${p.base_uom}`,
                        }))}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[f.name, "quantity"]}
                      rules={[{ required: true }]}
                    >
                      <InputNumber min={1} max={10000000} precision={0} />
                    </Form.Item>
                    {fields.length > 1 && (
                      <Button onClick={() => remove(f.name)}>×</Button>
                    )}
                  </Space>
                ))}
                <Button onClick={() => add({ quantity: 1 })}>Thêm dòng</Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  );
}

export function OutboundMatrixPage({ warehouse, user }: PageProps) {
  const { lang, t } = useI18n();
  const [matrixData, setMatrixData] = useState<any>({ dates: [], items: [] });
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixDays, setMatrixDays] = useState(7);
  const [searchQuery, setSearchQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [productDetail, setProductDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const loadMatrix = () => {
    setMatrixLoading(true);
    api(
      `/reports/outbound-matrix?${params({ warehouseId: warehouse, days: String(matrixDays) })}`,
    )
      .then(setMatrixData)
      .catch((e) => console.error("Error loading outbound matrix:", e))
      .finally(() => setMatrixLoading(false));
  };

  useEffect(() => {
    loadMatrix();
  }, [warehouse, matrixDays]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, matrixDays]);

  const openProductDetail = (productId: string) => {
    setDetailId(productId);
    setDetailLoading(true);
    api(
      `/reports/product-detail/${productId}?${params({ warehouseId: warehouse })}`,
    )
      .then(setProductDetail)
      .catch((e) => console.error("Error loading product detail:", e))
      .finally(() => setDetailLoading(false));
  };

  const filteredMatrixItems = (matrixData?.items || []).filter((item: any) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (item.partNo && item.partNo.toLowerCase().includes(q)) ||
      (item.specification && item.specification.toLowerCase().includes(q)) ||
      (item.model && item.model.toLowerCase().includes(q)) ||
      (item.finishedGoodsCode &&
        item.finishedGoodsCode.toLowerCase().includes(q))
    );
  });

  return (
    <>
      <Card
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>
              {t("daily_report_title")}
            </span>
          </div>
        }
        extra={
          <Space wrap>
            <Input
              prefix={<SearchOutlined />}
              placeholder={t("btn_search")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: 280 }}
              allowClear
            />
            <Select
              value={matrixDays}
              onChange={setMatrixDays}
              options={[
                { value: 7, label: t("opt_7days") },
                { value: 14, label: t("opt_14days") },
                { value: 30, label: t("opt_30days") },
              ]}
              style={{ width: 160 }}
            />
            <Button
              icon={<ReloadOutlined />}
              onClick={loadMatrix}
              loading={matrixLoading}
            >
              {t("btn_reload")}
            </Button>
          </Space>
        }
      >
        <Table
          dataSource={filteredMatrixItems}
          rowKey="id"
          size="middle"
          scroll={{ x: 1250 }}
          loading={matrixLoading}
          pagination={{
            current: page,
            pageSize: pageSize,
            pageSizeOptions: ["10", "15", "20", "50", "100"],
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) =>
              `${range[0]}-${range[1]} / ${total} ${t("total_components")}`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
          columns={[
            {
              title: t("col_stt"),
              key: "stt",
              width: 60,
              align: "center",
              render: (_: any, __: any, index: number) =>
                (page - 1) * pageSize + index + 1,
            },
            {
              title: t("col_model"),
              dataIndex: "model",
              width: 140,
              render: (t: string) => (
                <span style={{ fontWeight: 500 }}>{t || "—"}</span>
              ),
            },
            {
              title: t("col_fg_code"),
              dataIndex: "finishedGoodsCode",
              width: 140,
              render: (t: string) => (t ? <code>{t}</code> : "—"),
            },
            {
              title: t("col_spec"),
              dataIndex: "specification",
              width: 230,
              render: (spec: string, r: any) => (
                <a
                  onClick={() => openProductDetail(r.id)}
                  style={{ fontWeight: 600, color: "#1d4ed8" }}
                >
                  {spec}
                </a>
              ),
            },
            {
              title: t("col_part_no"),
              dataIndex: "partNo",
              width: 160,
              render: (part: string) =>
                part ? (
                  <code style={{ fontWeight: 600 }}>{part}</code>
                ) : (
                  <Tag
                    color="warning"
                    style={{ background: "#fef9c3", borderColor: "#fde047" }}
                  >
                    {t("no_code")}
                  </Tag>
                ),
            },
            {
              title: t("col_on_hand"),
              dataIndex: "onHand",
              width: 120,
              align: "right",
              render: (n: number, r: any) => (
                <span
                  style={{
                    fontWeight: 700,
                    color: n > 0 ? "#0f172a" : "#94a3b8",
                  }}
                >
                  {fmt(n)} {r.baseUom}
                </span>
              ),
            },
            ...(matrixData?.dates || []).map((d: any) => ({
              title: (
                <div style={{ textAlign: "center", fontSize: 12 }}>
                  <div>{d.date.slice(5)}</div>
                  <div style={{ fontWeight: 700, color: "#2563eb" }}>
                    {getWeekdayName(d.date, lang)}
                  </div>
                </div>
              ),
              key: d.date,
              width: 95,
              align: "right" as const,
              render: (_: any, r: any) => {
                const qty = r.dailyOutbound?.[d.date];
                return qty > 0 ? (
                  <Tag
                    color="cyan"
                    style={{
                      fontWeight: 600,
                      margin: 0,
                      padding: "2px 6px",
                    }}
                  >
                    {fmt(qty)}
                  </Tag>
                ) : (
                  <span className="muted">0</span>
                );
              },
            })),
            {
              title: t("col_total_out"),
              dataIndex: "totalOutbound",
              width: 100,
              align: "right",
              render: (n: number) =>
                n > 0 ? (
                  <b style={{ color: "#d97706" }}>{fmt(n)}</b>
                ) : (
                  <span className="muted">0</span>
                ),
            },
            {
              title: t("col_last_operator"),
              dataIndex: "lastOutboundBy",
              width: 150,
              render: (t: string) => t || <span className="muted">—</span>,
            },
            {
              title: t("col_actions"),
              key: "action",
              fixed: "right" as const,
              width: 80,
              align: "center" as const,
              render: (_: any, r: any) => (
                <Button
                  size="small"
                  type="link"
                  icon={<EyeOutlined />}
                  onClick={() => openProductDetail(r.id)}
                >
                  {t("btn_view")}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={t("product_detail_title")}
        placement="right"
        width={720}
        open={!!detailId}
        onClose={() => {
          setDetailId(null);
          setProductDetail(null);
        }}
      >
        {detailLoading || !productDetail ? (
          <div style={{ padding: 40, textAlign: "center" }}>
            Đang tải thông tin sản phẩm...
          </div>
        ) : (
          <div>
            <div
              style={{
                background: "#f8fafc",
                padding: 16,
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              <h3 style={{ margin: "0 0 8px 0" }}>
                {productDetail.product.specification}
              </h3>
              <Space wrap size={[16, 8]}>
                <div>
                  <span className="muted">Mã linh kiện: </span>
                  {productDetail.product.part_no ? (
                    <code>{productDetail.product.part_no}</code>
                  ) : (
                    <Tag color="warning">Chưa có mã</Tag>
                  )}
                </div>
                <div>
                  <span className="muted">Model: </span>
                  <b>{productDetail.product.model || "—"}</b>
                </div>
                <div>
                  <span className="muted">Code thành phẩm: </span>
                  <b>{productDetail.product.finished_goods_code || "—"}</b>
                </div>
                <div>
                  <span className="muted">Đơn vị: </span>
                  <b>{productDetail.product.base_uom}</b>
                </div>
                <div>
                  <span className="muted">NCC mặc định: </span>
                  <b>{productDetail.product.default_vendor_code || "—"}</b>
                </div>
              </Space>
            </div>

            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col span={6}>
                <Card size="small" style={{ textAlign: "center" }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t("stat_on_hand")}
                  </div>
                  <b style={{ fontSize: 18, color: "#1e293b" }}>
                    {fmt(productDetail.stockSummary.onHand)}
                  </b>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: "center" }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t("stat_available")}
                  </div>
                  <b style={{ fontSize: 18, color: "#16a34a" }}>
                    {fmt(productDetail.stockSummary.available)}
                  </b>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: "center" }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t("stat_reserved")}
                  </div>
                  <b style={{ fontSize: 18, color: "#d97706" }}>
                    {fmt(productDetail.stockSummary.reserved)}
                  </b>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: "center" }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t("stat_packs")}
                  </div>
                  <b style={{ fontSize: 18, color: "#0284c7" }}>
                    {fmt(productDetail.stockSummary.packsCount)}
                  </b>
                </Card>
              </Col>
            </Row>

            <Tabs
              defaultActiveKey="packs"
              items={[
                {
                  key: "packs",
                  label: `${t("stock_by_pack")} (${productDetail.packs.length})`,
                  children: (
                    <Table
                      dataSource={productDetail.packs}
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 6 }}
                      columns={[
                        {
                          title: t("col_pack"),
                          dataIndex: "mes_pack_no",
                          render: (t: string) => (
                            <code style={{ fontSize: 11 }}>{t}</code>
                          ),
                        },
                        {
                          title: t("col_lot"),
                          dataIndex: "lot_no",
                        },
                        {
                          title: t("col_location"),
                          dataIndex: "location_code",
                          render: (t: string) => <Tag>{t}</Tag>,
                        },
                        {
                          title: t("col_on_hand"),
                          dataIndex: "on_hand",
                          render: (n: number) => <b>{fmt(n)}</b>,
                        },
                        {
                          title: t("col_expiry"),
                          dataIndex: "expired_date",
                          render: (d: string) => (d ? d.slice(0, 10) : "—"),
                        },
                        {
                          title: t("col_status"),
                          dataIndex: "status",
                          render: (s: string) => (
                            <Tag color={s === "AVAILABLE" ? "green" : "red"}>
                              {s === "AVAILABLE" ? t("status_available") : s}
                            </Tag>
                          ),
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: "movements",
                  label: `${t("movement_history")} (${productDetail.recentMovements.length})`,
                  children: (
                    <Table
                      dataSource={productDetail.recentMovements}
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 6 }}
                      columns={[
                        {
                          title: "Thời gian",
                          dataIndex: "effective_at",
                          render: (t: string) =>
                            t
                              ? new Date(t).toLocaleString("vi-VN", {
                                  dateStyle: "short",
                                  timeStyle: "short",
                                })
                              : "—",
                        },
                        {
                          title: "Nghiệp vụ",
                          dataIndex: "movement_type",
                          render: (t: string) => {
                            const colors: Record<string, string> = {
                              INBOUND: "green",
                              OUTBOUND: "blue",
                              OPENING_BALANCE: "purple",
                              ADJUSTMENT: "orange",
                            };
                            const labels: Record<string, string> = {
                              INBOUND: "Nhập kho",
                              OUTBOUND: "Xuất kho",
                              OPENING_BALANCE: "Tồn đầu kỳ",
                              ADJUSTMENT: "Điều chỉnh",
                            };
                            return (
                              <Tag color={colors[t] || "default"}>
                                {labels[t] || t}
                              </Tag>
                            );
                          },
                        },
                        {
                          title: "Biến động",
                          dataIndex: "quantity_delta",
                          render: (d: number) => (
                            <b
                              style={{
                                color: d > 0 ? "#16a34a" : "#dc2626",
                              }}
                            >
                              {d > 0 ? `+${fmt(d)}` : fmt(d)}
                            </b>
                          ),
                        },
                        {
                          title: "Tồn sau",
                          dataIndex: "balance_after",
                          render: (n: number) => fmt(n),
                        },
                        {
                          title: "Người thực hiện",
                          render: (_: any, r: any) =>
                            r.actor_name || r.actor_username || "—",
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>
    </>
  );
}
