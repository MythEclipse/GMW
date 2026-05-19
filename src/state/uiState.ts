import { getPersistedValue, setPersistedValue } from "../muxer-queue";

export type ActiveTab =
  | "voice"
  | "messages"
  | "media"
  | "review"
  | "recordings";

export interface SharedUIState {
  selectedVoiceGuild: string;
  selectedVoiceChannel: string;
  selectedTextGuild: string;
  selectedTextChannel: string;
  activeTab: ActiveTab;
  isListening: boolean;
  isStreaming: boolean;
}

export type SharedUIStatePatch = Partial<SharedUIState> & {
  selectedGuild?: string;
};

const activeTabs: ActiveTab[] = [
  "voice",
  "messages",
  "media",
  "review",
  "recordings",
];

export const defaultSharedUIState: SharedUIState = {
  selectedVoiceGuild: "",
  selectedVoiceChannel: "",
  selectedTextGuild: "",
  selectedTextChannel: "",
  activeTab: "voice",
  isListening: false,
  isStreaming: false,
};

export function normalizeSharedUIState(
  value: SharedUIStatePatch,
): SharedUIState {
  const guild = value.selectedGuild ?? "";
  return {
    selectedVoiceGuild: value.selectedVoiceGuild ?? guild,
    selectedVoiceChannel: value.selectedVoiceChannel ?? "",
    selectedTextGuild: value.selectedTextGuild ?? guild,
    selectedTextChannel: value.selectedTextChannel ?? "",
    activeTab: activeTabs.includes(value.activeTab as ActiveTab)
      ? (value.activeTab as ActiveTab)
      : "voice",
    isListening: value.isListening ?? false,
    isStreaming: value.isStreaming ?? false,
  };
}

export async function createSharedUIStateStore() {
  let sharedUIState = normalizeSharedUIState(
    await getPersistedValue("web-ui-state", defaultSharedUIState),
  );

  function getSharedUIState(): SharedUIState {
    return { ...sharedUIState };
  }

  async function patchSharedUIState(
    patch: SharedUIStatePatch,
  ): Promise<SharedUIState> {
    if (typeof patch.selectedGuild === "string") {
      sharedUIState.selectedVoiceGuild = patch.selectedGuild;
      sharedUIState.selectedTextGuild = patch.selectedGuild;
    }
    if (typeof patch.selectedVoiceGuild === "string") {
      sharedUIState.selectedVoiceGuild = patch.selectedVoiceGuild;
    }
    if (typeof patch.selectedVoiceChannel === "string") {
      sharedUIState.selectedVoiceChannel = patch.selectedVoiceChannel;
    }
    if (typeof patch.selectedTextGuild === "string") {
      sharedUIState.selectedTextGuild = patch.selectedTextGuild;
    }
    if (typeof patch.selectedTextChannel === "string") {
      sharedUIState.selectedTextChannel = patch.selectedTextChannel;
    }
    if (activeTabs.includes(patch.activeTab as ActiveTab)) {
      sharedUIState.activeTab = patch.activeTab as ActiveTab;
    }
    if (typeof patch.isListening === "boolean") {
      sharedUIState.isListening = patch.isListening;
    }
    if (typeof patch.isStreaming === "boolean") {
      sharedUIState.isStreaming = patch.isStreaming;
    }

    await setPersistedValue("web-ui-state", sharedUIState);
    return getSharedUIState();
  }

  return { getSharedUIState, patchSharedUIState };
}
