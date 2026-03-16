import { AppProviders } from "../shared/AppProviders";
import { MobileShell } from "./MobileShell";

export function MobileApp() {
  return (
    <AppProviders>
      <MobileShell />
    </AppProviders>
  );
}
