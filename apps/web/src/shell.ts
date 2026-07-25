import type { HomeData } from "@damo/contracts";
import { useOutletContext } from "react-router-dom";

export interface ShellContext {
  home: HomeData | null;
  refreshHome: () => Promise<void>;
  showToast: (message: string) => void;
}

export function useShell() {
  return useOutletContext<ShellContext>();
}
