import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
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
} from "@ant-design/icons";
import { api, post, params, fmt } from "../api";
import type { PageProps } from "./operations";
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
    [ack, setAck] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    confirmKey = useRef(crypto.randomUUID());
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
  const adopt = (j: any) => {
    setJob(j);
    setKind(j.kind);
    setOptions(
      j.options?.sheet
        ? j.options
        : {
            sheet: j.sheets[0]?.name,
            headerRow: 1,
            dateFormat: "ISO",
            thousands: "",
          },
    );
    if (j.mapping) setMapping(j.mapping);
    else {
      const headers =
        j.sheets[0]?.preview[0]?.map((v: any) =>
          String(v.value || "")
            .toLowerCase()
            .trim(),
        ) || [];
      setMapping(
        Object.fromEntries(
          j.fields
            .filter((f: string) => headers.includes(f))
            .map((f: string) => [f, headers.indexOf(f)]),
        ),
      );
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
  const sheet = job?.sheets.find((s: any) => s.name === options.sheet),
    headers = sheet?.preview[options.headerRow - 1] || [],
    done = job?.status === "COMPLETED";
  return (
    <>
      <Card className="section-bottom">
        <div className="intro-row">
          <div>
            <h2>Đưa dữ liệu sẵn có vào hệ thống</h2>
            <p>
              Tải file, ghép cột và đối soát trước khi xác nhận. Tối đa 1.000
              dòng, 5 MB mỗi file.
            </p>
          </div>
          <Select
            placeholder="Mở lượt nhập trước"
            style={{ width: 280 }}
            options={jobs.map((j) => ({
              value: j.id,
              label: `${j.file_name} · ${j.status}`,
            }))}
            onChange={async (id) => adopt(await api(`/imports/${id}`))}
          />
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
            <div className="job-title">
              <b>{job.file_name}</b>
              <Tag color={done ? "green" : "blue"}>{job.status}</Tag>
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
                      onChange={(headerRow) =>
                        setOptions({ ...options, headerRow: headerRow || 1 })
                      }
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
                <div className="mapping-grid">
                  {job.fields.map((field: string) => (
                    <label key={field}>
                      <span>{field}</span>
                      <Select
                        allowClear
                        placeholder="Chọn cột trong file"
                        value={mapping[field]}
                        options={headers.map((c: any, i: number) => ({
                          value: i,
                          label: `${i + 1}. ${c.value || "(trống)"}`,
                        }))}
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
                      width: 100,
                    },
                    {
                      title: "Dữ liệu nhận diện",
                      render: (_, r) => (
                        <>
                          <b className="code">
                            {r.normalized?.part_no || r.normalized?.code}
                          </b>
                          <div>
                            {r.normalized?.mes_pack_no ||
                              r.normalized?.specification ||
                              r.normalized?.name}
                          </div>
                        </>
                      ),
                    },
                    {
                      title: "Thao tác",
                      render: (_, r) => (
                        <Tag>{r.normalized?.action || "—"}</Tag>
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
    </>
  );
}
