import { Popover, Space, Typography } from "antd";
import { isValidElement } from "react";
import type { ReactNode } from "react";

import { BiIcon } from "../icons/BiIcon";

export interface HelpContentSections {
  scene?: ReactNode;
  effect?: ReactNode;
  caution?: ReactNode;
  recommendation?: ReactNode;
}

export type HelpContent = ReactNode | HelpContentSections;

interface HelpLabelProps {
  label: ReactNode;
  helpContent?: HelpContent;
  helpTitle?: ReactNode;
  helpMaxWidth?: number;
}

function normalizeTextLineBreaks(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\\n/g, "\n");
}

function hasRenderableContent(value: ReactNode | undefined): boolean {
  if (value == null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return normalizeTextLineBreaks(value).trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasRenderableContent(item));
  }
  return true;
}

function renderTextContent(text: string): ReactNode {
  const lines = normalizeTextLineBreaks(text).split("\n");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, lineHeight: 1.5 }}>
      {lines.map((line, index) => (
        <div key={`${index}-${line}`}>
          {line.trim() === "" ? "\u00a0" : line}
        </div>
      ))}
    </div>
  );
}

function renderHelpNode(value: ReactNode): ReactNode {
  if (typeof value === "string") {
    return renderTextContent(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  return value;
}

function isStructuredHelpContent(value: HelpContent | undefined): value is HelpContentSections {
  if (!value || typeof value !== "object" || Array.isArray(value) || isValidElement(value)) {
    return false;
  }
  const content = value as HelpContentSections;
  return (
    hasRenderableContent(content.scene) ||
    hasRenderableContent(content.effect) ||
    hasRenderableContent(content.caution) ||
    hasRenderableContent(content.recommendation)
  );
}

function renderHelpContent(value: HelpContent): ReactNode {
  if (isStructuredHelpContent(value)) {
    const sections: Array<{ label: string; content?: ReactNode }> = [
      { label: "使用场景", content: value.scene },
      { label: "作用", content: value.effect },
      { label: "注意", content: value.caution },
      { label: "推荐", content: value.recommendation },
    ].filter((item) => hasRenderableContent(item.content));
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sections.map((section) => (
          <div
            key={section.label}
            style={{ display: "flex", alignItems: "flex-start", gap: 4 }}
          >
            <Typography.Text
              strong
              style={{ whiteSpace: "nowrap", lineHeight: 1.5 }}
            >
              {section.label}：
            </Typography.Text>
            <div style={{ minWidth: 0, flex: 1 }}>
              {renderHelpNode(section.content ?? "")}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return renderHelpNode(value as ReactNode);
}

export function HelpLabel({
  label,
  helpContent,
  helpTitle = "配置说明",
  helpMaxWidth = 520,
}: HelpLabelProps) {
  return (
    <Space
      size={6}
      className="switch-help-label"
      align="center"
    >
      {typeof label === "string" ? <Typography.Text>{label}</Typography.Text> : label}
      {helpContent ? (
        <Popover
          trigger="click"
          placement="rightTop"
          title={helpTitle}
          content={
            <div style={{ maxWidth: helpMaxWidth, lineHeight: 1.5 }}>
              {renderHelpContent(helpContent)}
            </div>
          }
        >
          <span
            className="help-popover-anchor"
            data-help-popover="true"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            <BiIcon
              name="question-circle"
              className="help-popover-trigger"
              style={{ color: "#8c8c8c", cursor: "help" }}
            />
          </span>
        </Popover>
      ) : null}
    </Space>
  );
}
