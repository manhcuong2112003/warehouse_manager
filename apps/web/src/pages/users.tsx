import { useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Table,
  Tag,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, post } from "../api";
export function Users() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<any[]>([]),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [open, setOpen] = useState(false),
    [form] = Form.useForm();
  const load = () => api("/users").then(setRows);
  useEffect(() => {
    load();
    api("/warehouses").then(setWarehouses);
  }, []);
  return (
    <Card
      title="Tài khoản và phạm vi kho"
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setOpen(true);
          }}
        >
          Tạo tài khoản
        </Button>
      }
    >
      <Table<any>
        rowKey="id"
        dataSource={rows}
        columns={[
          { title: "Tên đăng nhập", dataIndex: "username" },
          { title: "Họ tên", dataIndex: "display_name" },
          { title: "Quyền", dataIndex: "role" },
          {
            title: "Kho được cấp",
            dataIndex: "warehouses",
            render: (ids, r) =>
              r.role === "ADMIN"
                ? "Tất cả"
                : ids
                    .map(
                      (id: string) =>
                        warehouses.find((w) => w.id === id)?.code || id,
                    )
                    .join(", "),
          },
          {
            title: "Trạng thái",
            dataIndex: "active",
            render: (v) => (
              <Tag color={v ? "green" : "default"}>
                {v ? "Hoạt động" : "Đã khóa"}
              </Tag>
            ),
          },
          {
            title: "Thao tác",
            render: (_, r) =>
              r.active && (
                <Popconfirm
                  title="Khóa tài khoản và kết thúc các phiên đăng nhập?"
                  onConfirm={async () => {
                    try {
                      await post(`/users/${r.id}/disable`);
                      load();
                    } catch (e: any) {
                      message.error(e.message);
                    }
                  }}
                >
                  <Button danger>Khóa</Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <Modal
        title="Tạo người dùng"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (v) => {
            try {
              await post("/users", v);
              setOpen(false);
              load();
              message.success("Đã tạo tài khoản.");
            } catch (e: any) {
              message.error(e.message);
            }
          }}
        >
          <Form.Item
            name="username"
            label="Tên đăng nhập"
            rules={[{ required: true, pattern: /^[a-zA-Z0-9_.-]{3,50}$/ }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="displayName"
            label="Họ tên"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="Mật khẩu (ít nhất 12 ký tự)"
            rules={[{ required: true, min: 12 }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="Vai trò" initialValue="OPERATOR">
            <Select
              options={[
                { value: "ADMIN", label: "Quản trị" },
                { value: "OPERATOR", label: "Thủ kho" },
                { value: "VIEWER", label: "Chỉ xem" },
              ]}
            />
          </Form.Item>
          <Form.Item name="warehouses" label="Kho được cấp" initialValue={[]}>
            <Select
              mode="multiple"
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
