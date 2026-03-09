import { Button, Card, Descriptions, Form, Input, Select, Space, message } from "antd";
import { useMemo } from "react";

import { apiClient } from "../api/client";
import { useAuth } from "../context/AuthContext";

const emojiOptions = [
  "🙂",
  "😀",
  "😎",
  "🤖",
  "🦊",
  "🐱",
  "🐼",
  "🐧",
  "🦄",
  "🚀",
  "🌊",
  "⚡",
  "🛡️",
  "🧭",
];

export function ProfilePage() {
  const { user, setUser } = useAuth();
  const initialValues = useMemo(
    () => ({
      avatarEmoji: user?.avatarEmoji ?? "🙂",
    }),
    [user?.avatarEmoji],
  );

  if (!user) {
    return null;
  }

  return (
    <div className="page-stack">
      <Card title="个人资料">
        <Descriptions bordered column={1} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="用户名">{user.username}</Descriptions.Item>
          <Descriptions.Item label="角色">{user.role}</Descriptions.Item>
          <Descriptions.Item label="当前头像">{user.avatarEmoji}</Descriptions.Item>
        </Descriptions>

        <Form
          layout="inline"
          key={initialValues.avatarEmoji}
          initialValues={initialValues}
          onFinish={async (values: { avatarEmoji: string }) => {
            const nextUser = await apiClient.updateProfile(values);
            setUser(nextUser);
            message.success("资料已更新");
          }}
        >
          <Form.Item name="avatarEmoji" label="更换头像 Emoji">
            <Select
              options={emojiOptions.map((item) => ({ label: item, value: item }))}
              style={{ width: 180 }}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              保存资料
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="修改密码">
        <Form
          layout="vertical"
          onFinish={async (values: {
            oldPassword: string;
            newPassword: string;
            confirmPassword: string;
          }) => {
            if (values.newPassword !== values.confirmPassword) {
              message.error("两次输入的新密码不一致");
              return;
            }
            try {
              await apiClient.changePassword({
                oldPassword: values.oldPassword,
                newPassword: values.newPassword,
              });
              message.success("密码已修改");
            } catch (error) {
              message.error(error instanceof Error ? error.message : "修改密码失败");
            }
          }}
        >
          <Form.Item
            name="oldPassword"
            label="旧密码"
            rules={[{ required: true, message: "请输入旧密码" }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true, message: "请输入新密码" }]}
          >
            <Input.Password placeholder="6-128 位" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            rules={[{ required: true, message: "请再次输入新密码" }]}
          >
            <Input.Password />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              保存新密码
            </Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
