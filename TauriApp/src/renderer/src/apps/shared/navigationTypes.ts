import type { ReactNode } from "react";

export interface NavRoute {
  key: string;
  path: string;
  title: string;
  tip: string;
  label: string;
  icon: ReactNode;
}
