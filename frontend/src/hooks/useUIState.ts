import { useCallback, useState } from "react";
import type { UIState } from "../types/ui";

const STORAGE_KEY = "bete-dashboard-ui-state";

function loadState(): UIState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as UIState;
  } catch {
    // ignore parse errors
  }
  return { activeTab: "live" };
}

function saveState(state: UIState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

export function useUIState() {
  const [uiState, setUIState] = useState<UIState>(loadState);

  const patchUIState = useCallback((patch: Partial<UIState>) => {
    setUIState((prev) => {
      const next = { ...prev, ...patch };
      saveState(next);
      return next;
    });
  }, []);

  return { uiState, setUIState, patchUIState, loading: false, error: null };
}
