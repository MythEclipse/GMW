import { Readable } from "node:stream";
import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnection,
} from "@discordjs/voice";

export class DiscordPlayer {
  private player: AudioPlayer;
  private connection: VoiceConnection | null = null;

  constructor() {
    this.player = createAudioPlayer();

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log("[player] Audio player is now playing!");
    });

    this.player.on("error", (error) => {
      console.error(`[player] Error: ${error.message}`);
    });
  }

  public setConnection(connection: VoiceConnection) {
    this.connection = connection;
    this.connection.subscribe(this.player);
  }

  public isConnected(): boolean {
    return this.connection !== null;
  }

  public playStream(stream: Readable) {
    console.log("[player] Starting new audio stream...");

    const resource = createAudioResource(stream, {
      inputType: StreamType.OggOpus,
    });

    this.player.play(resource);
  }

  public pause() {
    this.player.pause(true);
  }

  public unpause() {
    this.player.unpause();
  }

  public stop() {
    this.player.stop();
  }
}

export const discordPlayer = new DiscordPlayer();
