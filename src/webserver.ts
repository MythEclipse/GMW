import type { Client } from "discord.js-selfbot-v13";
import express from "express";
import helmet from "helmet";
import http from "http";
import path from "path";
import pinoHttp from "pino-http";
import * as prism from "prism-media";
import { WebSocketServer } from "ws";
import { AppError } from "./errors";
import { createChildLogger, logger } from "./logger";
import { getMetrics, uptimeGauge } from "./metrics";
import { discordPlayer } from "./player";
import type { VoiceController } from "./voiceController";
import { getDatabase } from "./muxer-queue";
import { getMessagesByChannel, getAttachmentsByChannel } from "./moderation/messageStore";

const wsLogger = createChildLogger("webserver");

const activeUsers = new Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>();
let wsClients = new Set<any>();

interface SharedUIState {
  selectedGuild: string;
  selectedVoiceChannel: string;
  selectedTextChannel: string;
  activeTab: "voice" | "text";
  isListening: boolean;
  isStreaming: boolean;
}

const sharedUIState: SharedUIState = {
  selectedGuild: "",
  selectedVoiceChannel: "",
  selectedTextChannel: "",
  activeTab: "voice",
  isListening: false,
  isStreaming: false,
};

function getSharedUIState(): SharedUIState {
  return { ...sharedUIState };
}

function broadcastUIState() {
  const payload = JSON.stringify({
    type: "ui_state",
    state: getSharedUIState(),
  });
  wsClients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
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
  broadcastUIState();
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

export function startWebserver(
  port: number = 3000,
  _client: Client,
  voiceController: VoiceController,
) {
  const app = express();
  const server = http.createServer(app);

  const wsPath = "/ws";
  const wss = new WebSocketServer({ server, path: wsPath });
  wsLogger.info({ port, wsPath }, "WebSocket server listening");

  // Security headers. CSP disabled because the current static UI uses inline scripts/styles.
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  // HTTP request logging
  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.use(express.static(path.join(__dirname, "../public")));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
  });

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      activeUsers: activeUsers.size,
      wsClients: wsClients.size,
    });
  });

  // Metrics endpoint
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", "text/plain");
    uptimeGauge.set(process.uptime());
    res.send(await getMetrics());
  });

  app.get("/api/status", (_req, res) => {
    res.json(voiceController.getStatus());
  });

  app.get("/api/ui-state", (_req, res) => {
    res.json(getSharedUIState());
  });

  app.post("/api/ui-state", (req, res) => {
    res.json(patchSharedUIState(req.body as Partial<SharedUIState>));
  });

  app.get("/api/guilds", (_req, res) => {
    res.json(voiceController.listGuilds());
  });

  app.get("/api/guilds/:guildId/voice-channels", async (req, res, next) => {
    try {
      res.json(await voiceController.listVoiceChannels(req.params.guildId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/guilds/:guildId/channels", async (req, res, next) => {
    try {
      res.json(await voiceController.listWatchableChannels(req.params.guildId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/guilds/:guildId/threads", async (req, res, next) => {
    try {
      res.json(await voiceController.listThreads(req.params.guildId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/connect", async (req, res, next) => {
    try {
      const { guildId, channelId } = req.body as {
        guildId?: string;
        channelId?: string;
      };

      if (!guildId || !channelId) {
        throw new AppError(
          "guildId and channelId are required",
          "MISSING_CONNECT_FIELDS",
          400,
        );
      }

      const status = await voiceController.connect(guildId, channelId);
      patchSharedUIState({
        selectedGuild: guildId,
        selectedVoiceChannel: channelId,
      });
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/disconnect", async (_req, res, next) => {
    try {
      res.json(await voiceController.disconnect());
    } catch (error) {
      next(error);
    }
  });

  // Moderation API endpoints
  app.get("/api/messages", async (req, res, next) => {
    try {
      const db = getDatabase();
      const { channel, type, limit = "50", offset = "0" } = req.query as {
        channel?: string;
        type?: string;
        limit?: string;
        offset?: string;
      };

      if (!channel) {
        throw new AppError("channel query parameter is required", "MISSING_CHANNEL", 400);
      }

      const limitNum = Math.min(parseInt(limit) || 50, 100);
      const offsetNum = parseInt(offset) || 0;

      if (type === "image") {
        const attachments = getAttachmentsByChannel(db, channel, limitNum, offsetNum);
        res.json({
          type: "image",
          data: attachments,
          count: attachments.length,
        });
      } else {
        const messages = getMessagesByChannel(db, channel, limitNum, offsetNum);
        res.json({
          type: "text",
          data: messages,
          count: messages.length,
        });
      }
    } catch (error) {
      next(error);
    }
  });

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
    wsClients.forEach((client) => {
      if (client.readyState === 1) client.send(packet);
    });
  };

  (global as any).updateActiveUser = (
    userId: string,
    data: { username: string; avatar: string; speaking: boolean },
  ) => {
    activeUsers.set(userId, data);
    broadcastUserState();
  };

  function broadcastUserState() {
    const payload = JSON.stringify({
      type: "user_state",
      users: Array.from(activeUsers.entries()).map(([id, data]) => ({
        id,
        ...data,
      })),
    });
    wsClients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  }

  function broadcastMessageEvent(type: string, data: any) {
    const payload = JSON.stringify({
      type,
      data,
      timestamp: Date.now(),
    });
    wsClients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  }

  (global as any).broadcastMessageCreated = (data: any) => {
    broadcastMessageEvent("message_created", data);
  };

  (global as any).broadcastMessageUpdated = (data: any) => {
    broadcastMessageEvent("message_updated", data);
  };

  (global as any).broadcastMessageDeleted = (data: any) => {
    broadcastMessageEvent("message_deleted", data);
  };

  (global as any).broadcastAttachmentUploaded = (data: any) => {
    broadcastMessageEvent("attachment_uploaded", data);
  };

  (global as any).broadcastMessageAnalyzed = (data: any) => {
    broadcastMessageEvent("message_analyzed", data);
  };

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
    wsClients.add(ws);

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
      wsClients.delete(ws);
    });
    ws.on("error", () => {
      wsClients.delete(ws);
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
