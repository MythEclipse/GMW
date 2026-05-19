import http from "node:http";
import type { Client } from "discord.js-selfbot-v13";
import { config } from "../config";
import { createChildLogger } from "../logger";
import { MediaController } from "../media/mediaController";
import { createScreenShareController } from "../media/screenShareController";
import { createBroadcaster } from "../moderation/broadcaster";
import {
  initializeMediaSettings,
  persistMediaSettings,
} from "../state/mediaSettings";
import { createSharedUIStateStore } from "../state/uiState";
import { Streamer } from "../streaming";
import type { VoiceController } from "../voiceController";
import {
  exposeActiveUserGlobal,
  exposeModerationGlobals,
  exposePcmBroadcastGlobal,
  exposeVideoBroadcastGlobal,
} from "../ws/broadcastGlobals";
import { startWebSocketServer } from "../ws/server";
import { createHttpApp } from "./app";

const serverLogger = createChildLogger("webserver");

const activeUsers = new Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>();

export async function startWebserver(
  port: number = 3000,
  client: Client,
  voiceController: VoiceController,
) {
  const { getSharedUIState, patchSharedUIState } = await createSharedUIStateStore();
  let mediaSettings = await initializeMediaSettings();

  const wsPath = "/ws";

  const broadcaster = createBroadcaster();
  exposeModerationGlobals(broadcaster, config.ADMIN_PASSWORD);

  const streamer = new Streamer(client);
  const screenController = createScreenShareController({
    getVoiceStatus: () => voiceController.getStatus(),
    streamer,
    useTranscoder: true,
    onBeforeStreamStart: async () => {
      await voiceController.disconnect();
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
    client,
    voiceController,
    mediaController,
    broadcaster,
    adminPassword: config.ADMIN_PASSWORD,
    getSharedUIState,
    patchSharedUIState,
    activeUserCount: () => activeUsers.size,
    wsClientCount: () => broadcaster.clientCount(),
    logger: serverLogger,
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
  exposeVideoBroadcastGlobal(() => broadcaster.getClients(), serverLogger);
  exposeActiveUserGlobal(activeUsers, broadcastUserState);

  startWebSocketServer({
    server,
    port,
    wsPath,
    broadcaster,
    activeUsers,
    getSharedUIState,
    mediaController,
    logger: serverLogger,
  });

  server.listen(port, "0.0.0.0", () => {
    serverLogger.info({ port }, "Web interface listening");
  });
}
