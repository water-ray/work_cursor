import type { CSSProperties } from "react";

interface BiIconProps {
  name: string;
  className?: string;
  style?: CSSProperties;
  spin?: boolean;
}

export function BiIcon({ name, className, style, spin = false }: BiIconProps) {
  const classes = ["bi", `bi-${name}`, "bi-icon", spin ? "bi-spin" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <i
      className={classes}
      style={style}
      aria-hidden="true"
    />
  );
}
