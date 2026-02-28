import { Card, Space, Switch, Typography } from "antd";
import { useEffect, useState } from "react";

import type { DaemonPageProps } from "../../app/types";
import { readDragScrollEnabled, writeDragScrollEnabled } from "../../app/settings/uiPreferences";

export function SettingsPage({ loading }: DaemonPageProps) {
  const [dragScrollEnabled, setDragScrollEnabled] = useState<boolean>(() =>
    readDragScrollEnabled(),
  );

  useEffect(() => {
    setDragScrollEnabled(readDragScrollEnabled());
  }, []);

  return (
    <Card
      loading={loading}
    >
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <Typography.Text strong>UI</Typography.Text>
        <Space size={8}>
          <Switch
            checked={dragScrollEnabled}
            onChange={(checked) => {
              setDragScrollEnabled(checked);
              writeDragScrollEnabled(checked);
            }}
          />
          <Typography.Text>移动端手势</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          开启后可在主内容区按住鼠标左键上下拖动，实现类似移动端的滑动浏览体验。
        </Typography.Text>
      </Space>
    </Card>
  );
}
