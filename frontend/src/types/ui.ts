export type DashboardTab = "live" | "messages" | "analytics";

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
