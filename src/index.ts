import "./mock-crc";
import "libsodium-wrappers";
import "@snazzah/davey";
import { getVoiceConnection } from "@discordjs/voice";
import { Client } from "discord.js-selfbot-v13";
import { config } from "./config";
import { discordPlayer } from "./player";
import { startRecording } from "./recorder";
import { startWebserver } from "./webserver";

// Validasi environment variables
const token = process.env.DISCORD_TOKEN;
const voiceChannelId = process.env.VOICE_CHANNEL_ID;
const guildId = process.env.GUILD_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!voiceChannelId) throw new Error("Missing VOICE_CHANNEL_ID in .env");
if (!guildId) throw new Error("Missing GUILD_ID in .env");

// Inisialisasi selfbot client (gunakan checkUpdate: false supaya tidak ada prompt update)
const client = new Client();

client.on("ready", async () => {
  if (config.verbose) {
    console.log(`[bot] Logged in as ${client.user!.tag}`);
  }

  // Ambil guild
  const guild = client.guilds.cache.get(guildId!);
  if (!guild) {
    console.error(`[bot] Guild not found: ${guildId}`);
    process.exit(1);
  }

  // Fetch channels jika belum ada di cache
  const channel =
    guild.channels.cache.get(voiceChannelId!) ??
    (await guild.channels.fetch(voiceChannelId!).catch(() => null));

  if (!channel || channel.type !== "GUILD_VOICE") {
    console.error(
      `[bot] Voice channel not found or wrong type: ${voiceChannelId}`,
    );
    process.exit(1);
  }

  if (config.verbose) {
    console.log(
      `[bot] Joining voice channel: #${channel.name} (${channel.id})`,
    );
  }
  await startRecording(client, channel as any);

  // Set up player connection
  const connection = getVoiceConnection(guildId!);
  if (connection) {
    discordPlayer.setConnection(connection);
    console.log("[bot] Player connected to voice channel");
  }

  // Start Webserver
  startWebserver(3000);
});

client.on("error", (err) => {
  console.error("[bot] Client error:", err);
});

// Graceful shutdown
process.on("SIGINT", () => {
  if (config.verbose) {
    console.log("\n[bot] Shutting down...");
  }
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (config.verbose) {
    console.log("[bot] Terminating...");
  }
  client.destroy();
  process.exit(0);
});

client.login(token);
