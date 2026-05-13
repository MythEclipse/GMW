import express from "express";
import http from "http";
import path from "path";
import prism from "prism-media";
import { WebSocketServer } from "ws";
import { discordPlayer } from "./player";

const activeUsers = new Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>();
let wsClients = new Set<any>();

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

export function startWebserver(port: number = 3000) {
  const app = express();
  const server = http.createServer(app);

  const wsPort = port + 1;
  const wss = new WebSocketServer({ port: wsPort, host: "0.0.0.0" });
  console.log(
    `[webserver] WebSocket server listening on ws://0.0.0.0:${wsPort}`,
  );

  app.use(express.static(path.join(__dirname, "../public")));

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
      console.log(
        `[transmit] Audio level: ${avg.toFixed(1)} dBFS (${dbCount} frames/2s)`,
      );
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
      frame = pcmBuffer.slice(0, BYTES_PER_FRAME);
      pcmBuffer = pcmBuffer.slice(BYTES_PER_FRAME);

      // Track level for logging
      dbAccum += rmsDb(frame);
      dbCount++;

      if (playerPaused) {
        discordPlayer.unpause();
        playerPaused = false;
        console.log("[transmit] Transmitting — Discord indicator ON");
      }
    } else if (msSinceAudio < SILENCE_TAIL_MS && msSinceAudio > 0) {
      // Buffer drained but audio was recent — pad silence to avoid OGG gap
      frame = SILENCE_FRAME;
    } else if (!playerPaused && msSinceAudio >= SILENCE_TAIL_MS) {
      // No audio for a while — pause Discord indicator
      discordPlayer.pause();
      playerPaused = true;
      console.log("[transmit] Stopped — Discord indicator OFF");
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
    console.log("[webserver] New WebSocket connection on port " + wsPort);
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

  server.listen(port, "0.0.0.0", () => {
    console.log(
      `[webserver] Web interface listening on http://0.0.0.0:${port}`,
    );
  });
}
