import { Space, Switch } from "antd";
import type { SwitchProps } from "antd";
import type { ReactNode } from "react";

import { HelpLabel } from "./HelpLabel";
import type { HelpContent } from "./HelpLabel";

interface SwitchWithLabelProps extends SwitchProps {
  label: ReactNode;
  helpContent?: HelpContent;
  helpTitle?: ReactNode;
  helpMaxWidth?: number;
  className?: string;
}

export function SwitchWithLabel({
  label,
  helpContent,
  helpTitle,
  helpMaxWidth,
  className,
  ...switchProps
}: SwitchWithLabelProps) {
  return (
    <Space
      size={8}
      align="center"
      className={className ? `switch-with-label ${className}` : "switch-with-label"}
    >
      <Switch {...switchProps} />
      <HelpLabel
        label={label}
        helpContent={helpContent}
        helpTitle={helpTitle}
        helpMaxWidth={helpMaxWidth}
      />
    </Space>
  );
}
