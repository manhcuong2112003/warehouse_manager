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
  Typography,
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
import {
  resolveInitialHostIp,
  getDetectedHostIps,
  saveLanIp,
  buildMobileScanUrl,
} from "../lan-utils";
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
    [feedback, setFeedback] = useState(""),
    [hostLanIp, setHostLanIp] = useState<string>(() => resolveInitialHostIp()),
    [detectedIps, setDetectedIps] = useState<string[]>(() => getDetectedHostIps()),
    [pairToken, setPairToken] = useState<string>(""),
    [fullPairUrl, setFullPairUrl] = useState<string>("");

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.ips && Array.isArray(e.detail.ips)) {
        setDetectedIps(e.detail.ips);
        setHostLanIp((prev) => prev || e.detail.ips[0] || "");
      }
    };
    window.addEventListener("wms-host-ips", handler);
    return () => window.removeEventListener("wms-host-ips", handler);
  }, []);
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
  const generatePairQr = async (tokenVal: string, draftIdVal: string, ipVal: string) => {
    const hash = new URLSearchParams({
      token: tokenVal,
      draftId: draftIdVal,
    }).toString();
    const fullUrl = buildMobileScanUrl("/mobile-scan", hash, ipVal);
    setFullPairUrl(fullUrl);
    setQr(await QRCode.toDataURL(fullUrl, { width: 300, margin: 1 }));
  };

  const pair = async () => {
    try {
      const p = await post(`/inbound/drafts/${draft.id}/pair`);
      setPairToken(p.token);
      const ip = hostLanIp || resolveInitialHostIp() || (detectedIps[0] ?? "");
      setHostLanIp(ip);
      await generatePairQr(p.token, draft.id, ip);
      setPairOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const handlePairIpChange = async (newIp: string) => {
    const trimmed = newIp.trim();
    setHostLanIp(trimmed);
    saveLanIp(trimmed);
    if (pairToken && draft?.id) {
      await generatePairQr(pairToken, draft.id, trimmed);
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
        title="📱 Ghép nối điện thoại quét mã nhập kho"
        width={480}
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
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          {/* Cấu hình IP máy tính trong mạng Wifi */}
          <div
            style={{
              textAlign: "left",
              background: "#f1f5f9",
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <b style={{ fontSize: 13, color: "#0f172a" }}>🌐 IP máy chủ kho (trong Wifi):</b>
              {detectedIps.length > 0 && (
                <Tag color="cyan">Tự động nhận diện</Tag>
              )}
            </div>
            <Input
              value={hostLanIp}
              onChange={(e) => handlePairIpChange(e.target.value)}
              placeholder="Nhập IP máy tính (vd: 10.2.80.86 hoặc 192.168.1.10)"
              style={{ fontWeight: 600 }}
              allowClear
            />
            {detectedIps.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <small style={{ color: "#64748b" }}>IP tìm thấy:</small>
                {detectedIps.map((ip) => (
                  <Tag
                    key={ip}
                    color={hostLanIp === ip ? "blue" : "default"}
                    style={{ cursor: "pointer" }}
                    onClick={() => handlePairIpChange(ip)}
                  >
                    {ip}
                  </Tag>
                ))}
              </div>
            )}
            <small style={{ display: "block", color: "#64748b", marginTop: 6, lineHeight: 1.4 }}>
              💡 Điện thoại và máy tính cần kết nối chung một mạng Wifi (hoặc điện thoại bật Điểm phát sóng/Hotspot cho máy tính).
            </small>
          </div>

          {/* QR image */}
          {qr && (
            <img
              src={qr}
              alt="Mã QR ghép nối điện thoại"
              style={{
                width: 230,
                height: 230,
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
              }}
            />
          )}

          {fullPairUrl && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text copyable={{ text: fullPairUrl }} style={{ fontSize: 13, color: "#0284c7", fontWeight: 600 }}>
                {fullPairUrl}
              </Typography.Text>
            </div>
          )}

          <Alert
            style={{ marginTop: 14, textAlign: "left" }}
            type="info"
            showIcon
            message="Lưu ý khi điện thoại mở lần đầu:"
            description={
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                Nếu điện thoại báo <b>"Kết nối không phải là riêng tư"</b>, hãy bấm <b>"Nâng cao" (Advanced)</b> ➔ chọn <b>"Tiếp tục truy cập (không an toàn)"</b> để vào máy quét.
              </div>
            }
          />
        </div>
      </Modal>
    </>
  );
}
