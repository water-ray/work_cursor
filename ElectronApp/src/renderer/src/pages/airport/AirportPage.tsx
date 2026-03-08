import { Alert, Card, Spin, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { fetchAirportAds, getAirportAdsEndpoint, type AirportAdItem } from "../../services/airportAdsApi";

export function AirportPage() {
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [ads, setAds] = useState<AirportAdItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrorText("");
    fetchAirportAds(controller.signal)
      .then((items) => {
        setAds(items);
        setLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setAds([]);
        setLoading(false);
        setErrorText(error instanceof Error ? error.message : "广告接口不可用");
      });
    return () => {
      controller.abort();
    };
  }, []);

  const bannerAd = useMemo(() => ads[0] ?? null, [ads]);
  const cardAds = useMemo(() => ads.slice(1, 4), [ads]);

  return (
    <div className="airport-page">
      <Card className="airport-page-hero" bordered={false}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          机场
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          机场本地页会优先请求广告接口并渲染内容；当服务不可用时，自动回退为本地占位。
        </Typography.Paragraph>
      </Card>

      {loading ? (
        <div className="airport-page-loading">
          <Spin />
          <Typography.Text type="secondary">正在加载广告内容...</Typography.Text>
        </div>
      ) : null}

      {!loading && errorText ? (
        <Alert
          type="warning"
          showIcon
          className="airport-page-alert"
          message="广告服务暂不可用，当前显示本地占位内容"
          description={`接口地址：${getAirportAdsEndpoint()}，错误：${errorText}`}
        />
      ) : null}

      {bannerAd ? (
        <a
          className="airport-page-banner airport-page-banner-link"
          href={bannerAd.targetUrl}
          target="_blank"
          rel="noreferrer"
        >
          <div className="airport-page-banner-badge">广告推荐</div>
          <Typography.Title level={2} className="airport-page-banner-title">
            {bannerAd.title}
          </Typography.Title>
          <Typography.Paragraph className="airport-page-banner-text">
            {bannerAd.summary || "点击查看广告详情"}
          </Typography.Paragraph>
          <div className="airport-page-banner-image-wrap">
            <img className="airport-page-banner-image" src={bannerAd.imageUrl} alt={bannerAd.title} />
          </div>
        </a>
      ) : (
        <div className="airport-page-banner">
          <div className="airport-page-banner-badge">广告招租</div>
          <Typography.Title level={2} className="airport-page-banner-title">
            广告位招租
          </Typography.Title>
          <Typography.Paragraph className="airport-page-banner-text">
            当前位置为机场频道本地占位页，后续可接入广告卡片、推荐机场、活动信息与评测内容。
          </Typography.Paragraph>
        </div>
      )}

      <div className="airport-page-grid">
        {(cardAds.length > 0 ? cardAds : [null, null, null]).map((ad, index) => (
          <Card
            key={ad?.id ?? `placeholder-${index}`}
            className="airport-page-panel"
            title={ad?.title ?? `广告位 ${String.fromCharCode(65 + index)}`}
            extra={
              ad ? (
                <a href={ad.targetUrl} target="_blank" rel="noreferrer">
                  查看
                </a>
              ) : null
            }
          >
            {ad ? (
              <>
                <div className="airport-page-card-image-wrap">
                  <img className="airport-page-card-image" src={ad.imageUrl} alt={ad.title} />
                </div>
                <Typography.Paragraph type="secondary">
                  {ad.summary || "点击查看广告详情。"}
                </Typography.Paragraph>
              </>
            ) : (
              <Typography.Paragraph type="secondary">
                当前为静态占位，后续可扩展为机场榜单、编辑推荐、专题评测或限时活动内容。
              </Typography.Paragraph>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
