import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
} from "antd";
import {
  CheckOutlined,
  MobileOutlined,
  PlusOutlined,
  ScanOutlined,
} from "@ant-design/icons";
import { io } from "socket.io-client";
import QRCode from "qrcode";
import { api, post, fmt } from "../api";
import type { PageProps } from "./operations";
export function Inbound({ warehouse, user }: PageProps) {
  const { message, modal } = App.useApp();
  const [drafts, setDrafts] = useState<any[]>([]),
    [draft, setDraft] = useState<any>(),
    [locations, setLocations] = useState<any[]>([]),
    [loc, setLoc] = useState(""),
    [raw, setRaw] = useState(""),
    [target, setTarget] = useState<string>(),
    [qr, setQr] = useState(""),
    [pairOpen, setPairOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  const input = useRef<any>(null);
  const pendingRequest = useRef<any>(null);
  const loadList = () =>
    api("/inbound/drafts").then((rows) =>
      setDrafts(rows.filter((r: any) => r.warehouse_id === warehouse)),
    );
  const load = async (id: string) => {
    const d = await api(`/inbound/drafts/${id}`);
    setDraft(d);
  };
  useEffect(() => {
    loadList();
    api(`/locations?warehouseId=${warehouse}`).then((rows) => {
      setLocations(rows);
      setLoc(rows[0]?.id || "");
    });
  }, []);
  useEffect(() => {
    if (!draft?.id) return;
    let socket: any;
    api("/auth/me").then((r) => {
      socket = io({
        transports: ["websocket"],
        withCredentials: true,
        auth: { draftId: draft.id, csrf: r.csrfToken },
      });
      socket.on("draft:changed", () => load(draft.id).catch(() => {}));
    });
    return () => {
      socket?.disconnect();
    };
  }, [draft?.id]);
  const create = async () => {
    setBusy(true);
    try {
      const d = await post("/inbound/drafts", {
        warehouseId: warehouse,
        locationId: loc,
      });
      await load(d.id);
      await loadList();
      setTarget(undefined);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const scan = async () => {
    if (!raw.trim() || !draft || busy) return;
    setBusy(true);
    try {
      const content = { draftId: draft.id, raw, targetLineId: target },
        fingerprint = JSON.stringify(content);
      if (pendingRequest.current?.fingerprint !== fingerprint)
        pendingRequest.current = {
          fingerprint,
          payload: { ...content, scanEventId: crypto.randomUUID() },
        };
      const ack = await post("/inbound/scan", pendingRequest.current.payload);
      pendingRequest.current = null;
      setFeedback("Đã lưu mã quét vào phiếu nháp.");
      setRaw("");
      setTarget(ack.item.status === "COMPLETE" ? undefined : ack.item.id);
      await load(draft.id);
      input.current?.focus();
    } catch (e: any) {
      if (e.status) pendingRequest.current = null;
      setFeedback(e.message);
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pair = async () => {
    try {
      const p = await post(`/inbound/drafts/${draft.id}/pair`);
      const url = new URL("/mobile-scan", location.origin);
      url.hash = new URLSearchParams({
        token: p.token,
        draftId: draft.id,
      }).toString();
      setQr(await QRCode.toDataURL(url.toString(), { width: 300, margin: 1 }));
      setPairOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await post(`/inbound/drafts/${draft.id}/confirm`);
      message.success("Đã ghi sổ nhập kho.");
      await load(draft.id);
      await loadList();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const complete =
    draft?.lines?.length > 0 &&
    draft.lines.every((l: any) => l.status === "COMPLETE");
  const totals: Record<string, number> = {};
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F3") {
        e.preventDefault();
        input.current?.focus();
      }
      if (
        e.key === "F9" &&
        complete &&
        !busy &&
        draft?.status === "OPEN" &&
        user.role !== "VIEWER"
      ) {
        e.preventDefault();
        modal.confirm({
          title: "Ghi sổ nhập kho cho toàn bộ phiếu?",
          onOk: confirm,
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [complete, busy, draft?.id, draft?.status, user.role]);
  draft?.lines?.forEach(
    (l: any) =>
      (totals[l.base_uom] = (totals[l.base_uom] || 0) + Number(l.quantity)),
  );
  return (
    <>
      <Card className="section-bottom">
        <div className="toolbar">
          <Select
            placeholder="Mở phiếu nháp có sẵn"
            value={draft?.id}
            onChange={(id) => {
              setTarget(undefined);
              load(id);
            }}
            style={{ minWidth: 260 }}
            options={drafts.map((d) => ({
              value: d.id,
              label: `${d.id.slice(0, 8)} · ${d.status === "OPEN" ? "Đang quét" : "Đã nhập"} · ${new Date(d.created_at).toLocaleDateString("vi-VN")}`,
            }))}
          />
          <Space>
            <Select
              placeholder="Vị trí nhận hàng"
              value={loc || undefined}
              onChange={setLoc}
              options={locations.map((l) => ({
                value: l.id,
                label: `${l.code} · ${l.name}`,
              }))}
              style={{ width: 220 }}
            />
            <Button
              type="primary"
              disabled={!loc || user.role === "VIEWER"}
              icon={<PlusOutlined />}
              onClick={create}
              loading={busy}
            >
              Tạo phiếu nhập
            </Button>
          </Space>
        </div>
      </Card>
      {!draft ? (
        <Card>
          <div className="scan-empty">
            <ScanOutlined />
            <h2>Sẵn sàng nhận một lô hàng mới</h2>
            <p>
              Chọn vị trí nhận hàng và tạo phiếu. Mỗi mã quét được lưu vào bản
              nháp để đối soát trước khi ghi sổ.
            </p>
          </div>
        </Card>
      ) : (
        <>
          <div className="draft-summary">
            <Card>
              <Statistic
                title="Pack / dòng đã quét"
                value={draft.lines?.length || 0}
              />
            </Card>
            <Card>
              <Statistic
                title="Loại linh kiện"
                value={new Set(draft.lines?.map((l: any) => l.product_id)).size}
              />
            </Card>
            <Card>
              <div className="metric-label">Tổng số lượng theo đơn vị</div>
              <div className="unit-total">
                {Object.entries(totals).map(([u, n]) => (
                  <span key={u}>
                    {fmt(n)} <small>{u}</small>
                  </span>
                ))}
              </div>
            </Card>
          </div>
          <Card
            title={
              <Space>
                Phiếu {draft.id.slice(0, 8)}{" "}
                <Tag color={draft.status === "OPEN" ? "blue" : "green"}>
                  {draft.status === "OPEN" ? "Đang đối soát" : "Đã ghi sổ"}
                </Tag>
              </Space>
            }
            extra={
              draft.status === "OPEN" && (
                <Button icon={<MobileOutlined />} onClick={pair}>
                  Quét bằng điện thoại
                </Button>
              )
            }
          >
            {draft.status === "OPEN" && (
              <>
                <div className="scan-input">
                  <Input
                    ref={input}
                    autoFocus
                    size="large"
                    prefix={<ScanOutlined />}
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    onPressEnter={scan}
                    placeholder={
                      target
                        ? "Quét mã pack / QR bổ sung vào dòng đang chọn…"
                        : "Quét mã 1D hoặc QR đầy đủ…"
                    }
                  />
                  <Button
                    type="primary"
                    size="large"
                    onClick={scan}
                    loading={busy}
                  >
                    Nhận mã
                  </Button>
                </div>
                <div className="scan-context">
                  <Select
                    allowClear
                    placeholder="Dòng mới · quét mã đầy đủ"
                    value={target}
                    onChange={setTarget}
                    style={{ minWidth: 300 }}
                    options={draft.lines
                      .filter((l: any) => l.status !== "COMPLETE")
                      .map((l: any) => ({
                        value: l.id,
                        label: `${l.part_no} · Lot ${l.lot_no} · ${l.mes_pack_no || "Chờ pack"}`,
                      }))}
                  />
                  <span className="muted">
                    Chọn đúng dòng khi bổ sung mã 2D. Ngày hết hạn có thể nhập
                    theo tem.
                  </span>
                </div>
                {feedback && (
                  <Alert
                    message={feedback}
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                  />
                )}
              </>
            )}
            <Table<any>
              rowKey="id"
              dataSource={draft.lines}
              pagination={false}
              scroll={{ x: 1000 }}
              columns={[
                {
                  title: "Part No / Quy cách",
                  dataIndex: "part_no",
                  render: (v, r) => (
                    <>
                      <b className="code">{v}</b>
                      <div className="muted">{r.specification}</div>
                    </>
                  ),
                },
                { title: "Lot", dataIndex: "lot_no" },
                {
                  title: "MES Pack",
                  dataIndex: "mes_pack_no",
                  render: (v) => v || <Tag color="gold">Chờ quét pack</Tag>,
                },
                {
                  title: "Số lượng",
                  dataIndex: "quantity",
                  align: "right",
                  render: (v, r) => `${fmt(v)} ${r.base_uom}`,
                },
                {
                  title: "Hạn dùng",
                  dataIndex: "expiry",
                  render: (v, r) =>
                    draft.status === "OPEN" ? (
                      <Input
                        type="date"
                        value={v || ""}
                        onChange={async (e) => {
                          if (e.target.value) {
                            try {
                              await post(
                                `/inbound/drafts/${draft.id}/lines/${r.id}/expiry`,
                                { expiredDate: e.target.value },
                                "PUT",
                              );
                              await load(draft.id);
                            } catch (err: any) {
                              message.error(err.message);
                            }
                          }
                        }}
                        style={{ width: 155 }}
                      />
                    ) : (
                      v
                    ),
                },
                {
                  title: "Đối soát",
                  dataIndex: "status",
                  render: (v, r) => (
                    <Space>
                      <Tag color={v === "COMPLETE" ? "green" : "gold"}>
                        {v === "COMPLETE"
                          ? "Đủ dữ liệu"
                          : v === "WAITING_EXP_DATE"
                            ? "Chờ hạn dùng"
                            : "Chờ mã pack"}
                      </Tag>
                      {draft.status === "OPEN" && (
                        <Popconfirm
                          title="Bỏ dòng này khỏi bản nháp?"
                          onConfirm={async () => {
                            await api(
                              `/inbound/drafts/${draft.id}/lines/${r.id}`,
                              { method: "DELETE" },
                            );
                            if (target === r.id) setTarget(undefined);
                            await load(draft.id);
                          }}
                        >
                          <Button type="text" danger>
                            Xóa
                          </Button>
                        </Popconfirm>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
            {draft.status === "OPEN" && (
              <div className="confirm-bar">
                <span>
                  {complete
                    ? "Đã đủ dữ liệu để xác nhận."
                    : "Hoàn tất mã pack và hạn dùng cho tất cả các dòng."}
                </span>
                <Popconfirm
                  title="Ghi sổ nhập kho cho toàn bộ phiếu?"
                  onConfirm={confirm}
                  disabled={!complete}
                >
                  <Button
                    type="primary"
                    icon={<CheckOutlined />}
                    disabled={!complete || user.role === "VIEWER"}
                    loading={busy}
                  >
                    Xác nhận nhập kho
                  </Button>
                </Popconfirm>
              </div>
            )}
          </Card>
        </>
      )}
      <Modal
        open={pairOpen}
        onCancel={() => setPairOpen(false)}
        title="Ghép nối điện thoại quét mã"
        footer={
          <Button
            danger
            onClick={async () => {
              await post(`/inbound/drafts/${draft.id}/revoke`);
              setPairOpen(false);
              message.success("Đã thu hồi các phiên quét của phiếu.");
            }}
          >
            Thu hồi phiên quét
          </Button>
        }
      >
        <div className="qr">
          <img src={qr} alt="Mã QR ghép nối điện thoại" />
          <p>
            Điện thoại phải truy cập được cùng địa chỉ máy chủ. Camera web cần
            HTTPS tin cậy trên thiết bị.
          </p>
          <small>
            Phiên quét có hạn 30 phút và chỉ được thêm dữ liệu vào phiếu này.
          </small>
        </div>
      </Modal>
    </>
  );
}
