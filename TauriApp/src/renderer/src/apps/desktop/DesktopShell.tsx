import { AppShell } from "../../app/layout/AppShell";
import { desktopNavRoutes, resolveDesktopTitle } from "./navigation";

export function DesktopShell() {
  return (
    <AppShell
      mode="desktop"
      navRoutes={desktopNavRoutes}
      resolveTitle={resolveDesktopTitle}
    />
  );
}
