import { describe, expect, it } from "vitest";
import { normalizeSharedUIState } from "../../src/state/uiState";

describe("normalizeSharedUIState", () => {
  it("maps legacy selectedGuild into voice and text guilds", () => {
    expect(normalizeSharedUIState({ selectedGuild: "guild-1" })).toEqual({
      selectedVoiceGuild: "guild-1",
      selectedVoiceChannel: "",
      selectedTextGuild: "guild-1",
      selectedTextChannel: "",
      activeTab: "voice",
      isListening: false,
      isStreaming: false,
    });
  });

  it("keeps valid explicit values", () => {
    expect(
      normalizeSharedUIState({
        selectedVoiceGuild: "voice-guild",
        selectedVoiceChannel: "voice-channel",
        selectedTextGuild: "text-guild",
        selectedTextChannel: "text-channel",
        activeTab: "media",
        isListening: true,
        isStreaming: true,
      }),
    ).toEqual({
      selectedVoiceGuild: "voice-guild",
      selectedVoiceChannel: "voice-channel",
      selectedTextGuild: "text-guild",
      selectedTextChannel: "text-channel",
      activeTab: "media",
      isListening: true,
      isStreaming: true,
    });
  });

  it("falls back to voice tab for invalid activeTab", () => {
    expect(normalizeSharedUIState({ activeTab: "bad" as never })).toMatchObject({
      activeTab: "voice",
    });
  });
});
