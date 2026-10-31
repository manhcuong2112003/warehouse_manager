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
} from "@ant-design/icons";
import { api, post, params, fmt } from "../api";
export type PageProps = {
  warehouse: string;
  user: any;
  navigate: (page: string) => void;
};
export function Dashboard({ warehouse, navigate }: PageProps) {
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
  }, []);
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
            Làm mới
          </Button>
        </Space>
      </div>
      <Row gutter={[18, 18]}>
        {[
          {
            title: "Tồn vật lý",
            value: d.on_hand,
            note: "Bao gồm hàng cách ly / hết hạn",
            icon: <InboxOutlined />,
          },
          {
            title: "Khả dụng để xuất",
            value: d.available,
            note: "Đủ điều kiện và còn hạn",
            icon: <ArrowUpOutlined />,
          },
          {
            title: "Đã giữ cho đơn",
            value: d.reserved,
            note: "Đang chờ hoàn tất xuất kho",
            icon: <ArrowDownOutlined />,
          },
          {
            title: "Pack đang tồn",
            value: d.packs,
            note: `${fmt(d.expired)} hết hạn · ${fmt(d.expiring)} cận hạn`,
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
            title="Nhịp nhập · xuất"
            extra={
              <span className="muted">
                14 ngày có giao dịch gần nhất · {unit}
              </span>
            }
          >
            <div className="chart-legend">
              <span>
                <i className="inbound-dot" /> Nhập
              </span>
              <span>
                <i className="outbound-dot" /> Xuất
              </span>
            </div>
            {series.length ? (
              <div className="bar-chart">
                {series.map((v: any) => (
                  <div className="bar-group" key={v.day}>
                    <div className="bars">
                      <div
                        title={`Nhập: ${fmt(v.inbound)}`}
                        style={{
                          height: `${Math.max(2, (Number(v.inbound) / max) * 150)}px`,
                        }}
                      />
                      <div
                        title={`Xuất: ${fmt(v.outbound)}`}
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
          <Card title="Ưu tiên xử lý">
            <div className="priority">
              <span className="priority-icon danger">!</span>
              <div>
                <b>{fmt(d.expired)} pack đã hết hạn</b>
                <p>Kiểm tra, cách ly và lập phương án xử lý.</p>
              </div>
            </div>
            <div className="priority">
              <span className="priority-icon warning">↗</span>
              <div>
                <b>{fmt(d.expiring)} pack cận hạn</b>
                <p>Ưu tiên phân bổ theo FEFO trong 30 ngày tới.</p>
              </div>
            </div>
            <Button block onClick={() => navigate("reports")}>
              Mở báo cáo hạn sử dụng
            </Button>
          </Card>
        </Col>
      </Row>
      <Card title="Bắt đầu một nghiệp vụ" className="section-gap">
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
    [data, setData] = useState<any>({ rows: [], total: 0 }),
    [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      setLoading(true);
      api(
        `/inventory/packs?${params({ ...filters, warehouseId: warehouse, q, preset, offset: (page - 1) * 50 })}`,
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
  }, [q, preset, page, reload, filters]);
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
          total: data.total,
          pageSize: 50,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          {
            title: "Code / Quy cách",
            dataIndex: "part_no",
            fixed: "left",
            width: 260,
            render: (v, r) => (
              <>
                <b className="code">{v}</b>
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
        columns={
          tab === "products"
            ? [
                {
                  title: "Code linh kiện (Part No)",
                  dataIndex: "part_no",
                  render: (v) => <b className="code">{v}</b>,
                },
                { title: "Tên vật liệu (Quy cách)", dataIndex: "specification" },
                { title: "Model sử dụng", dataIndex: "model", render: (v) => v || "—" },
                { title: "Code thành phẩm", dataIndex: "finished_goods_code", render: (v) => v || "—" },
                { title: "ĐVT", dataIndex: "base_uom" },
                { title: "NCC mặc định", dataIndex: "default_vendor_code", render: (v) => v || "—" },
              ]
            : [
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
                rules={[{ required: true }]}
              >
                <Input placeholder="Ví dụ: GH64-10383A-LA" />
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
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(""),
    [form] = Form.useForm();
  const load = () =>
    api(`/outbound/orders?warehouseId=${warehouse}`)
      .then(setRows)
      .catch((e) => message.error(e.message));
  useEffect(() => {
    load();
    api("/products").then(setProducts);
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
        columns={[
          {
            title: "Mã phiếu",
            dataIndex: "reference",
            render: (v) => <b className="code">{v}</b>,
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
            rules={[{ required: true }]}
          >
            <Input />
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
                          label: `${p.part_no} · ${p.base_uom}`,
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
