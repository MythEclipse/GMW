import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AudioPlayerStatus } from "@discordjs/voice";
import type { Client } from "discord.js-selfbot-v13";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import * as prism from "prism-media";
import { WebSocketServer } from "ws";
import { config } from "./config";
import { AppError } from "./errors";
import { createChildLogger, logger } from "./logger";
import { MediaController } from "./media/mediaController";
import { createScreenShareController } from "./media/screenShareController";
import { getMetrics, uptimeGauge } from "./metrics";
import { createBroadcaster } from "./moderation/broadcaster";
import type { ModerationBroadcaster } from "./moderation/types";
import { getPersistedValue, setPersistedValue } from "./muxer-queue";
import { discordPlayer } from "./player";
import { createAnalysisRoutes } from "./routes/analysisRoutes";
import { createMediaRoutes } from "./routes/mediaRoutes";
import { createMessageRoutes } from "./routes/messageRoutes";
import { createSyncRoutes } from "./routes/syncRoutes";
import { createUIStateRoutes } from "./routes/uiStateRoutes";
import { createVoiceRoutes } from "./routes/voiceRoutes";
import { Streamer } from "./streaming";
import type { VoiceController } from "./voiceController";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const wsLogger = createChildLogger("webserver");

const activeUsers = new Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>();

type VoiceGlobals = typeof globalThis & {
  moderationBroadcaster?: ModerationBroadcaster;
  broadcastPcmToWeb?: (chunk: Buffer, userId: string) => void;
  broadcastVideoToWeb?: (chunk: Buffer) => void;
  updateActiveUser?: (
    userId: string,
    data: { username: string; avatar: string; speaking: boolean },
  ) => void;
};

interface SharedUIState {
  selectedVoiceGuild: string;
  selectedVoiceChannel: string;
  selectedTextGuild: string;
  selectedTextChannel: string;
  activeTab: "voice" | "messages" | "media" | "review";
  isListening: boolean;
  isStreaming: boolean;
}

interface MediaSettings {
  musicVolume: number;
}

type SharedUIStatePatch = Partial<SharedUIState> & {
  selectedGuild?: string;
};

const defaultSharedUIState: SharedUIState = {
  selectedVoiceGuild: "",
  selectedVoiceChannel: "",
  selectedTextGuild: "",
  selectedTextChannel: "",
  activeTab: "voice",
  isListening: false,
  isStreaming: false,
};

const defaultMediaSettings: MediaSettings = {
  musicVolume: 1,
};

let sharedUIState: SharedUIState = { ...defaultSharedUIState };

export function normalizeSharedUIState(
  value: SharedUIStatePatch,
): SharedUIState {
  const guild = value.selectedGuild ?? "";
  return {
    selectedVoiceGuild: value.selectedVoiceGuild ?? guild,
    selectedVoiceChannel: value.selectedVoiceChannel ?? "",
    selectedTextGuild: value.selectedTextGuild ?? guild,
    selectedTextChannel: value.selectedTextChannel ?? "",
    activeTab: (["voice", "messages", "media", "review"].includes(
      value.activeTab ?? "",
    )
      ? value.activeTab
      : "voice") as "voice" | "messages" | "media" | "review",
    isListening: value.isListening ?? false,
    isStreaming: value.isStreaming ?? false,
  };
}

async function initializeSharedUIState() {
  sharedUIState = normalizeSharedUIState(
    await getPersistedValue("web-ui-state", defaultSharedUIState),
  );
}

async function initializeMediaSettings(): Promise<MediaSettings> {
  const stored = await getPersistedValue(
    "media-settings",
    defaultMediaSettings,
  );
  return {
    ...defaultMediaSettings,
    ...(stored as MediaSettings),
  };
}

function getSharedUIState(): SharedUIState {
  return { ...sharedUIState };
}

function patchSharedUIState(patch: SharedUIStatePatch) {
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
  if (
    ["voice", "messages", "media", "review"].includes(patch.activeTab ?? "")
  ) {
    sharedUIState.activeTab = patch.activeTab as
      | "voice"
      | "messages"
      | "media"
      | "review";
  }
  if (typeof patch.isListening === "boolean") {
    sharedUIState.isListening = patch.isListening;
  }
  if (typeof patch.isStreaming === "boolean") {
    sharedUIState.isStreaming = patch.isStreaming;
  }
  setPersistedValue("web-ui-state", sharedUIState);
  return getSharedUIState();
}

// Upsample 24kHz mono s16le → 48kHz stereo s16le (pure JS)
function upsample(mono24k: Buffer): Buffer {
  const numSamples = mono24k.length / 2;
  const out = Buffer.alloc(numSamples * 8);
  for (let i = 0; i < numSamples; i++) {
    const s = mono24k.readInt16LE(i * 2);
    const base = i * 8;
    out.writeInt16LE(s, base);
    out.writeInt16LE(s, base + 2);
    out.writeInt16LE(s, base + 4);
    out.writeInt16LE(s, base + 6);
  }
  return out;
}

