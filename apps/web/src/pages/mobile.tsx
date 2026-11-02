import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Select,
  Segmented,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CameraOutlined,
  ScanOutlined,
  SearchOutlined,
  InboxOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
} from "@ant-design/icons";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { io, Socket } from "socket.io-client";

const { Text } = Typography;

export function MobileScanner() {
  const fragment = new URLSearchParams(location.hash.slice(1)),
    token = fragment.get("token") || "",
    draftId = fragment.get("draftId") || "",
    initialMode = fragment.get("mode") || (token && draftId ? "inbound" : "lookup");

  const isPairingMode = Boolean(token && draftId);
  const [activeTab, setActiveTab] = useState<"lookup" | "inbound">(() => {
    return isPairingMode && initialMode !== "lookup" ? "inbound" : "lookup";
  });

  const storageKey = `wms:pending:${draftId}`;
  const queue = useRef<any[]>([]),
    socket = useRef<Socket | null>(null),
    flushing = useRef(false),
    targetRef = useRef<string | undefined>(undefined),
    video = useRef<HTMLVideoElement>(null),
    controls = useRef<any>(null),
    audio = useRef<AudioContext | null>(null);

  // Inbound state
  const [online, setOnline] = useState(false),
    [revoked, setRevoked] = useState(false),
    [pending, setPending] = useState(0),
    [target, setTarget] = useState<string>(),
    [lines, setLines] = useState<any[]>([]),
    [inboundError, setInboundError] = useState(""),
    [accepted, setAccepted] = useState(""),
    [raw, setRaw] = useState(""),
    [camera, setCamera] = useState(false);

  // Lookup state
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupError, setLookupError] = useState("");

  const selectTarget = (id?: string) => {
    targetRef.current = id;
    setTarget(id);
  };

  const persist = () => {
    if (!draftId) return;
    localStorage.setItem(storageKey, JSON.stringify(queue.current));
    setPending(queue.current.length);
  };

  const state = async () => {
    if (!token) return;
    const r = await fetch("/api/v1/scanner/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (r.ok) setLines((await r.json()).lines);
  };

  const beep = () => {
    navigator.vibrate?.(70);
    const ctx = audio.current;
    if (ctx) {
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 1200;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.09);
    }
  };

  const beepError = () => {
    navigator.vibrate?.([100, 80, 100]);
    const ctx = audio.current;
    if (ctx) {
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 400;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.18);
    }
  };

  const activateAudio = () => {
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume();
    } catch {}
  };

  // Perform Lookup
  const executeLookup = async (code: string) => {
    const q = code.trim();
    if (!q) return;
    activateAudio();
    setLookupLoading(true);
    setLookupError("");
    try {
      const res = await fetch(
        `/api/v1/scanner/lookup?code=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      if (data.found) {
        beep();
        setLookupResult(data);
        setLookupError("");
      } else {
        beepError();
        setLookupError(data.message || `Không tìm thấy mã "${q}".`);
        setLookupResult(null);
      }
    } catch (e: any) {
      beepError();
      setLookupError("Lỗi kết nối tra cứu: " + e.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const flush = async () => {
    if (flushing.current || !socket.current?.connected) return;
    flushing.current = true;
    try {
      while (queue.current.length && socket.current?.connected) {
        const event = queue.current[0];
        let ack: any;
        try {
          ack = await socket.current
            .timeout(2500)
            .emitWithAck("scan:item", event);
        } catch {
          break;
        }
        if (ack.status === "ERROR") {
          setInboundError(`${ack.message} · Mã: ${event.raw}`);
          navigator.vibrate?.([100, 80, 100]);
          if (targetRef.current === event.newLineId) selectTarget(undefined);
        } else {
          beep();
          setAccepted(
            `Đã nhận ${ack.item?.mes_pack_no || "mã 1D"} vào bản nháp.`,
          );
          setInboundError("");
          if (
            ack.item?.status === "COMPLETE" &&
            targetRef.current === ack.item.id
          )
            selectTarget(undefined);
        }
        queue.current.shift();
        persist();
        void state();
      }
    } finally {
      flushing.current = false;
    }
  };

  const enqueue = (value: string) => {
    if (!value.trim() || revoked) return;
    if (queue.current.length >= 200) {
      setInboundError("Đã có 200 mã chờ gửi. Kết nối mạng để đồng bộ trước.");
      return;
    }
    const event: any = {
      draftId,
      scanEventId: crypto.randomUUID(),
      raw: value.trim(),
    };
    if (targetRef.current) event.targetLineId = targetRef.current;
    else {
      event.newLineId = crypto.randomUUID();
      selectTarget(event.newLineId);
    }
    queue.current.push(event);
    persist();
    setRaw("");
    void flush();
  };

  useEffect(() => {
    if (!token || !draftId) return;

    try {
      queue.current = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (!Array.isArray(queue.current)) queue.current = [];
      setPending(queue.current.length);
      const last = queue.current[queue.current.length - 1];
      if (last) selectTarget(last.targetLineId || last.newLineId);
    } catch {
      queue.current = [];
    }
    const s = io({
      transports: ["websocket"],
      auth: { token },
      reconnection: true,
    });
    socket.current = s;
    s.on("connect", () => setOnline(true));
    s.on("scanner:ready", () => {
      setOnline(true);
      setRevoked(false);
      void state();
      void flush();
    });
    s.on("disconnect", () => setOnline(false));
    s.on("session:revoked", () => {
      setRevoked(true);
      setOnline(false);
      setInboundError(
        "Phiên quét đã hết hạn hoặc bị thu hồi. Quét QR mới trên PC để tiếp tục.",
      );
      controls.current?.stop();
    });
    s.on("draft:changed", () => void state());
    const retry = setInterval(() => void flush(), 2000);
    let expiry = Date.now() + 30 * 60000;
    const refresh = setInterval(async () => {
      if (Date.now() < expiry - 5 * 60000) return;
      try {
        const r = await fetch("/api/v1/scanner/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (r.ok) expiry = new Date((await r.json()).expires_at).getTime();
        else if (r.status === 401 || r.status === 409) {
          setRevoked(true);
          s.disconnect();
          setInboundError(
            "Cần quét QR mới trên PC. Các mã chưa gửi vẫn được giữ trên thiết bị.",
          );
        }
      } catch {}
    }, 60000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (socket.current && !socket.current.connected) {
          socket.current.connect();
        }
        void state();
        void flush();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(retry);
      clearInterval(refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      s.disconnect();
      controls.current?.stop();
    };
  }, [token, draftId]);

  const startCamera = async () => {
    activateAudio();
    if (!window.isSecureContext) {
      const msg = "Camera cần HTTPS được điện thoại tin cậy. Kết nối qua địa chỉ HTTPS của máy chủ kho.";
      if (activeTab === "lookup") setLookupError(msg);
      else setInboundError(msg);
      return;
    }
    try {
      const reader = new BrowserMultiFormatReader();
      let last = "",
        seen = 0;
      controls.current = await reader.decodeFromConstraints(
        { video: { facingMode: "environment" } },
        video.current!,
        (result) => {
          if (result) {
            const text = result.getText();
            seen = Date.now();
            if (text !== last) {
              last = text;
              if (activeTab === "lookup") {
                setLookupQuery(text);
                void executeLookup(text);
              } else {
                enqueue(text);
              }
            }
          } else if (Date.now() - seen > 800) last = "";
        },
      );
      setCamera(true);
    } catch (e: any) {
      const msg = `Không mở được camera: ${e.message}`;
      if (activeTab === "lookup") setLookupError(msg);
      else setInboundError(msg);
    }
  };

  const stopCamera = () => {
    controls.current?.stop();
    setCamera(false);
  };

  return (
    <div className="mobile-shell">
      {/* Top Header */}
      <div className="mobile-top">
        <div className="brand-mark">W</div>
        <div>
          <b>Máy quét di động</b>
          <small>{isPairingMode ? `Phiếu: ${draftId.slice(0, 8)}` : "Chế độ tra cứu kho"}</small>
        </div>
        {isPairingMode ? (
          <Tag color={revoked ? "red" : online ? "green" : "gold"}>
            {revoked ? "Đã khóa" : online ? "Đã kết nối" : "Chờ kết nối"}
          </Tag>
        ) : (
          <Tag color="blue">🔍 Tra cứu tức thì</Tag>
        )}
      </div>

      {/* Mode Switcher */}
      {isPairingMode ? (
        <Segmented
          block
          size="large"
          className="section-gap"
          value={activeTab}
          onChange={(val) => {
            const nextMode = val as "lookup" | "inbound";
            setActiveTab(nextMode);
            if (nextMode === "inbound") {
              void state();
              void flush();
            }
          }}
          options={[
            {
              label: "🔍 Tra Cứu Hàng",
              value: "lookup",
              icon: <SearchOutlined />,
            },
            {
              label: "📥 Quét Nhập Kho",
              value: "inbound",
              icon: <InboxOutlined />,
            },
          ]}
        />
      ) : (
        <div style={{ marginBottom: 16 }}>
          <Tag color="cyan" style={{ fontSize: 13, padding: "4px 10px", width: "100%", textAlign: "center" }}>
            🔍 Chế độ Quét Mã Tra Cứu Thông Tin Hàng Hóa
          </Tag>
        </div>
      )}

      {/* Camera Viewport */}
      <div className="camera-frame">
        <video ref={video} playsInline muted />
        <div className="camera-guide" />
        <span>Đặt mã trong vùng quét</span>
      </div>

      {/* Camera Toggle Button */}
      <Space className="section-gap" style={{ width: "100%", justifyContent: "space-between" }}>
        <Button
          type="primary"
          size="large"
          icon={<CameraOutlined />}
          onClick={camera ? stopCamera : startCamera}
          disabled={activeTab === "inbound" && revoked}
          style={{ flex: 1 }}
        >
          {camera ? "Dừng camera" : "Bật camera quét"}
        </Button>
        {activeTab === "inbound" && (
          <Tag color={pending ? "gold" : "green"}>{pending} mã chờ ACK</Tag>
        )}
      </Space>

      {/* ================= CHẾ ĐỘ 1: TRA CỨU HÀNG HÓA ================= */}
      {activeTab === "lookup" && (
        <div style={{ marginTop: 12 }}>
          {lookupError && (
            <Alert
              className="section-gap"
              type="error"
              showIcon
              message={lookupError}
              closable
              onClose={() => setLookupError("")}
            />
          )}

          <Card title="🔍 Nhập hoặc Quét Mã Tra Cứu" size="small" style={{ borderRadius: 12 }}>
            <Input.Search
              size="large"
              placeholder="Quét hoặc nhập Part No, Lot, MES Pack..."
              enterButton={<Button type="primary" icon={<SearchOutlined />} loading={lookupLoading}>Tìm</Button>}
              value={lookupQuery}
              onChange={(e) => setLookupQuery(e.target.value)}
              onSearch={(val) => executeLookup(val)}
              allowClear
            />
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Hỗ trợ: Tem 2D MES Pack, Barcode 1D (Part|Lot), Mã linh kiện, Model.
            </p>
          </Card>

          {/* Lookup Result Display */}
          {lookupResult && (
            <Card
              style={{
                marginTop: 16,
                borderRadius: 14,
                border: "1px solid #cbd5e1",
                boxShadow: "0 6px 16px rgba(0,0,0,0.06)",
              }}
              bodyStyle={{ padding: "16px" }}
            >
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                <Tag color="blue" style={{ fontWeight: 700 }}>
                  Model: {lookupResult.product.model}
                </Tag>
                <Tag color="geekblue">FG: {lookupResult.product.finishedGoodsCode}</Tag>
                <Tag color="purple">ĐVT: {lookupResult.product.baseUom}</Tag>
              </div>

              <h3 style={{ margin: "0 0 4px", fontSize: 16.5, color: "#0f172a", fontWeight: 700 }}>
                {lookupResult.product.specification}
              </h3>
              <div style={{ color: "#475569", fontSize: 13.5, marginBottom: 14 }}>
                Mã linh kiện: <Text copyable style={{ color: "#0284c7", fontWeight: 600 }}>{lookupResult.product.partNo}</Text>
              </div>

              {/* Total Stock Summary */}
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 10,
                  padding: "10px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  textAlign: "center",
                  marginBottom: 16,
                }}
              >
                <div>
                  <small style={{ color: "#64748b", display: "block", fontSize: 10.5 }}>TỒN THỰC TẾ</small>
                  <span style={{ fontSize: 17, fontWeight: 800, color: "#0f172a" }}>
                    {Number(lookupResult.product.totalOnHand).toLocaleString()}
                  </span>
                </div>
                <div>
                  <small style={{ color: "#64748b", display: "block", fontSize: 10.5 }}>KHẢ DỤNG</small>
                  <span style={{ fontSize: 17, fontWeight: 800, color: "#059669" }}>
                    {Number(lookupResult.product.totalAvailable).toLocaleString()}
                  </span>
                </div>
                <div>
                  <small style={{ color: "#64748b", display: "block", fontSize: 10.5 }}>TỔNG PACK</small>
                  <span style={{ fontSize: 17, fontWeight: 800, color: "#6366f1" }}>
                    {lookupResult.product.totalPacks}
                  </span>
                </div>
              </div>

              {/* Chi tiết kiện cụ thể nếu quét trúng MES Pack */}
              {lookupResult.targetPack && (
                <div
                  style={{
                    background: "#eff6ff",
                    border: "1px solid #bfdbfe",
                    borderRadius: 10,
                    padding: "12px 14px",
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <b style={{ color: "#1e40af", fontSize: 14 }}>📦 Kiện Hàng Đang Quét</b>
                    <Tag
                      color={
                        lookupResult.targetPack.agingStatus === "GOOD"
                          ? "green"
                          : lookupResult.targetPack.agingStatus === "EXPIRING"
                            ? "orange"
                            : "red"
                      }
                      style={{ fontWeight: 600 }}
                    >
                      {lookupResult.targetPack.agingStatus === "GOOD"
                        ? `🟢 Còn hạn (${lookupResult.targetPack.daysLeft} ngày)`
                        : lookupResult.targetPack.agingStatus === "EXPIRING"
                          ? `🟡 Cận hạn (${lookupResult.targetPack.daysLeft} ngày)`
                          : `🔴 Đã hết hạn`}
                    </Tag>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.8, color: "#1e293b" }}>
                    <div>Mã Pack: <Text copyable style={{ fontWeight: 600 }}>{lookupResult.targetPack.mesPackNo}</Text></div>
                    <div>Số Lô: <b>{lookupResult.targetPack.lotNo}</b> · NCC: <b>{lookupResult.targetPack.vendorCode}</b></div>
                    <div>Số lượng kiện: <b style={{ color: "#0284c7" }}>{lookupResult.targetPack.onHand.toLocaleString()} {lookupResult.product.baseUom}</b></div>
                    <div>Vị trí kho: <Tag color="geekblue">{lookupResult.targetPack.locationCode}</Tag> · {lookupResult.targetPack.warehouseName}</div>
                    <div>Hạn dùng: <b>{lookupResult.targetPack.expiredDate}</b> (NSX: {lookupResult.targetPack.mfgDate})</div>
                    <div>Trạng thái kho: <Tag color={lookupResult.targetPack.stockStatus === "AVAILABLE" ? "success" : "warning"}>{lookupResult.targetPack.stockStatus}</Tag></div>
                  </div>
                </div>
              )}

              {/* Danh sách các pack trong kho theo FEFO nếu quét mã sản phẩm */}
              {lookupResult.packs && lookupResult.packs.length > 0 && (
                <div>
                  <b style={{ display: "block", margin: "0 0 8px", fontSize: 13, color: "#334155" }}>
                    📋 Danh Sách Kiện Trong Kho (Ưu tiên xuất FEFO):
                  </b>
                  <div style={{ maxHeight: 240, overflowY: "auto", paddingRight: 2 }}>
                    {lookupResult.packs.map((p: any) => (
                      <div
                        key={p.id}
                        style={{
                          background: "#fff",
                          border: "1px solid #e2e8f0",
                          borderRadius: 8,
                          padding: "8px 12px",
                          marginBottom: 6,
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <b>Lô: {p.lotNo}</b>
                          <span style={{ fontWeight: 700, color: "#0284c7" }}>
                            {p.onHand.toLocaleString()} {lookupResult.product.baseUom}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", marginTop: 3 }}>
                          <span>Vị trí: <Tag color="blue">{p.locationCode}</Tag></span>
                          <span>Hạn: <b>{p.expiredDate}</b></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Button
                block
                style={{ marginTop: 14 }}
                onClick={() => {
                  setLookupResult(null);
                  setLookupQuery("");
                }}
              >
                🔄 Quét / Tra cứu mã khác
              </Button>
            </Card>
          )}
        </div>
      )}

      {/* ================= CHẾ ĐỘ 2: QUÉT NHẬP KHO ================= */}
      {activeTab === "inbound" && (
        <>
          {inboundError && (
            <Alert className="section-gap" type="error" showIcon message={inboundError} />
          )}
          {accepted && (
            <Alert
              className="section-gap"
              type="success"
              showIcon
              message={accepted}
            />
          )}

          <Card className="section-gap" title="Dòng đang bổ sung" size="small" style={{ borderRadius: 12 }}>
            <Select
              allowClear
              placeholder="Dòng mới · quét 1D trước"
              value={target}
              onChange={selectTarget}
              style={{ width: "100%" }}
              options={[
                ...lines
                  .filter((l) => l.status !== "COMPLETE")
                  .map((l) => ({
                    value: l.id,
                    label: `${l.part_no} · ${l.mes_pack_no || "Chờ mã pack"}`,
                  })),
                ...(target && !lines.some((l) => l.id === target)
                  ? [{ value: target, label: "Dòng mới đang chờ gửi" }]
                  : []),
              ]}
            />
            <Button
              block
              className="section-gap"
              onClick={() => selectTarget(undefined)}
            >
              Bắt đầu pack mới
            </Button>
            <p className="muted" style={{ fontSize: 12 }}>
              Quét 1D → quét mã pack/2D. Bổ sung hạn dùng trên PC nếu tem không chứa ngày.
            </p>
            <Input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              onPressEnter={() => {
                activateAudio();
                enqueue(raw);
              }}
              placeholder="Hoặc nhập/dán mã tại đây"
              disabled={revoked}
            />
            <Button
              block
              icon={<ScanOutlined />}
              className="section-gap"
              type="primary"
              onClick={() => {
                activateAudio();
                enqueue(raw);
              }}
              disabled={revoked}
            >
              Gửi mã vào phiếu
            </Button>
          </Card>

          {/* Danh sách các kiện đã quét vào phiếu */}
          <Card
            className="section-gap"
            title={`📋 Danh Sách Đã Nhận (${lines.length} kiện)`}
            size="small"
            style={{ borderRadius: 12 }}
          >
            {lines.length === 0 ? (
              <p style={{ textAlign: "center", color: "#64748b", margin: "10px 0", fontSize: 13 }}>
                Chưa có mã nào trong phiếu. Hướng camera vào tem để quét.
              </p>
            ) : (
              <div style={{ maxHeight: 280, overflowY: "auto" }}>
                {lines.map((l: any, index: number) => (
                  <div
                    key={l.id || index}
                    style={{
                      background: l.status === "COMPLETE" ? "#f0fdf4" : "#fffbeb",
                      border: l.status === "COMPLETE" ? "1px solid #bbf7d0" : "1px solid #fde68a",
                      borderRadius: 8,
                      padding: "8px 12px",
                      marginBottom: 8,
                      fontSize: 12.5,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <b style={{ color: "#0f172a" }}>{l.part_no}</b>
                      <Tag color={l.status === "COMPLETE" ? "green" : "gold"}>
                        {l.status === "COMPLETE" ? "Đủ thông tin" : "Chờ mã pack"}
                      </Tag>
                    </div>
                    <div style={{ color: "#475569", marginTop: 3 }}>
                      Pack: <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{l.mes_pack_no || "---"}</span>
                    </div>
                    {(l.lot_no || l.quantity) && (
                      <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", marginTop: 2 }}>
                        <span>Lô: <b>{l.lot_no || "---"}</b></span>
                        <span>SL: <b>{Number(l.quantity || 0).toLocaleString()}</b></span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <p className="snapshot">
            Chỉ phát bíp khi máy chủ đã lưu dữ liệu. Mã chờ được giữ trên thiết bị;
            chưa làm thay đổi tồn kho.
          </p>
        </>
      )}
    </div>
  );
}
