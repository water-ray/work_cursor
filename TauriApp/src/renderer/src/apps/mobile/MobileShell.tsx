import { AppShell } from "../../app/layout/AppShell";
import { buildMobileNavRoutes, resolveMobileTitle } from "./navigation";

export function MobileShell() {
  return (
    <AppShell
      mode="mobile"
      navRoutes={buildMobileNavRoutes()}
      resolveTitle={resolveMobileTitle}
    />
  );
}
