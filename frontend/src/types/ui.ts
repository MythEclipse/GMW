export type DashboardTab = "voice" | "media" | "messages" | "review" | "recordings" | "analytics";

export interface UIState {
  selectedGuild?: string;
  selectedVoiceGuild?: string;
  selectedVoiceChannel?: string;
  selectedTextGuild?: string;
  selectedTextChannel?: string;
  activeTab?: DashboardTab;
  isListening?: boolean;
  isStreaming?: boolean;
}
