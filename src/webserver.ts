import http from "node:http";
import type { Client } from "discord.js-selfbot-v13";
import { config } from "./config";
import { createChildLogger } from "./logger";
import { MediaController } from "./media/mediaController";
import { createScreenShareController } from "./media/screenShareController";
import { createBroadcaster } from "./moderation/broadcaster";
import { createSharedUIStateStore } from "./state/uiState";
import { Streamer } from "./streaming";
import type { VoiceController } from "./voiceController";
import {
  initializeMediaSettings,
  persistMediaSettings,
} from "./state/mediaSettings";
import {
  exposeActiveUserGlobal,
  exposeModerationGlobals,
  exposePcmBroadcastGlobal,
  exposeVideoBroadcastGlobal,
} from "./ws/broadcastGlobals";
import { startWebSocketServer } from "./ws/server";
import { createHttpApp } from "./http/app";

const wsLogger = createChildLogger("webserver");

const activeUsers = new Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>();

export async function startWebserver(
  port: number = 3000,
  _client: Client,
  voiceController: VoiceController,
) {
  const { getSharedUIState, patchSharedUIState } = await createSharedUIStateStore();
  let mediaSettings = await initializeMediaSettings();

  const wsPath = "/ws";

  // Create broadcaster instance
  const broadcaster = createBroadcaster();
  exposeModerationGlobals(broadcaster, config.ADMIN_PASSWORD);

  const streamer = new Streamer(_client);
  const screenController = createScreenShareController({
    getVoiceStatus: () => voiceController.getStatus(),
    streamer,
    useTranscoder: true,
    onBeforeStreamStart: async (guildId: string, channelId: string) => {
      await voiceController.disconnect();
      // Wait for Discord gateway to fully process the disconnect
      await new Promise((resolve) => setTimeout(resolve, 1500));
    },
    onAfterStreamEnd: async (guildId: string, channelId: string) => {
      const current = voiceController.getStatus();
      if (current.connected && current.activeGuildId === guildId) return;
      await voiceController.connect(guildId, channelId);
    },
  });

  const mediaController = new MediaController({
    isVoiceConnected: () => voiceController.getStatus().connected,
    isBrowserStreaming: () => getSharedUIState().isStreaming,
    screenController,
    onStateChange: (state) => broadcaster.mediaState(state),
    initialMusicVolume: mediaSettings.musicVolume,
    onMusicVolumeChange: async (volume) => {
      mediaSettings = { ...mediaSettings, musicVolume: volume };
      await persistMediaSettings(mediaSettings);
    },
  });

  const app = createHttpApp({
    client: _client,
    voiceController,
    mediaController,
    broadcaster,
    adminPassword: config.ADMIN_PASSWORD,
    getSharedUIState,
    patchSharedUIState,
    activeUserCount: () => activeUsers.size,
    wsClientCount: () => broadcaster.clientCount(),
    logger: wsLogger,
  });

  const server = http.createServer(app);

  function broadcastUserState() {
    const users = Array.from(activeUsers.entries()).map(([id, data]) => ({
      id,
      ...data,
    }));
    broadcaster.userState(users);
  }

  exposePcmBroadcastGlobal(broadcaster);
  exposeVideoBroadcastGlobal(() => broadcaster.getClients(), wsLogger);
  exposeActiveUserGlobal(activeUsers, broadcastUserState);

  startWebSocketServer({
    server,
    port,
    wsPath,
    broadcaster,
    activeUsers,
    getSharedUIState,
    mediaController,
    logger: wsLogger,
  });

  server.listen(port, "0.0.0.0", () => {
    wsLogger.info({ port }, "Web interface listening");
  });
}
