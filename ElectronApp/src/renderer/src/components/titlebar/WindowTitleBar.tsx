import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
  PushpinOutlined,
} from "@ant-design/icons";
import { Button, Space, Typography } from "antd";
import { useEffect, useState } from "react";

interface WindowTitleBarProps {
  title: string;
}

export function WindowTitleBar({ title }: WindowTitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void window.waterayDesktop.window.isMaximized().then((value) => {
      if (active) {
        setMaximized(value);
      }
    });
    const dispose = window.waterayDesktop.window.onMaximizedChanged((value) => {
      setMaximized(value);
    });
    return () => {
      active = false;
      dispose();
    };
  }, []);

  return (
    <div className="window-titlebar">
      <div className="window-brand">
        <span className="window-app-icon">W</span>
        <Typography.Text className="window-app-name">Wateray</Typography.Text>
      </div>
      <Typography.Text className="window-title">{title}</Typography.Text>
      <Space className="window-titlebar-actions">
        <Button
          size="small"
          type="text"
          icon={<MinusOutlined />}
          onClick={() => void window.waterayDesktop.window.minimize()}
        />
        <Button
          size="small"
          type="text"
          icon={maximized ? <PushpinOutlined /> : <BorderOutlined />}
          onClick={() => void window.waterayDesktop.window.toggleMaximize()}
        />
        <Button
          size="small"
          type="text"
          danger
          icon={<CloseOutlined />}
          onClick={() => void window.waterayDesktop.window.close()}
        />
      </Space>
    </div>
  );
}
