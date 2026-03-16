import { AppProviders } from "../shared/AppProviders";
import { DesktopShell } from "./DesktopShell";

export function DesktopApp() {
  return (
    <AppProviders>
      <DesktopShell />
    </AppProviders>
  );
}
