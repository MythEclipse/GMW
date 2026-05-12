import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import {
    EndBehaviorType,
    joinVoiceChannel,
    VoiceConnectionStatus,
    entersState,
    getVoiceConnection,
} from "@discordjs/voice";
import type { VoiceChannel, Client } from "discord.js-selfbot-v13";
import prism from "prism-media";

import { PacketFilter } from "./packetFilter";
import { config } from "./config";
const recordingsDir = process.env.RECORDINGS_DIR ?? "./recordings";

// Pastikan folder recordings ada
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
}

/**
 * Join ke voice channel dan mulai merekam semua user yang bicara.
 */
export async function startRecording(client: Client, channel: VoiceChannel): Promise<void> {
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator as any,
        selfDeaf: false,
        selfMute: false,
        debug: true,
    });

    if (config.verbose) {
        console.log(`[recorder] Joining voice channel: #${channel.name}`);
    }

    connection.on('debug', msg => {
        if (config.verbose) {
            console.log(`[voice-debug] ${msg}`);
        }
    });

    connection.on('error', err => {
        console.error(`[voice-error]`, err);
    });

    // Tunggu sampai benar-benar terhubung
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        if (config.verbose) {
            console.log("[recorder] Connected to voice channel. Recording started.");
        }
    } catch (err) {
        console.error("[recorder] Failed to connect:", err);
        connection.destroy();
        return;
    }

    const receiver = connection.receiver;

    // Dengarkan siapapun yang mulai bicara
    receiver.speaking.on("start", async (userId) => {
        // Coba ambil data user dari cache atau fetch dari API
        const user = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);
        const member = channel.guild.members.cache.get(userId) || await channel.guild.members.fetch(userId).catch(() => null);
        const username = user?.username ?? "Unknown User";
        const avatarUrl = user?.displayAvatarURL({ format: "png", size: 64 }) ?? "https://cdn.discordapp.com/embed/avatars/0.png";
        const displayName = member?.displayName ?? username;
        const roles = member?.roles.cache
            .filter((role) => role.id !== channel.guild.id)
            .sort((a, b) => b.position - a.position)
            .map((role) => ({ id: role.id, name: role.name, position: role.position })) ?? [];
        const highestRole = roles.length > 0 ? roles[0] : null;
        const joinedTimestamp = member?.joinedTimestamp ?? null;

        // Tampilkan format "nama user [voice activity]"
        console.log(`${username} [voice activity]`);
        
        // Notify webserver
        if ((global as any).updateActiveUser) {
            (global as any).updateActiveUser(userId, { username, avatar: avatarUrl, speaking: true });
        }

        // Jangan record kalau sudah ada stream aktif untuk user ini
        if (receiver.subscriptions.has(userId)) return;

        const timestamp = Date.now();
        const sessionStartTime = timestamp;
        const sessionId = `${userId}-${sessionStartTime}`;
        const recordingSegmentMsRaw = Number(process.env.RECORDING_SEGMENT_MS ?? 5_000);
        const recordingSegmentMs = Number.isFinite(recordingSegmentMsRaw) && recordingSegmentMsRaw > 0
            ? recordingSegmentMsRaw
            : 0;
        const userDir = path.join(recordingsDir, userId);
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }

        const audioStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 3000,
            },
        });

        try {
            // --- OGG file recording with segment rotation ---
            const packetFilterForOgg = new PacketFilter(8);
            const oggPacketStream = audioStream.pipe(packetFilterForOgg);
            let segmentIndex = 0;
            let currentSegment: {
                index: number;
                startTime: number;
                endTime: number | null;
                filename: string;
                jsonFilename: string;
                oggStream: any;
                out: fs.WriteStream;
            } | null = null;

            const openSegment = () => {
                const index = segmentIndex++;
                const startTime = Date.now();
                const segmentFilename = path.join(userDir, `${startTime}.ogg`);
                const segmentJsonFilename = path.join(userDir, `${startTime}.json`);
                const oggStream = new prism.opus.OggLogicalBitstream({
                    opusHead: new prism.opus.OpusHead({ channelCount: 2, sampleRate: 48000 }),
                    pageSizeControl: { maxPackets: 10 },
                    crc: true,
                });
                const out = fs.createWriteStream(segmentFilename);
                oggPacketStream.pipe(oggStream).pipe(out);

                const segment = {
                    index,
                    startTime,
                    endTime: null as number | null,
                    filename: segmentFilename,
                    jsonFilename: segmentJsonFilename,
                    oggStream,
                    out,
                };

                out.on("finish", () => {
                    if (config.verbose) {
                        console.log(`[recorder] Saved: ${segment.filename}`);
                    }
                    const endTime = segment.endTime ?? Date.now();

                    const eventMetadata = {
                        userId,
                        username,
                        tag: user?.tag ?? "Unknown#0000",
                        displayName,
                        avatarUrl,
                        bot: user?.bot ?? false,
                        roles,
                        highestRole,
                        joinedTimestamp,
                        sessionId,
                        sessionStartTime,
                        segmentIndex: segment.index,
                        segmentMs: recordingSegmentMs,
                        startTime: segment.startTime,
                        endTime,
                        durationMs: endTime - segment.startTime,
                        filename: path.basename(segment.filename)
                    };
                    fs.writeFileSync(segment.jsonFilename, JSON.stringify(eventMetadata, null, 2));
                    if (config.verbose) {
                        console.log(`[recorder] Saved metadata: ${segment.jsonFilename}`);
                    }
                });

                out.on("error", (err) => {
                    console.error(`[recorder] File write error ${userId}:`, err.message);
                });

                return segment;
            };

            const closeSegment = () => {
                if (!currentSegment) return;
                currentSegment.endTime = Date.now();
                oggPacketStream.unpipe(currentSegment.oggStream);
                currentSegment.oggStream.end();
                currentSegment = null;
            };

            const rotateSegmentIfNeeded = () => {
                if (!currentSegment) return;
                if (recordingSegmentMs <= 0) return;
                if (Date.now() - currentSegment.startTime < recordingSegmentMs) return;
                closeSegment();
                currentSegment = openSegment();
            };

            currentSegment = openSegment();

            // --- Web broadcast: prism decoder with safe restart and cooldown ---
            // OpusScript can crash on long/invalid streams; avoid taking down the process.
            const decoderConfig = { frameSize: 960, channels: 2, rate: 48000 };
            const decoderCooldownMs = 30_000;
            const decoderRotateMs = Number(process.env.DECODER_ROTATE_MS ?? 5_000);
            let currentDecoder: prism.opus.Decoder | null = null;
            let decoderDisabledUntil = 0;
            let decoderCreatedAt = 0;

            const handlePcm = (pcm: Buffer) => {
                if (!(global as any).broadcastPcmToWeb) return;
                // Downsample 48kHz stereo → 24kHz mono (left channel, every 2nd sample)
                const outBuf = Buffer.alloc(pcm.length / 4);
                for (let i = 0; i < outBuf.length / 2; i++) {
                    outBuf.writeInt16LE(pcm.readInt16LE(i * 8), i * 2);
                }
                (global as any).broadcastPcmToWeb(outBuf, userId);
            };

            const destroyDecoder = () => {
                if (!currentDecoder) return;
                currentDecoder.removeAllListeners();
                currentDecoder.destroy();
                currentDecoder = null;
                decoderCreatedAt = 0;
            };

            const createDecoder = () => {
                if (Date.now() < decoderDisabledUntil) return null;
                try {
                    const d = new prism.opus.Decoder(decoderConfig);
                    d.on('data', handlePcm);
                    d.on('error', (err) => {
                        console.warn("[recorder] Opus decoder error, cooling down:", err);
                        decoderDisabledUntil = Date.now() + decoderCooldownMs;
                        destroyDecoder();
                    });
                    decoderCreatedAt = Date.now();
                    return d;
                } catch (err) {
                    console.warn("[recorder] Opus decoder init failed, cooling down:", err);
                    decoderDisabledUntil = Date.now() + decoderCooldownMs;
                    return null;
                }
            };

            const rotateDecoderIfNeeded = () => {
                if (!currentDecoder || decoderRotateMs <= 0) return;
                if (Date.now() - decoderCreatedAt < decoderRotateMs) return;
                destroyDecoder();
                currentDecoder = createDecoder();
            };

            const ensureDecoder = () => {
                if (!currentDecoder) {
                    currentDecoder = createDecoder();
                }
                return currentDecoder;
            };

            // Feed Opus packets one-by-one
            let packetCount = 0;
            audioStream.on('data', (chunk: Buffer) => {
                packetCount++;
                if (packetCount <= 5) {
                    console.log(`[recorder] Pkt #${packetCount} from ${userId}: ${chunk.length}b | 0x${chunk.slice(0,4).toString('hex')}`);
                }
                if (chunk.length < 8) return; // skip tiny control/DTX packets
                rotateSegmentIfNeeded();
                if (!(global as any).broadcastPcmToWeb) return;
                rotateDecoderIfNeeded();
                const decoder = ensureDecoder();
                if (!decoder) return;
                try {
                    decoder.write(chunk);
                } catch (err) {
                    console.warn("[recorder] Opus decoder write failed, cooling down:", err);
                    decoderDisabledUntil = Date.now() + decoderCooldownMs;
                    destroyDecoder();
                }
            });

            audioStream.on('end', () => {
                closeSegment();
                destroyDecoder();
                if ((global as any).updateActiveUser) {
                    (global as any).updateActiveUser(userId, { username, avatar: avatarUrl, speaking: false });
                }
            });

            audioStream.on('error', (err) => {
                closeSegment();
                destroyDecoder();
                console.error(`[recorder] Audio Stream error ${userId}:`, err.message);
            });
            packetFilterForOgg.on('error', (err) => {
                closeSegment();
                console.error(`[recorder] PacketFilter(ogg) error ${userId}:`, err.message);
            });
        } catch (e) {
            console.error(`[recorder] Failed to create stream for ${userId}:`, e);
        }
    });

    // Handle disconnect yang tidak disengaja
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (config.verbose) {
            console.warn("[recorder] Disconnected from voice channel. Reconnecting...");
        }
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            // Berhasil reconnect
        } catch {
            console.error("[recorder] Could not reconnect. Destroying connection.");
            connection.destroy();
        }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
        if (config.verbose) {
            console.log("[recorder] Voice connection destroyed.");
        }
    });
}

/**
 * Hentikan recording dan disconnect dari voice channel.
 */
export function stopRecording(guildId: string): void {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        connection.destroy();
        if (config.verbose) {
            console.log("[recorder] Recording stopped and disconnected.");
        }
    } else {
        console.warn("[recorder] No active connection to stop.");
    }
}
