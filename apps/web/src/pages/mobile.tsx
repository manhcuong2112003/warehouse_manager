import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Select, Space, Tag } from "antd";
import { CameraOutlined, ScanOutlined } from "@ant-design/icons";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { io, Socket } from "socket.io-client";
export function MobileScanner() {
  const fragment = new URLSearchParams(location.hash.slice(1)),
    token = fragment.get("token") || "",
    draftId = fragment.get("draftId") || "";
  const storageKey = `wms:pending:${draftId}`;
  const queue = useRef<any[]>([]),
    socket = useRef<Socket | null>(null),
    flushing = useRef(false),
    targetRef = useRef<string | undefined>(undefined),
    video = useRef<HTMLVideoElement>(null),
    controls = useRef<any>(null),
    audio = useRef<AudioContext | null>(null);
  const [online, setOnline] = useState(false),
    [revoked, setRevoked] = useState(false),
    [pending, setPending] = useState(0),
    [target, setTarget] = useState<string>(),
    [lines, setLines] = useState<any[]>([]),
    [error, setError] = useState(""),
    [accepted, setAccepted] = useState(""),
    [raw, setRaw] = useState(""),
    [camera, setCamera] = useState(false);
  const selectTarget = (id?: string) => {
    targetRef.current = id;
    setTarget(id);
  };
  const persist = () => {
    localStorage.setItem(storageKey, JSON.stringify(queue.current));
    setPending(queue.current.length);
  };
  const state = async () => {
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
  const activateAudio = () => {
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume();
    } catch {}
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
          setError(`${ack.message} · Mã: ${event.raw}`);
          navigator.vibrate?.([100, 80, 100]);
          if (targetRef.current === event.newLineId) selectTarget(undefined);
        } else {
          beep();
          setAccepted(
            `Đã nhận ${ack.item?.mes_pack_no || "mã 1D"} vào bản nháp.`,
          );
          setError("");
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
      setError("Đã có 200 mã chờ gửi. Kết nối mạng để đồng bộ trước.");
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
      setError(
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
          setError(
            "Cần quét QR mới trên PC. Các mã chưa gửi vẫn được giữ trên thiết bị.",
          );
        }
      } catch {}
    }, 60000);
    return () => {
      clearInterval(retry);
      clearInterval(refresh);
      s.disconnect();
      controls.current?.stop();
    };
  }, []);
  const start = async () => {
    activateAudio();
    if (!window.isSecureContext) {
      setError(
        "Camera cần HTTPS được điện thoại tin cậy. Kết nối qua địa chỉ HTTPS của máy chủ kho.",
      );
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
              enqueue(text);
            }
          } else if (Date.now() - seen > 800) last = "";
        },
      );
      setCamera(true);
    } catch (e: any) {
      setError(`Không mở được camera: ${e.message}`);
    }
  };
  if (!token || !draftId)
    return (
      <div className="mobile-shell">
        <Alert
          type="error"
          message="Quét QR ghép nối từ màn hình PC để mở máy quét."
        />
      </div>
    );
  return (
    <div className="mobile-shell">
      <div className="mobile-top">
        <div className="brand-mark">W</div>
        <div>
          <b>Máy quét kho</b>
          <small>Phiếu {draftId.slice(0, 8)}</small>
        </div>
        <Tag color={revoked ? "red" : online ? "green" : "gold"}>
          {revoked ? "Đã khóa" : online ? "Đã kết nối" : "Chờ kết nối"}
        </Tag>
      </div>
      <div className="camera-frame">
        <video ref={video} playsInline muted />
        <div className="camera-guide" />
        <span>Đặt mã trong vùng quét</span>
      </div>
      <Space className="section-gap">
        <Button
          type="primary"
          icon={<CameraOutlined />}
          onClick={
            camera
              ? () => {
                  controls.current?.stop();
                  setCamera(false);
                }
              : start
          }
          disabled={revoked}
        >
          {camera ? "Dừng camera" : "Mở camera"}
        </Button>
        <Tag color={pending ? "gold" : "green"}>{pending} mã chờ ACK</Tag>
      </Space>
      {error && (
        <Alert className="section-gap" type="error" showIcon message={error} />
      )}{" "}
      {accepted && (
        <Alert
          className="section-gap"
          type="success"
          showIcon
          message={accepted}
        />
      )}
      <Card className="section-gap" title="Dòng đang bổ sung">
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
        <p className="muted">
          Quét 1D → quét mã pack/2D. Bổ sung hạn dùng trên PC nếu tem không chứa
          ngày.
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
          onClick={() => {
            activateAudio();
            enqueue(raw);
          }}
          disabled={revoked}
        >
          Gửi mã
        </Button>
      </Card>
      <p className="snapshot">
        Chỉ phát bíp khi máy chủ đã lưu dữ liệu. Mã chờ được giữ trên thiết bị;
        chưa làm thay đổi tồn kho.
      </p>
    </div>
  );
}
