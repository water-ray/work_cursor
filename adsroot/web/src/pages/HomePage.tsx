import { Card, Col, Row, Spin, Typography } from "antd";
import { useEffect, useState } from "react";

import { apiClient } from "../api/client";
import type { HomeData } from "../types";

export function HomePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<HomeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await apiClient.fetchHomeData();
        if (cancelled) {
          return;
        }
        setData(result);
        setError("");
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : "加载首页失败");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="page-loading">
        <Spin />
      </div>
    );
  }

  if (!data) {
    return (
      <Card>
        <Typography.Text type="danger">{error || "首页数据不可用"}</Typography.Text>
      </Card>
    );
  }

  return (
    <div className="page-stack">
      <Card className="hero-card" bordered={false}>
        <Typography.Title level={2}>{data.hero.title}</Typography.Title>
        <Typography.Paragraph className="hero-slogan">{data.hero.slogan}</Typography.Paragraph>
        <Typography.Paragraph>{data.hero.description}</Typography.Paragraph>
        <ul className="hero-tech-list">
          {data.hero.techStacks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Card>

      <Card title="广告展示">
        {error ? (
          <Typography.Text type="warning">{error}</Typography.Text>
        ) : null}
        <Row gutter={[12, 12]} style={{ marginTop: 6 }}>
          {data.ads.length === 0 ? (
            <Col span={24}>
              <Typography.Text type="secondary">暂无广告内容</Typography.Text>
            </Col>
          ) : (
            data.ads.map((item) => (
              <Col key={item.id} xs={24} md={12} xl={8}>
                <a className="ad-card-link" href={item.targetUrl} target="_blank" rel="noreferrer">
                  <Card hoverable className="ad-card" cover={<img src={item.imageUrl} alt={item.title} />}>
                    <Card.Meta title={item.title} description={item.summary || "点击查看详情"} />
                  </Card>
                </a>
              </Col>
            ))
          )}
        </Row>
      </Card>
    </div>
  );
}
