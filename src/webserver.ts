import type { Client } from "discord.js-selfbot-v13";
import express from "express";
import fs from "fs";
import helmet from "helmet";
import http from "http";
import path from "path";
import * as prism from "prism-media";
import { WebSocketServer } from "ws";
import { AppError } from "./errors";
import { createChildLogger, logger } from "./logger";
import { getMetrics, uptimeGauge } from "./metrics";
import { createBroadcaster } from "./moderation/broadcaster";
import { getPersistedValue, setPersistedValue } from "./muxer-queue";
import { discordPlayer } from "./player";
import { createAnalysisRoutes } from "./routes/analysisRoutes";
import { createMessageRoutes } from "./routes/messageRoutes";
import { createSyncRoutes } from "./routes/syncRoutes";
import { createUIStateRoutes } from "./routes/uiStateRoutes";
import { createVoiceRoutes } from "./routes/voiceRoutes";
import type { VoiceController } from "./voiceController";

const wsLogger = createChildLogger("webserver");

const activeUsers = new Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>();

interface SharedUIState {
  selectedGuild: string;
  selectedVoiceChannel: string;
  selectedTextChannel: string;
  activeTab: "voice" | "text";
  isListening: boolean;
  isStreaming: boolean;
}

const defaultSharedUIState: SharedUIState = {
  selectedGuild: "",
  selectedVoiceChannel: "",
  selectedTextChannel: "",
  activeTab: "voice",
  isListening: false,
  isStreaming: false,
};

let sharedUIState: SharedUIState = { ...defaultSharedUIState };

async function initializeSharedUIState() {
  sharedUIState = await getPersistedValue("web-ui-state", defaultSharedUIState);
}

function getSharedUIState(): SharedUIState {
  return { ...sharedUIState };
}

function patchSharedUIState(patch: Partial<SharedUIState>) {
  if (typeof patch.selectedGuild === "string") {
    sharedUIState.selectedGuild = patch.selectedGuild;
  }
  if (typeof patch.selectedVoiceChannel === "string") {
    sharedUIState.selectedVoiceChannel = patch.selectedVoiceChannel;
  }
  if (typeof patch.selectedTextChannel === "string") {
    sharedUIState.selectedTextChannel = patch.selectedTextChannel;
  }
  if (patch.activeTab === "voice" || patch.activeTab === "text") {
    sharedUIState.activeTab = patch.activeTab;
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
  const out = Buffer.alloc(mono24k.length * 4);
  for (let i = 0; i < mono24k.length / 2; i++) {
    const s = mono24k.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 8);
    out.writeInt16LE(s, i * 8 + 2);
    out.writeInt16LE(s, i * 8 + 4);
    out.writeInt16LE(s, i * 8 + 6);
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
  return 20 * Math.log10(Math.max(rms, 1e-10));
}

export async function startWebserver(
  port: number = 3000,
  _client: Client,
  voiceController: VoiceController,
) {
  await initializeSharedUIState();

  const app = express();
  const server = http.createServer(app);

  const wsPath = "/ws";
  const wss = new WebSocketServer({ server, path: wsPath });
  wsLogger.info({ port, wsPath }, "WebSocket server listening");

  // Create broadcaster instance
  const broadcaster = createBroadcaster();
  (globalThis as any).moderationBroadcaster = broadcaster;

  // Security headers. CSP disabled because the current static UI uses inline scripts/styles.
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.use((req, res, next) => {
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

  app.get("/", (_req, res) => {
    const reactIndex = path.join(__dirname, "../public/app/index.html");
    if (fs.existsSync(reactIndex)) {
      res.sendFile(reactIndex);
    } else {
      res.sendFile(path.join(__dirname, "../public/index.html"));
    }
  });

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      activeUsers: activeUsers.size,
      wsClients: broadcaster.clientCount(),
    });
  });

  // Metrics endpoint
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", "text/plain");
    uptimeGauge.set(process.uptime());
    res.send(await getMetrics());
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
    }),
  );
  app.use("/api", createMessageRoutes());
  app.use("/api", createAnalysisRoutes());
  app.use("/api", createSyncRoutes(_client));

  // Inbound: Discord PCM → tagged chunks → browser
  (global as any).broadcastPcmToWeb = (chunk: Buffer, userId: string) => {
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

  (global as any).updateActiveUser = (
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

  const opusEncoder = new prism.opus.Encoder({
    rate: RATE,
    channels: CHANNELS,
    frameSize: FRAME_SIZE,
  });
  const oggBitstream = new prism.opus.OggLogicalBitstream({
    opusHead: new prism.opus.OpusHead({
      channelCount: CHANNELS,
      sampleRate: RATE,
    }),
    pageSizeControl: { maxPackets: 1 }, // 1 packet per page = 20ms latency
    crc: true,
  });
  opusEncoder.on("error", () => {});
  opusEncoder.pipe(oggBitstream);

  // Prime OGG headers before player starts reading
  opusEncoder.write(Buffer.alloc(BYTES_PER_FRAME, 0));
  discordPlayer.playStream(oggBitstream);
  discordPlayer.pause();

  let pcmBuffer = Buffer.alloc(0);
  let lastBrowserAudioTime = 0;
  let playerPaused = true;
  const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME, 0);

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

      if (playerPaused) {
        discordPlayer.unpause();
        playerPaused = false;
        wsLogger.info("Transmitting — Discord indicator ON");
      }
    } else if (msSinceAudio < SILENCE_TAIL_MS && msSinceAudio > 0) {
      // Buffer drained but audio was recent — pad silence to avoid OGG gap
      frame = SILENCE_FRAME;
    } else if (!playerPaused && msSinceAudio >= SILENCE_TAIL_MS) {
      // No audio for a while — pause Discord indicator
      discordPlayer.pause();
      playerPaused = true;
      wsLogger.info("Stopped — Discord indicator OFF");
      return;
    } else {
      return; // already paused, nothing to do
    }

    // Write one frame. If encoder is backpressured, skip this tick to avoid stalling.
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

    ws.on("message", (data: any) => {
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
