import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Table,
  Tag,
} from "antd";
import {
  CloudUploadOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  HistoryOutlined,
} from "@ant-design/icons";
import { api, post, params, fmt } from "../api";
import type { PageProps } from "./operations";

const fieldLabels: Record<string, string> = {
  part_no: "Mã linh kiện (Code / 품번)",
  specification: "Tên vật liệu / Quy cách (자재명)",
  model: "Model sử dụng (사용 모델)",
  finished_goods_code: "Code thành phẩm (완제품 품번)",
  quantity: "Đồng bộ số lượng tồn kho (수량)",
  base_uom: "Đơn vị tính (단위)",
  vendor_code: "Mã nhà cung cấp (업체)",
  code: "Mã danh mục",
  name: "Tên danh mục",
  lot_no: "Số lô (lot_no)",
  mes_pack_no: "Mã pack / kiện (mes_pack_no)",
  expired_date: "Hạn sử dụng (expired_date)",
  status: "Trạng thái",
  reference: "Mã chứng từ",
  location_code: "Vị trí lưu kho",
};
const kinds = [
  { value: "PRODUCTS", label: "Danh mục sản phẩm" },
  { value: "VENDORS", label: "Nhà cung cấp" },
  { value: "LOCATIONS", label: "Vị trí kho" },
  { value: "OPENING_BALANCE", label: "Tồn đầu kỳ" },
  { value: "INBOUND", label: "Phiếu nhập hàng" },
];
export function Imports({ warehouse, user }: PageProps) {
  const [dirty, setDirty] = useState(false);
  const { message } = App.useApp();
  const [kind, setKind] = useState(
      user.role === "ADMIN" ? "PRODUCTS" : "INBOUND",
    ),
    [job, setJob] = useState<any>(),
    [jobs, setJobs] = useState<any[]>([]),
    [mapping, saveMapping] = useState<Record<string, number>>({}),
    [options, saveOptions] = useState<any>({
      headerRow: 1,
      dateFormat: "ISO",
      thousands: "",
    }),
    [profiles, setProfiles] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [rowBusy, setRowBusy] = useState<string | null>(null),
    [ack, setAck] = useState(false),
    [historyModalOpen, setHistoryModalOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    confirmKey = useRef(crypto.randomUUID());

  const deleteJob = async (id: string) => {
    try {
      await api(`/imports/${id}`, { method: "DELETE" });
      message.success("Đã xóa lượt nhập thành công.");
      if (job?.id === id) {
        setJob(undefined);
      }
      refreshJobs();
    } catch (e: any) {
      message.error(e.message || "Không thể xóa lượt nhập.");
    }
  };

  const cleanupJobs = async (onlyDrafts: boolean) => {
    try {
      const res = await api(
        `/imports?${params({ warehouseId: warehouse, onlyDrafts: String(onlyDrafts) })}`,
        { method: "DELETE" },
      );
      message.success(`Đã xóa ${res.deletedCount || 0} lượt nhập.`);
      setJob(undefined);
      refreshJobs();
    } catch (e: any) {
      message.error(e.message || "Lỗi khi xóa lịch sử.");
    }
  };
  const setMapping: typeof saveMapping = (value) => {
    setDirty(true);
    saveMapping(value);
  };
  const setOptions: typeof saveOptions = (value) => {
    setDirty(true);
    saveOptions(value);
  };
  const refreshJobs = () =>
    api(`/imports?warehouseId=${warehouse}`).then(setJobs);
  useEffect(() => {
    refreshJobs();
    api("/imports/profiles").then(setProfiles);
  }, []);

  const getSmartMapping = (
    fieldsList: string[],
    headerCells: any[],
    previewRows?: any[][],
  ) => {
    const map: Record<string, number> = {};
    const normHeaders = (headerCells || []).map((c: any, i: number) => ({
      index: i,
      raw: String(c?.value || ""),
      text: String(c?.value || "").toLowerCase().replace(/\r?\n/g, " ").trim(),
    }));

    for (const f of fieldsList) {
      if (f === "part_no") {
        const found =
          normHeaders.find(
            (h) =>
              (h.text.includes("품번") || h.text.includes("part") || h.text.includes("mã")) &&
              !h.text.includes("thành phẩm") &&
              !h.text.includes("완제품") &&
              !h.text.includes("stt"),
          ) ||
          normHeaders.find(
            (h) => h.text.startsWith("code") && !h.text.includes("thành phẩm"),
          );
        if (found) map[f] = found.index;
      } else if (f === "specification") {
        const found = normHeaders.find(
          (h) =>
            h.text.includes("tên vật liệu") ||
            h.text.includes("자재명") ||
            h.text.includes("quy cách") ||
            h.text.includes("tên") ||
            h.text.includes("spec") ||
            h.text.includes("desc"),
        );
        if (found) map[f] = found.index;
      } else if (f === "model") {
        const found = normHeaders.find(
          (h) =>
            h.text.includes("model") ||
            h.text.includes("mẫu") ||
            h.text.includes("모델"),
        );
        if (found) map[f] = found.index;
      } else if (f === "finished_goods_code") {
        const found = normHeaders.find(
          (h) =>
            (h.text.includes("thành phẩm") ||
              h.text.includes("완제품") ||
              h.text.includes("fg")) &&
            !h.text.includes("stt"),
        );
        if (found) map[f] = found.index;
      } else if (f === "vendor_code") {
        const found = normHeaders.find(
          (h) =>
            (h.text.includes("vendor") ||
              h.text.includes("nhà cung cấp") ||
              h.text.includes("ncc") ||
              h.text.includes("업체")) &&
            !h.text.includes("stt"),
        );
        if (found) map[f] = found.index;
      } else if (f === "base_uom") {
        const found = normHeaders.find(
          (h) =>
            h.text.includes("đơn vị") ||
            h.text.includes("uom") ||
            h.text.includes("đvt") ||
            h.text.includes("단위"),
        );
        if (found) map[f] = found.index;
      } else if (f === "lot_no") {
        const found = normHeaders.find(
          (h) => h.text.includes("lot") || h.text.includes("lô"),
        );
        if (found) map[f] = found.index;
      } else if (f === "mes_pack_no") {
        const found = normHeaders.find(
          (h) =>
            h.text.includes("pack") ||
            h.text.includes("cuộn") ||
            h.text.includes("thùng"),
        );
        if (found) map[f] = found.index;
      } else if (f === "quantity") {
        // Tìm các cột chứa ngày tháng hoặc chữ số lượng / tồn
        const candidateCols = normHeaders.filter(
          (h) =>
            /\d{4}-\d{2}-\d{2}/.test(h.raw) ||
            /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(h.raw) ||
            /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(h.text) ||
            /\d{1,2}\/\d{1,2}/.test(h.text) ||
            h.text.includes("tồn") ||
            h.text.includes("số lượng") ||
            h.text.includes("qty") ||
            h.text.includes("수량"),
        );
        let chosenCol: any = null;
        if (previewRows && previewRows.length) {
          chosenCol = [...candidateCols].reverse().find((c) =>
            previewRows.some((row) => {
              const val = row[c.index]?.value;
              return (
                typeof val === "number" ||
                (val !== null &&
                  val !== undefined &&
                  val !== "" &&
                  !isNaN(Number(String(val).replace(/[,.\s]/g, ""))))
              );
            }),
          );
        }
        if (!chosenCol && candidateCols.length) {
          chosenCol = candidateCols[candidateCols.length - 1];
        }
        if (chosenCol) map[f] = chosenCol.index;
      } else if (f === "expired_date") {
        const found = normHeaders.find(
          (h) =>
            h.text.includes("hạn") ||
            h.text.includes("exp") ||
            h.text.includes("expiry"),
        );
        if (found) map[f] = found.index;
      }
    }
    return map;
  };

  const findSmartHeaderRow = (rows: any[][]) => {
    for (let r = 0; r < Math.min(5, (rows || []).length); r++) {
      const texts = (rows[r] || []).map((c: any) =>
        String(c?.value || "").toLowerCase().replace(/\r?\n/g, " ").trim(),
      );
      if (
        texts.some(
          (t) =>
            t.includes("stt") ||
            t.includes("code") ||
            t.includes("part") ||
            t.includes("tên") ||
            t.includes("품번") ||
            t.includes("자재명"),
        )
      ) {
        return r + 1;
      }
    }
    return 1;
  };

  const adopt = (j: any) => {
    setJob(j);
    setKind(j.kind);
    const firstSheet = j.sheets[0];
    const detectedHeaderRow = findSmartHeaderRow(firstSheet?.preview || []);
    const initialOptions = j.options?.sheet
      ? j.options
      : {
          sheet: firstSheet?.name,
          headerRow: detectedHeaderRow,
          dateFormat: "ISO",
          thousands: "",
        };
    setOptions(initialOptions);

    if (j.mapping && Object.keys(j.mapping).length > 0) {
      setMapping(j.mapping);
    } else {
      const curHeaders = firstSheet?.preview[initialOptions.headerRow - 1] || [];
      const autoMap = getSmartMapping(
        j.fields,
        curHeaders,
        firstSheet?.preview?.slice(initialOptions.headerRow),
      );
      setMapping(autoMap);
    }
    confirmKey.current = crypto.randomUUID();
    setAck(false);
    setDirty(false);
  };
  const upload = async (selected: File) => {
    setBusy(true);
    try {
      const data = new FormData();
      data.append("file", selected);
      const r = await api(
        `/imports?${params({ warehouseId: warehouse, kind })}`,
        { method: "POST", body: data },
      );
      adopt(await api(`/imports/${r.id}`));
      refreshJobs();
      if (r.previousImportId)
        message.warning(
          "File này từng được tải. Kiểm tra lịch sử trước khi xác nhận.",
        );
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const validate = async () => {
    setBusy(true);
    try {
      await post(`/imports/${job.id}/mapping`, { mapping, options }, "PUT");
      await post(`/imports/${job.id}/validate`);
      adopt(await api(`/imports/${job.id}`));
      message.success("Đã kiểm tra dữ liệu. Chưa thay đổi tồn kho.");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await api(`/imports/${job.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": confirmKey.current },
        body: JSON.stringify({
          previewVersion: job.preview_version,
          acknowledgeWarnings: ack,
        }),
      });
      adopt(await api(`/imports/${job.id}`));
      refreshJobs();
      message.success("Đã nhập dữ liệu và ghi nhận lịch sử.");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const toggleSkipRow = async (rowId: string) => {
    if (!job) return;
    setRowBusy(rowId);
    try {
      const res: any = await post(`/imports/${job.id}/rows/${rowId}/toggle-skip`, {});
      setJob((prev: any) => {
        if (!prev) return prev;
        return {
          ...prev,
          summary: res.summary,
          rows: prev.rows.map((r: any) =>
            r.id === rowId ? { ...r, status: res.status } : r,
          ),
        };
      });
      message.success(
        res.status === "SKIPPED"
          ? "Đã bỏ qua dòng này khỏi danh sách nhập."
          : "Đã khôi phục dòng này vào danh sách nhập.",
      );
    } catch (e: any) {
      message.error("Lỗi cập nhật dòng: " + (e.message || "Không xác định"));
    } finally {
      setRowBusy(null);
    }
  };
  const sheet = job?.sheets.find((s: any) => s.name === options.sheet),
    headers = sheet?.preview[options.headerRow - 1] || [],
    done = job?.status === "COMPLETED";
  return (
    <>
      <Card className="section-bottom">
        <div className="intro-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2>Đưa dữ liệu sẵn có vào hệ thống</h2>
            <p>
              Tải file, ghép cột và đối soát trước khi xác nhận. Tối đa 1.000
              dòng, 5 MB mỗi file.
            </p>
          </div>
          <Space wrap>
            <Select
              placeholder="Mở lượt nhập trước"
              style={{ width: 340 }}
              value={job?.id}
              options={jobs.map((j) => {
                const timeStr = j.created_at
                  ? new Date(j.created_at).toLocaleString("vi-VN", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "";
                const statusText =
                  j.status === "COMPLETED"
                    ? "Đã nhập"
                    : j.status === "VALIDATED"
                      ? "Đã kiểm tra"
                      : "Bản nháp";
                return {
                  value: j.id,
                  label: `${j.file_name} (${timeStr}) · ${statusText}`,
                };
              })}
              onChange={async (id) => adopt(await api(`/imports/${id}`))}
            />
            <Button
              icon={<HistoryOutlined />}
              onClick={() => setHistoryModalOpen(true)}
            >
              Quản lý lịch sử ({jobs.length})
            </Button>
          </Space>
        </div>
        <Steps
          current={!job ? 0 : done ? 3 : job.status === "VALIDATED" ? 2 : 1}
          items={[
            { title: "Chọn file" },
            { title: "Ghép cột" },
            { title: "Kiểm tra" },
            { title: "Hoàn tất" },
          ]}
        />
      </Card>
      <Card>
        <div className="toolbar">
          <Select
            value={kind}
            disabled={!!job && !done}
            onChange={(v) => {
              setKind(v);
              setJob(undefined);
            }}
            options={kinds.filter(
              (k) => user.role === "ADMIN" || k.value === "INBOUND",
            )}
            style={{ width: 250 }}
          />
          <Space>
            <Button
              icon={<DownloadOutlined />}
              href={`/api/v1/imports/template/${kind}`}
            >
              Tải mẫu chuẩn
            </Button>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              onClick={() => file.current?.click()}
              loading={busy}
              disabled={user.role === "VIEWER"}
            >
              Chọn file Excel / CSV
            </Button>
          </Space>
          <input
            hidden
            ref={file}
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => {
              if (e.target.files?.[0]) upload(e.target.files[0]);
            }}
          />
        </div>
        {kind === "OPENING_BALANCE" && (
          <Alert
            type="warning"
            showIcon
            message="Chỉ chốt tồn đầu kỳ cho kho chưa phát sinh giao dịch. Hàng hết hạn được ghi nhận EXPIRED; dữ liệu thiếu pack/lot/vị trí phải được bổ sung trước."
            style={{ marginBottom: 20 }}
          />
        )}
        {!job ? (
          <div className="import-empty">
            <CloudUploadOutlined />
            <h3>Bắt đầu bằng file của bạn</h3>
            <p>
              Hỗ trợ .xlsx và CSV UTF-8. Giữ các cột mã dạng Text, ngày dạng
              YYYY-MM-DD.
            </p>
            <Button onClick={() => file.current?.click()}>
              Duyệt file trên máy
            </Button>
          </div>
        ) : (
          <>
            <div
              className="job-title"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div>
                <b>{job.file_name}</b>{" "}
                <Tag color={done ? "green" : job.status === "VALIDATED" ? "blue" : "default"}>
                  {job.status === "COMPLETED"
                    ? "Đã nhập thành công"
                    : job.status === "VALIDATED"
                      ? "Đã kiểm tra"
                      : "Bản nháp"}
                </Tag>
                {job.created_at && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                    Tải lên lúc: {new Date(job.created_at).toLocaleString("vi-VN")}
                  </span>
                )}
              </div>
              <Popconfirm
                title="Xóa lượt nhập này?"
                description="Hệ thống sẽ xóa file nháp này khỏi danh sách."
                onConfirm={() => deleteJob(job.id)}
                okText="Xóa"
                cancelText="Hủy"
              >
                <Button danger size="small" icon={<DeleteOutlined />}>
                  Xóa lượt nhập này
                </Button>
              </Popconfirm>
            </div>
            {!done && (
              <>
                <div className="mapping-options">
                  <label>
                    Sheet
                    <Select
                      value={options.sheet}
                      onChange={(sheet) => setOptions({ ...options, sheet })}
                      options={job.sheets.map((s: any) => ({
                        value: s.name,
                        label: s.name,
                      }))}
                    />
                  </label>
                  <label>
                    Hàng tiêu đề
                    <InputNumber
                      min={1}
                      max={20}
                      value={options.headerRow}
                      onChange={(headerRow) => {
                        const hr = headerRow || 1;
                        const curHeaders = sheet?.preview[hr - 1] || [];
                        const autoMap = getSmartMapping(
                          job.fields,
                          curHeaders,
                          sheet?.preview?.slice(hr),
                        );
                        setOptions({ ...options, headerRow: hr });
                        setMapping(autoMap);
                      }}
                    />
                  </label>
                  <label>
                    Ngày trong file
                    <Select
                      value={options.dateFormat}
                      onChange={(dateFormat) =>
                        setOptions({ ...options, dateFormat })
                      }
                      options={[
                        { value: "ISO", label: "YYYY-MM-DD" },
                        { value: "DMY", label: "DD/MM/YYYY" },
                        { value: "MDY", label: "MM/DD/YYYY" },
                      ]}
                    />
                  </label>
                  <label>
                    Phân cách nghìn
                    <Select
                      value={options.thousands}
                      onChange={(thousands) =>
                        setOptions({ ...options, thousands })
                      }
                      options={[
                        { value: "", label: "Không có" },
                        { value: ",", label: "Dấu phẩy (,)" },
                        { value: ".", label: "Dấu chấm (.)" },
                      ]}
                    />
                  </label>
                  <label>
                    Profile có sẵn
                    <Select
                      allowClear
                      placeholder="Chọn cấu hình đã lưu"
                      onChange={(id) => {
                        const p = profiles.find((p) => p.id === id);
                        if (p) {
                          setMapping(p.mapping);
                          setOptions({ ...p.options, sheet: options.sheet });
                        }
                      }}
                      options={profiles
                        .filter((p) => p.kind === kind)
                        .map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </label>
                </div>
                <Alert
                  type="info"
                  showIcon
                  message="💡 Hướng dẫn ghép cột file Báo Cáo Tồn:"
                  description={
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                      <div><b>1. Hàng tiêu đề:</b> Hãy đặt là <b>2</b> (để nhận đúng các cột từ hàng 2 của file Excel).</div>
                      <div><b>2. part_no (Mã linh kiện):</b> Chọn <b>Cột 5 (Code / 품번)</b> ví dụ <code>GH64-10383A-LA</code>. Tuyệt đối không chọn Cột 1 STT. Với sản phẩm không có mã có thể để trống.</div>
                      <div><b>3. specification (Tên vật liệu):</b> Chọn <b>Cột 4 (Tên vật liệu / 자재명)</b> ví dụ <code>DECO RATION CAM LOWER</code>.</div>
                      <div><b>4. model (Model sử dụng):</b> Chọn <b>Cột 2 (Model sử dụng / 사용 모델)</b> ví dụ <code>SM-S741U (R14)</code>.</div>
                      <div><b>5. finished_goods_code (Code thành phẩm):</b> Chọn <b>Cột 3 (Code thành phẩm 완제품 품번)</b> ví dụ <code>GH98-51260A</code>.</div>
                      <div><b>6. quantity (Đồng bộ số lượng tồn):</b> Chọn cột ngày tồn bạn muốn cập nhật (ví dụ Cột 16: <code>30-Oct</code> hoặc Cột 17: <code>31-Oct</code>). Hệ thống sẽ tự động đồng bộ tồn kho thực tế vào WMS!</div>
                      <div><b>7. vendor_code / base_uom:</b> Nếu file không có, bấm dấu <b>✕ để bỏ trống</b>.</div>
                    </div>
                  }
                  style={{ marginBottom: 16 }}
                />
                <div className="mapping-grid">
                  {job.fields.map((field: string) => (
                    <label key={field}>
                      <span style={{ fontWeight: 600 }}>{fieldLabels[field] || field}</span>
                      <Select
                        allowClear
                        placeholder="Chọn cột trong file"
                        value={mapping[field]}
                        options={headers.map((c: any, i: number) => {
                          let labelText = String(c?.value ?? "");
                          if (
                            labelText.includes("T00:00:00.000Z") ||
                            labelText.includes("GMT+")
                          ) {
                            const d = new Date(labelText);
                            if (!isNaN(d.getTime())) {
                              const dd = String(d.getDate()).padStart(2, "0");
                              const mm = String(d.getMonth() + 1).padStart(
                                2,
                                "0",
                              );
                              labelText = `Ngày ${dd}/${mm}/${d.getFullYear()}`;
                            }
                          }
                          return {
                            value: i,
                            label: `${i + 1}. ${labelText || "(trống)"}`,
                          };
                        })}
                        onChange={(v) =>
                          setMapping((m) => {
                            const n = { ...m };
                            if (v === undefined) delete n[field];
                            else n[field] = v;
                            return n;
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="toolbar">
                  <Input
                    placeholder="Tên profile nếu muốn lưu lại cách ghép cột"
                    value={options.profileName || ""}
                    onChange={(e) =>
                      setOptions({ ...options, profileName: e.target.value })
                    }
                    style={{ maxWidth: 400 }}
                  />
                  <Button type="primary" onClick={validate} loading={busy}>
                    Kiểm tra dữ liệu
                  </Button>
                </div>
                <details className="source-preview">
                  <summary>Xem các dòng đầu của file nguồn</summary>
                  <pre>
                    {sheet?.preview
                      .map((row: any[]) =>
                        row.map((c) => c.value ?? "").join(" | "),
                      )
                      .join("\n")}
                  </pre>
                </details>
              </>
            )}
            {job.summary && (
              <>
                <div className="import-summary">
                  {[
                    { label: "Hợp lệ", value: job.summary.valid },
                    { label: "Có lỗi", value: job.summary.errors },
                    { label: "Bỏ qua", value: job.summary.skipped },
                    { label: "Tạo mới", value: job.summary.create },
                    { label: "Cập nhật", value: job.summary.update },
                  ].map((v) => (
                    <div key={v.label}>
                      <span>{v.label}</span>
                      <b>{fmt(v.value)}</b>
                    </div>
                  ))}
                </div>
                <p>
                  {Object.entries(job.summary.totals || {}).map(([u, n]) => (
                    <Tag key={u}>
                      {fmt(n)} {u}
                    </Tag>
                  ))}
                </p>
                <Table<any>
                  rowKey="id"
                  size="small"
                  scroll={{ x: 900 }}
                  dataSource={job.rows}
                  pagination={{ pageSize: 20 }}
                  columns={[
                    {
                      title: "Dòng nguồn",
                      dataIndex: "source_row",
                      width: 90,
                    },
                    {
                      title: "Dữ liệu nhận diện",
                      render: (_, r) => {
                        const isMissingCode =
                          r.normalized?.is_missing_code ||
                          !r.normalized?.part_no;
                        const isDuplicate =
                          r.normalized?.is_duplicate ||
                          r.normalized?.action === "MERGE";
                        return (
                          <>
                            {isMissingCode ? (
                              <div
                                style={{
                                  background: "#fef08a",
                                  border: "1.5px solid #eab308",
                                  borderRadius: 6,
                                  padding: "3px 8px",
                                  color: "#854d0e",
                                  fontWeight: "bold",
                                  fontSize: 12,
                                  display: "inline-block",
                                  marginBottom: 4,
                                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                                }}
                              >
                                ⚠️ CHƯA CÓ MÃ CODE (NULL)
                              </div>
                            ) : (
                              <b className="code">
                                {r.normalized?.part_no || r.normalized?.code}
                              </b>
                            )}
                            {isDuplicate && (
                              <div style={{ marginTop: 2 }}>
                                <Tag color="orange" style={{ fontWeight: 600 }}>
                                  🔁 Trùng mã trong file (Tự động gộp thành phẩm)
                                </Tag>
                              </div>
                            )}
                            <div style={{ marginTop: 2, fontWeight: 500 }}>
                              {r.normalized?.mes_pack_no ||
                                r.normalized?.specification ||
                                r.normalized?.name}
                            </div>
                            {(r.normalized?.model ||
                              r.normalized?.finished_goods_code) && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "#64748b",
                                  marginTop: 3,
                                  display: "flex",
                                  gap: 4,
                                  flexWrap: "wrap",
                                }}
                              >
                                {r.normalized?.model && (
                                  <Tag color="cyan">
                                    Model: {r.normalized.model}
                                  </Tag>
                                )}
                                {r.normalized?.finished_goods_code && (
                                  <Tag color="geekblue">
                                    TP: {r.normalized.finished_goods_code}
                                  </Tag>
                                )}
                              </div>
                            )}
                          </>
                        );
                      },
                    },
                    {
                      title: "Thao tác",
                      width: 90,
                      render: (_, r) => (
                        <Tag
                          color={
                            r.normalized?.action === "MERGE"
                              ? "orange"
                              : r.normalized?.action === "UPDATE"
                                ? "blue"
                                : "default"
                          }
                        >
                          {r.normalized?.action || "—"}
                        </Tag>
                      ),
                    },
                    {
                      title: "Xử lý dòng",
                      width: 120,
                      render: (_, r) =>
                        !done && (
                          <Space size={4}>
                            {r.status === "SKIPPED" ? (
                              <Button
                                size="small"
                                type="dashed"
                                onClick={() => toggleSkipRow(r.id)}
                                loading={rowBusy === r.id}
                              >
                                ↩️ Khôi phục
                              </Button>
                            ) : (
                              <Button
                                size="small"
                                danger
                                type="text"
                                onClick={() => toggleSkipRow(r.id)}
                                loading={rowBusy === r.id}
                              >
                                🗑️ Bỏ qua
                              </Button>
                            )}
                          </Space>
                        ),
                    },
                    {
                      title: "Giá trị trước / sau",
                      render: (_, r) =>
                        r.normalized?.before ? (
                          <small>
                            {r.normalized.before.specification ||
                              r.normalized.before.name}{" "}
                            → {r.normalized.specification || r.normalized.name}
                          </small>
                        ) : r.normalized?.quantity !== undefined ? (
                          `${fmt(r.normalized.quantity)} ${r.normalized.base_uom || ""}`
                        ) : (
                          "Tạo mới"
                        ),
                    },
                    {
                      title: "Kết quả kiểm tra",
                      render: (_, r) => (
                        <>
                          <Tag
                            color={
                              r.status === "ERROR"
                                ? "red"
                                : r.status === "SKIPPED"
                                  ? "gold"
                                  : "green"
                            }
                          >
                            {r.status}
                          </Tag>
                          {r.errors.map((e: any, i: number) => (
                            <div className="error-text" key={i}>
                              {e.column}: {e.message}
                            </div>
                          ))}
                          {r.warnings.map((s: string) => (
                            <div className="warning-text" key={s}>
                              {s}
                            </div>
                          ))}
                        </>
                      ),
                    },
                  ]}
                />
                <div className="confirm-bar">
                  <Button
                    href={`/api/v1/imports/${job.id}/errors.xlsx`}
                    icon={<DownloadOutlined />}
                  >
                    Tải file lỗi / cảnh báo
                  </Button>
                  {!done && (
                    <Space>
                      <Checkbox
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                      >
                        Đã đối soát các cảnh báo
                      </Checkbox>
                      <Popconfirm
                        title="Xác nhận nhập toàn bộ file đã kiểm tra?"
                        description="Nếu có lỗi ghi dữ liệu, toàn bộ file sẽ rollback ở phiên bản này."
                        onConfirm={confirm}
                      >
                        <Button
                          type="primary"
                          icon={<CheckCircleOutlined />}
                          disabled={
                            dirty ||
                            job.summary.errors > 0 ||
                            job.summary.valid === 0
                          }
                          loading={busy}
                        >
                          Xác nhận nhập dữ liệu
                        </Button>
                      </Popconfirm>
                    </Space>
                  )}
                  {done && (
                    <Tag color="green">
                      Đã nhập {fmt(job.summary.committed)} dòng
                    </Tag>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </Card>

      <Modal
        title="Quản lý lịch sử các lượt nhập file"
        open={historyModalOpen}
        onCancel={() => setHistoryModalOpen(false)}
        footer={null}
        width={850}
      >
        <div
          style={{
            marginBottom: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span>
            Tổng số lượt nhập lưu trong kho: <b>{jobs.length}</b>
          </span>
          <Space>
            <Popconfirm
              title="Dọn dẹp các bản nháp?"
              description="Hệ thống sẽ xóa tất cả các lượt tải lên chưa được xác nhận nhập kho."
              onConfirm={() => cleanupJobs(true)}
              okText="Dọn dẹp"
              cancelText="Hủy"
            >
              <Button danger icon={<DeleteOutlined />}>
                Xóa tất cả bản nháp
              </Button>
            </Popconfirm>
            {user.role === "ADMIN" && (
              <Popconfirm
                title="Xóa toàn bộ lịch sử?"
                description="Bạn có chắc chắn muốn xóa hết tất cả các lượt nhập file (kể cả đã hoàn tất)?"
                onConfirm={() => cleanupJobs(false)}
                okText="Xóa tất cả"
                cancelText="Hủy"
              >
                <Button danger type="primary">
                  Xóa toàn bộ lịch sử
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
        <Table
          dataSource={jobs}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 8 }}
          columns={[
            {
              title: "Tên file",
              dataIndex: "file_name",
              render: (t: string) => <b>{t}</b>,
            },
            {
              title: "Loại nhập",
              dataIndex: "kind",
              render: (k: string) =>
                kinds.find((item) => item.value === k)?.label || k,
            },
            {
              title: "Thời gian tải lên",
              dataIndex: "created_at",
              render: (t: string) =>
                t ? new Date(t).toLocaleString("vi-VN") : "—",
            },
            {
              title: "Trạng thái",
              dataIndex: "status",
              render: (st: string) => (
                <Tag
                  color={
                    st === "COMPLETED"
                      ? "green"
                      : st === "VALIDATED"
                        ? "blue"
                        : "default"
                  }
                >
                  {st === "COMPLETED"
                    ? "Đã nhập"
                    : st === "VALIDATED"
                      ? "Đã kiểm tra"
                      : "Bản nháp"}
                </Tag>
              ),
            },
            {
              title: "Thao tác",
              key: "actions",
              render: (_: any, record: any) => (
                <Space>
                  <Button
                    size="small"
                    type="link"
                    onClick={async () => {
                      setHistoryModalOpen(false);
                      adopt(await api(`/imports/${record.id}`));
                    }}
                  >
                    Mở lại
                  </Button>
                  <Popconfirm
                    title="Xóa lượt nhập này?"
                    description="Xóa vĩnh viễn lượt nhập này khỏi lịch sử?"
                    onConfirm={() => deleteJob(record.id)}
                    okText="Xóa"
                    cancelText="Hủy"
                  >
                    <Button size="small" type="link" danger>
                      Xóa
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </>
  );
}