// Calculate RMS dB level of a PCM s16le buffer
function rmsDb(pcm: Buffer): number {
  let sum = 0;
  const samples = pcm.length / 2;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples);
  return 20 * Math.log10(rms);
}

export async function startWebserver(
  port: number = 3000,
  _client: Client,
  voiceController: VoiceController,
) {
  await initializeSharedUIState();
  let mediaSettings = await initializeMediaSettings();

  const app = express();
  const server = http.createServer(app);

  const wsPath = "/ws";
  const wss = new WebSocketServer({ server, path: wsPath });
  wsLogger.info({ port, wsPath }, "WebSocket server listening");

  // Create broadcaster instance
  const broadcaster = createBroadcaster();
  (globalThis as VoiceGlobals).moderationBroadcaster = broadcaster;
  (globalThis as any).ADMIN_PASSWORD = config.ADMIN_PASSWORD;

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
    isBrowserStreaming: () => sharedUIState.isStreaming,
    screenController,
    onStateChange: (state) => broadcaster.mediaState(state),
    initialMusicVolume: mediaSettings.musicVolume,
    onMusicVolumeChange: async (volume) => {
      mediaSettings = { ...mediaSettings, musicVolume: volume };
      await setPersistedValue("media-settings", mediaSettings);
    },
  });

  // Security headers. CSP disabled because the current static UI uses inline scripts/styles.
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/")) {
      res.set("Cache-Control", "no-store");
    }
    res.on("finish", () => {
      if (req.originalUrl.startsWith("/.well-known/appspecific/")) return;
      if (req.originalUrl === "/favicon.ico") return;
      if (res.statusCode >= 400) {
        logger.error(
          {
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
          },
          "HTTP request failed",
        );
      }
    });
    next();
  });
  app.use(express.json());

  app.use(express.static(path.join(__dirname, "../public")));
  app.use(express.static(path.join(__dirname, "../public/app")));

  app.get("/", (_req: Request, res: Response) => {
    const reactIndex = path.join(__dirname, "../public/app/index.html");
    if (fs.existsSync(reactIndex)) {
      res.sendFile(reactIndex);
      return;
    }
    res
      .status(503)
      .send("React dashboard is not built. Run pnpm run build:web.");
  });

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      activeUsers: activeUsers.size,
      wsClients: broadcaster.clientCount(),
    });
  });

  // Metrics endpoint
  app.get("/metrics", async (_req: Request, res: Response) => {
    res.set("Content-Type", "text/plain");
    uptimeGauge.set(process.uptime());
    res.send(await getMetrics());
  });

  // Simple password-based auth
  app.post("/api/auth/login", (req: Request, res: Response) => {
    const { password } = req.body;
    if (password === config.ADMIN_PASSWORD) {
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  });

  // Register route modules
  app.use(
    "/api",
    createUIStateRoutes({ getSharedUIState, patchSharedUIState }),
  );
  app.use(
    "/api",
    createVoiceRoutes({
      voiceController,
      patchSharedUIState,
      broadcaster,
      adminPassword: config.ADMIN_PASSWORD,
    }),
  );
  app.use("/api", createMessageRoutes());
  app.use("/api", createAnalysisRoutes());
  app.use("/api", createSyncRoutes(_client));
  app.use(
    "/api",
    createMediaRoutes(mediaController, {
      adminPassword: config.ADMIN_PASSWORD,
    }),
  );

  // Inbound: Discord PCM → tagged chunks → browser
  (globalThis as VoiceGlobals).broadcastPcmToWeb = (
    chunk: Buffer,
    userId: string,
  ) => {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash << 5) - hash + userId.charCodeAt(i);
      hash |= 0;
    }
    const header = Buffer.alloc(4);
    header.writeInt32LE(hash, 0);
    const packet = Buffer.concat([header, chunk]);
    for (const client of broadcaster.getClients()) {
      if (client.readyState === 1) client.send(packet);
    }
  };

  // Outbound: server video stream (matroska chunks) -> browser clients
  (globalThis as VoiceGlobals).broadcastVideoToWeb = (chunk: Buffer) => {
    for (const client of broadcaster.getClients()) {
      if (client.readyState === 1) {
        try {
          client.send(chunk);
        } catch (err) {
          wsLogger.warn({ err }, "Failed to send video chunk");
        }
      }
    }
  };

  (globalThis as VoiceGlobals).updateActiveUser = (
    userId: string,
    data: { username: string; avatar: string; speaking: boolean },
  ) => {
    activeUsers.set(userId, data);
    broadcastUserState();
  };

  function broadcastUserState() {
    const users = Array.from(activeUsers.entries()).map(([id, data]) => ({
      id,
      ...data,
    }));
    broadcaster.userState(users);
  }

  // --- Outbound: browser PCM (24kHz mono) → Opus → Discord ---
  const RATE = 48000;
  const CHANNELS = 2;
  const FRAME_SIZE = 960;
  const BYTES_PER_FRAME = FRAME_SIZE * CHANNELS * 2; // 3840 bytes = 20ms
  const SILENCE_TAIL_MS = 300; // continue sending silence for 300ms after browser stops
  const MAX_BUF_BYTES = BYTES_PER_FRAME * 50; // cap at 1 second to avoid runaway buffer

  let opusEncoder: prism.opus.Encoder | null = null;
  let bridgePlayerPaused = true;
  const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME, 0);

  function startBrowserAudioBridge(): void {
    if (opusEncoder) return;
    opusEncoder = new prism.opus.Encoder({
      rate: RATE,
      channels: CHANNELS,
      frameSize: FRAME_SIZE,
    });
    const oggBitstream = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({
        channelCount: CHANNELS,
        sampleRate: RATE,
      }),
      pageSizeControl: { maxPackets: 1 },
      crc: true,
    });
    opusEncoder.on("error", () => {});
    opusEncoder.pipe(oggBitstream);
    opusEncoder.write(Buffer.alloc(BYTES_PER_FRAME, 0));
    discordPlayer.playStream(oggBitstream, "browser-bridge");
    discordPlayer.pause("browser-bridge");
    bridgePlayerPaused = true;
  }

  function ensureBrowserAudioBridge(): boolean {
    const owner = discordPlayer.getOwner();
    if (owner !== "none" && owner !== "browser-bridge") return false;
    if (
      owner === "none" ||
      discordPlayer.getStatus() === AudioPlayerStatus.Idle
    ) {
      startBrowserAudioBridge();
    }
    return true;
  }

  let pcmBuffer = Buffer.alloc(0);
  let lastBrowserAudioTime = 0;

  // Log level every 2 seconds
  let dbAccum = 0,
    dbCount = 0;
  setInterval(() => {
    if (dbCount > 0) {
      const avg = dbAccum / dbCount;
      wsLogger.info({ level: avg.toFixed(1), frames: dbCount }, "Audio level");
      dbAccum = 0;
      dbCount = 0;
    }
  }, 2000);

  // PULL-BASED encode loop: fires every 20ms, pulls exactly one frame from buffer.
  // This avoids the timing conflict where browser bursts and silence timer collide.
  setInterval(() => {
    const msSinceAudio = Date.now() - lastBrowserAudioTime;
    let frame: Buffer | null = null;

    if (pcmBuffer.length >= BYTES_PER_FRAME) {
      // Real audio available
      frame = pcmBuffer.subarray(0, BYTES_PER_FRAME);
      pcmBuffer = pcmBuffer.subarray(BYTES_PER_FRAME);

      // Track level for logging
      dbAccum += rmsDb(frame);
      dbCount++;

      if (!ensureBrowserAudioBridge()) {
        pcmBuffer = Buffer.alloc(0);
        return;
      }
      if (bridgePlayerPaused) {
        const unpaused = discordPlayer.unpause("browser-bridge");
        bridgePlayerPaused = false;
        wsLogger.info({ unpaused }, "Transmitting — Discord indicator ON");
      }
    } else if (msSinceAudio < SILENCE_TAIL_MS && msSinceAudio > 0) {
      // Buffer drained but audio was recent — pad silence to avoid OGG gap
      frame = SILENCE_FRAME;
    } else if (!bridgePlayerPaused && msSinceAudio >= SILENCE_TAIL_MS) {
      // No audio for a while — pause Discord indicator
      discordPlayer.pause("browser-bridge");
      bridgePlayerPaused = true;
      wsLogger.info("Stopped — Discord indicator OFF");
      return;
    } else {
      return; // already paused, nothing to do
    }

    // Write one frame. If encoder is backpressured, skip this tick to avoid stalling.
    if (!opusEncoder) return;
    const ok = opusEncoder.write(frame);
    if (!ok) {
      opusEncoder.once("drain", () => {}); // re-arm drain without blocking
    }
  }, 20);

  wss.on("connection", (ws) => {
    wsLogger.info({ port, wsPath }, "New WebSocket connection");
    broadcaster.addClient(ws);

    ws.send(
      JSON.stringify({
        type: "user_state",
        users: Array.from(activeUsers.entries()).map(([id, data]) => ({
          id,
          ...data,
        })),
      }),
    );
    ws.send(JSON.stringify({ type: "ui_state", state: getSharedUIState() }));
    ws.send(
      JSON.stringify({
        type: "media_state",
        state: mediaController.getState(),
      }),
    );

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (!Buffer.isBuffer(data)) return;
      lastBrowserAudioTime = Date.now();

      // Upsample 24kHz mono → 48kHz stereo and add to buffer
      const upsampled = upsample(data);

      // Cap buffer to avoid runaway growth during stall
      if (pcmBuffer.length < MAX_BUF_BYTES) {
        pcmBuffer = Buffer.concat([pcmBuffer, upsampled]);
      }
    });

    ws.on("close", () => {
      broadcaster.removeClient(ws);
    });
    ws.on("error", () => {
      broadcaster.removeClient(ws);
    });
  });

  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }

      wsLogger.error({ error }, "Unhandled webserver error");
      res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      });
    },
  );

  server.listen(port, "0.0.0.0", () => {
    wsLogger.info({ port }, "Web interface listening");
  });
}
