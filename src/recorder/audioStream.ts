import { EndBehaviorType, type VoiceReceiver } from "@discordjs/voice";

export interface AudioStreamHandlers {
  onPacket: (chunk: Buffer) => void;
  onEnd: () => void;
  onError: (error: Error) => void;
}

export function subscribeToAudioStream(
  receiver: VoiceReceiver,
  userId: string,
  handlers: AudioStreamHandlers,
): NodeJS.ReadableStream {
  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 3000,
    },
  });

  audioStream.on("data", handlers.onPacket);
  audioStream.on("end", handlers.onEnd);
  audioStream.on("error", handlers.onError);

  return audioStream;
}
