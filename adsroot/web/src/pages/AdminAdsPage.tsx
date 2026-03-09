import { Button, Card, Form, Input, InputNumber, Popconfirm, Space, Switch, Table, message } from "antd";
import { useEffect, useState } from "react";

import { apiClient } from "../api/client";
import type { AdItem } from "../types";

type EditableAd = AdItem & { isActive: boolean };

function toFormInput(item: EditableAd) {
  return {
    title: item.title,
    imageUrl: item.imageUrl,
    targetUrl: item.targetUrl,
    summary: item.summary,
    sortOrder: item.sortOrder,
    isActive: item.isActive,
  };
}

export function AdminAdsPage() {
  const [loading, setLoading] = useState(false);
  const [ads, setAds] = useState<EditableAd[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm] = Form.useForm<{
    title: string;
    imageUrl: string;
    targetUrl: string;
    summary: string;
    sortOrder: number;
    isActive: boolean;
  }>();

  const loadAds = async () => {
    setLoading(true);
    try {
      const items = await apiClient.listAdsForAdmin();
      setAds(items.map((item) => ({ ...item, isActive: item.isActive !== false })));
    } catch (err) {
      message.error(err instanceof Error ? err.message : "加载广告失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAds();
  }, []);

  return (
    <div className="page-stack">
      <Card title="新增广告">
        <Form
          layout="vertical"
          initialValues={{ sortOrder: 0, isActive: true }}
          onFinish={async (values: {
            title: string;
            imageUrl: string;
            targetUrl: string;
            summary: string;
            sortOrder: number;
            isActive: boolean;
          }) => {
            try {
              await apiClient.createAd(values);
              message.success("广告创建成功");
              await loadAds();
            } catch (err) {
              message.error(err instanceof Error ? err.message : "创建广告失败");
            }
          }}
        >
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="imageUrl" label="图片地址" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="targetUrl" label="跳转地址" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="summary" label="摘要">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space>
            <Form.Item name="sortOrder" label="排序" style={{ marginBottom: 0 }}>
              <InputNumber />
            </Form.Item>
            <Form.Item
              name="isActive"
              label="启用"
              valuePropName="checked"
              style={{ marginBottom: 0 }}
            >
              <Switch />
            </Form.Item>
          </Space>
          <div style={{ marginTop: 16 }}>
            <Button type="primary" htmlType="submit">
              新增广告
            </Button>
          </div>
        </Form>
      </Card>

      <Card title="广告管理">
        <Table<EditableAd>
          rowKey="id"
          loading={loading}
          dataSource={ads}
          pagination={false}
          columns={[
            { title: "ID", dataIndex: "id", width: 70 },
            {
              title: "广告",
              dataIndex: "title",
              render: (_value, record) => (
                <div>
                  <div style={{ fontWeight: 600 }}>{record.title}</div>
                  <div className="muted-line">{record.summary || "-"}</div>
                </div>
              ),
            },
            {
              title: "图片",
              dataIndex: "imageUrl",
              width: 170,
              render: (value: string) => <img className="table-thumb" src={value} alt="ad" />,
            },
            {
              title: "启用",
              dataIndex: "isActive",
              width: 100,
              render: (_value, record) => (
                <Switch
                  checked={record.isActive}
                  onChange={async () => {
                    try {
                      await apiClient.toggleAd(record.id);
                      await loadAds();
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : "更新状态失败");
                    }
                  }}
                />
              ),
            },
            {
              title: "排序",
              dataIndex: "sortOrder",
              width: 80,
            },
            {
              title: "操作",
              key: "actions",
              width: 240,
              render: (_value, record) => (
                <Space>
                  <Button
                    onClick={() => {
                      setEditingId(record.id);
                      editForm.setFieldsValue(toFormInput(record));
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title="确认删除该广告？"
                    onConfirm={async () => {
                      try {
                        await apiClient.deleteAd(record.id);
                        message.success("广告已删除");
                        await loadAds();
                      } catch (err) {
                        message.error(err instanceof Error ? err.message : "删除广告失败");
                      }
                    }}
                  >
                    <Button danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (record) =>
              editingId === record.id ? (
                <Form
                  form={editForm}
                  layout="vertical"
                  onFinish={async (values: {
                    title: string;
                    imageUrl: string;
                    targetUrl: string;
                    summary: string;
                    sortOrder: number;
                    isActive: boolean;
                  }) => {
                    try {
                      await apiClient.updateAd(record.id, values);
                      message.success("广告已更新");
                      setEditingId(null);
                      await loadAds();
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : "更新广告失败");
                    }
                  }}
                >
                  <Form.Item name="title" label="标题" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="imageUrl" label="图片地址" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="targetUrl" label="跳转地址" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="summary" label="摘要">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                  <Space>
                    <Form.Item name="sortOrder" label="排序" style={{ marginBottom: 0 }}>
                      <InputNumber />
                    </Form.Item>
                    <Form.Item
                      name="isActive"
                      label="启用"
                      valuePropName="checked"
                      style={{ marginBottom: 0 }}
                    >
                      <Switch />
                    </Form.Item>
                  </Space>
                  <div style={{ marginTop: 12 }}>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                      <Button onClick={() => setEditingId(null)}>取消</Button>
                    </Space>
                  </div>
                </Form>
              ) : (
                <a href={record.targetUrl} target="_blank" rel="noreferrer">
                  查看跳转链接
                </a>
              ),
            rowExpandable: () => true,
          }}
        />
      </Card>
    </div>
  );
}
