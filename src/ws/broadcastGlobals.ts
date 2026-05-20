import type { createChildLogger } from "../logger";
import type {
  BroadcasterClient,
  ModerationBroadcaster,
} from "../moderation/types";

type Logger = ReturnType<typeof createChildLogger>;

type ActiveUsers = Map<
  string,
  { username: string; avatar: string; speaking: boolean }
>;

type VoiceGlobals = typeof globalThis & {
  ADMIN_PASSWORD?: string;
  moderationBroadcaster?: ModerationBroadcaster;
  broadcastPcmToWeb?: (chunk: Buffer, userId: string) => void;
  broadcastVideoToWeb?: (chunk: Buffer) => void;
  updateActiveUser?: (
    userId: string,
    data: { username: string; avatar: string; speaking: boolean },
  ) => void;
};

export function getModerationBroadcaster(): ModerationBroadcaster | undefined {
  return (globalThis as VoiceGlobals).moderationBroadcaster;
}

export function exposeModerationGlobals(
  broadcaster: ModerationBroadcaster,
  adminPassword: string,
): void {
  (globalThis as VoiceGlobals).moderationBroadcaster = broadcaster;
  (globalThis as VoiceGlobals).ADMIN_PASSWORD = adminPassword;
}

export function exposePcmBroadcastGlobal(
  broadcaster: ModerationBroadcaster,
): void {
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
}

export function exposeVideoBroadcastGlobal(
  clients: () => BroadcasterClient[],
  logger: Logger,
): void {
  (globalThis as VoiceGlobals).broadcastVideoToWeb = (chunk: Buffer) => {
    for (const client of clients()) {
      if (client.readyState === 1) {
        try {
          client.send(chunk);
        } catch (err) {
          logger.warn({ err }, "Failed to send video chunk");
        }
      }
    }
  };
}

export function exposeActiveUserGlobal(
  activeUsers: ActiveUsers,
  broadcastUserState: () => void,
): void {
  (globalThis as VoiceGlobals).updateActiveUser = (
    userId: string,
    data: { username: string; avatar: string; speaking: boolean },
  ) => {
    activeUsers.set(userId, data);
    broadcastUserState();
  };
}
