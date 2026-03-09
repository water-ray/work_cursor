import { Alert, Button, Card, Form, Input, Select, Space, Tabs, Typography, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

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
];

export function AuthPage() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaSvgDataUrl, setCaptchaSvgDataUrl] = useState("");
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const loadCaptcha = async () => {
    setLoadingCaptcha(true);
    try {
      const captcha = await apiClient.getCaptcha();
      setCaptchaToken(captcha.captchaToken);
      setCaptchaSvgDataUrl(captcha.captchaSvgDataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载验证码失败");
    } finally {
      setLoadingCaptcha(false);
    }
  };

  useEffect(() => {
    void loadCaptcha();
  }, []);

  useEffect(() => {
    if (!user) {
      return;
    }
    navigate("/");
  }, [user, navigate]);

  const registerInitialValues = useMemo(
    () => ({
      avatarEmoji: emojiOptions[0],
    }),
    [],
  );

  return (
    <Card title="账号登录 / 注册">
      <Tabs
        defaultActiveKey="login"
        items={[
          {
            key: "login",
            label: "登录",
            children: (
              <Form
                layout="vertical"
                onFinish={async (values: {
                  username: string;
                  password: string;
                  captcha: string;
                }) => {
                  setSubmitting(true);
                  setError("");
                  try {
                    await login({
                      username: values.username,
                      password: values.password,
                      captchaToken,
                      captcha: values.captcha,
                    });
                    message.success("登录成功");
                    navigate("/");
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "登录失败");
                    void loadCaptcha();
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                  <Input placeholder="6-32 位，支持中文/字母/数字/下划线" />
                </Form.Item>
                <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                  <Input.Password />
                </Form.Item>
                <Form.Item name="captcha" label="验证码" rules={[{ required: true, message: "请输入验证码" }]}>
                  <Input placeholder="输入图中字符" />
                </Form.Item>
                <Space align="center" style={{ marginBottom: 12 }}>
                  {captchaSvgDataUrl ? (
                    <img className="captcha-image" src={captchaSvgDataUrl} alt="captcha" />
                  ) : (
                    <Typography.Text type="secondary">验证码加载中...</Typography.Text>
                  )}
                  <Button onClick={() => void loadCaptcha()} loading={loadingCaptcha}>
                    刷新验证码
                  </Button>
                </Space>
                <Form.Item>
                  <Button type="primary" htmlType="submit" loading={submitting} block>
                    登录
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "register",
            label: "注册",
            children: (
              <Form
                layout="vertical"
                initialValues={registerInitialValues}
                onFinish={async (values: {
                  username: string;
                  password: string;
                  avatarEmoji: string;
                  captcha: string;
                }) => {
                  setSubmitting(true);
                  setError("");
                  try {
                    await register({
                      username: values.username,
                      password: values.password,
                      avatarEmoji: values.avatarEmoji,
                      captchaToken,
                      captcha: values.captcha,
                    });
                    message.success("注册成功，已自动登录");
                    navigate("/");
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "注册失败");
                    void loadCaptcha();
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                  <Input placeholder="6-32 位，支持中文/字母/数字/下划线" />
                </Form.Item>
                <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                  <Input.Password placeholder="至少 6 位" />
                </Form.Item>
                <Form.Item name="avatarEmoji" label="头像 Emoji">
                  <Select
                    options={emojiOptions.map((item) => ({ label: item, value: item }))}
                    style={{ width: 180 }}
                  />
                </Form.Item>
                <Form.Item name="captcha" label="验证码" rules={[{ required: true, message: "请输入验证码" }]}>
                  <Input placeholder="输入图中字符" />
                </Form.Item>
                <Space align="center" style={{ marginBottom: 12 }}>
                  {captchaSvgDataUrl ? (
                    <img className="captcha-image" src={captchaSvgDataUrl} alt="captcha" />
                  ) : (
                    <Typography.Text type="secondary">验证码加载中...</Typography.Text>
                  )}
                  <Button onClick={() => void loadCaptcha()} loading={loadingCaptcha}>
                    刷新验证码
                  </Button>
                </Space>
                <Form.Item>
                  <Button type="primary" htmlType="submit" loading={submitting} block>
                    注册并登录
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
        ]}
      />
    </Card>
  );
}
