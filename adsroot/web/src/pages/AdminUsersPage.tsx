import { Button, Card, Form, Input, Popconfirm, Select, Space, Switch, Table, message } from "antd";
import { useEffect, useState } from "react";

import { apiClient } from "../api/client";
import type { PublicUser, UserRole } from "../types";

type AdminUser = PublicUser & { isDisabled: boolean };

const emojiOptions = ["🙂", "😀", "😎", "🤖", "🚀", "🌊", "⚡", "🛡️"];

export function AdminUsersPage() {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      setUsers(await apiClient.listUsers());
    } catch (err) {
      message.error(err instanceof Error ? err.message : "加载用户失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  return (
    <div className="page-stack">
      <Card title="新增用户">
        <Form
          layout="inline"
          initialValues={{ role: "user", avatarEmoji: "🙂" }}
          onFinish={async (values: {
            username: string;
            password: string;
            role: UserRole;
            avatarEmoji: string;
          }) => {
            try {
              await apiClient.createUser(values);
              message.success("用户创建成功");
              await loadUsers();
            } catch (err) {
              message.error(err instanceof Error ? err.message : "创建用户失败");
            }
          }}
        >
          <Form.Item name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password placeholder="密码" />
          </Form.Item>
          <Form.Item name="role">
            <Select
              style={{ width: 110 }}
              options={[
                { label: "普通用户", value: "user" },
                { label: "管理员", value: "admin" },
              ]}
            />
          </Form.Item>
          <Form.Item name="avatarEmoji">
            <Select style={{ width: 100 }} options={emojiOptions.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              创建
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="用户管理">
        <Table<AdminUser>
          rowKey="id"
          loading={loading}
          dataSource={users}
          pagination={false}
          columns={[
            { title: "ID", dataIndex: "id", width: 70 },
            { title: "头像", dataIndex: "avatarEmoji", width: 70 },
            { title: "用户名", dataIndex: "username", width: 180 },
            {
              title: "角色",
              dataIndex: "role",
              width: 140,
              render: (_value, record) => (
                <Select
                  value={record.role}
                  style={{ width: 120 }}
                  options={[
                    { label: "普通用户", value: "user" },
                    { label: "管理员", value: "admin" },
                  ]}
                  onChange={async (role) => {
                    try {
                      await apiClient.updateUser(record.id, { role });
                      await loadUsers();
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : "更新角色失败");
                    }
                  }}
                />
              ),
            },
            {
              title: "禁用",
              dataIndex: "isDisabled",
              width: 100,
              render: (_value, record) => (
                <Switch
                  checked={record.isDisabled}
                  onChange={async (checked) => {
                    try {
                      await apiClient.updateUser(record.id, { isDisabled: checked });
                      await loadUsers();
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : "更新状态失败");
                    }
                  }}
                />
              ),
            },
            {
              title: "操作",
              key: "actions",
              render: (_value, record) => (
                <Space>
                  <Popconfirm
                    title="确认删除该用户？"
                    onConfirm={async () => {
                      try {
                        await apiClient.deleteUser(record.id);
                        message.success("已删除用户");
                        await loadUsers();
                      } catch (err) {
                        message.error(err instanceof Error ? err.message : "删除用户失败");
                      }
                    }}
                  >
                    <Button danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
