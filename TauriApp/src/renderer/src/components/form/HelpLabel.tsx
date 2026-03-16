import { Popover, Space, Typography } from "antd";
import type { TooltipPlacement } from "antd/es/tooltip";
import { isValidElement, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { BiIcon } from "../icons/BiIcon";
import { isMobileRuntime } from "../../platform/runtimeStore";

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
  const isMobileView = isMobileRuntime();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mobilePlacement, setMobilePlacement] = useState<TooltipPlacement>("bottom");
  const [mobilePopoverWidth, setMobilePopoverWidth] = useState<number>(() => {
    if (typeof window === "undefined") {
      return helpMaxWidth;
    }
    return Math.min(helpMaxWidth, Math.max(220, window.innerWidth - 24));
  });

  const updateMobilePopoverLayout = useCallback(() => {
    if (!isMobileView || typeof window === "undefined") {
      return;
    }
    const viewportWidth = Math.max(280, Math.round(window.innerWidth || 0));
    const viewportHeight = Math.max(0, Math.round(window.innerHeight || 0));
    setMobilePopoverWidth(Math.min(helpMaxWidth, Math.max(220, viewportWidth - 24)));
    const anchorRect = anchorRef.current?.getBoundingClientRect();
    if (!anchorRect || viewportHeight <= 0) {
      setMobilePlacement("bottom");
      return;
    }
    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    setMobilePlacement(anchorCenterY < viewportHeight / 2 ? "bottom" : "top");
  }, [helpMaxWidth, isMobileView]);

  useEffect(() => {
    if (!isMobileView || !open) {
      return;
    }
    updateMobilePopoverLayout();
    const handleViewportChange = () => {
      updateMobilePopoverLayout();
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isMobileView, open, updateMobilePopoverLayout]);

  const resolvedPopoverWidth = isMobileView ? mobilePopoverWidth : helpMaxWidth;

  return (
    <Space
      size={6}
      className="switch-help-label"
      align="center"
    >
      {typeof label === "string" ? <Typography.Text>{label}</Typography.Text> : label}
      {helpContent ? (
        <Popover
          open={open}
          trigger="click"
          placement={isMobileView ? mobilePlacement : "rightTop"}
          title={
            <div style={{ maxWidth: resolvedPopoverWidth, overflowWrap: "anywhere" }}>
              {helpTitle}
            </div>
          }
          content={
            <div
              style={{
                width: resolvedPopoverWidth,
                maxWidth: resolvedPopoverWidth,
                lineHeight: 1.5,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }}
            >
              {renderHelpContent(helpContent)}
            </div>
          }
          overlayStyle={
            isMobileView
              ? {
                  maxWidth: resolvedPopoverWidth,
                  width: resolvedPopoverWidth,
                }
              : undefined
          }
          getPopupContainer={() => document.body}
          onOpenChange={(nextOpen) => {
            if (isMobileView && nextOpen) {
              updateMobilePopoverLayout();
            }
            setOpen(nextOpen);
          }}
        >
          <span
            ref={anchorRef}
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
