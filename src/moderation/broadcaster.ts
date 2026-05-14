import type { WebSocket } from "ws";
import type {
  AnalysisQueueStatus,
  AttachmentRecord,
  MessageRecord,
  ModerationWsEvent,
} from "./types";

type ClientLike = Pick<WebSocket, "readyState" | "send">;

function sendJson(clients: Set<ClientLike>, event: ModerationWsEvent): void {
  const payload = JSON.stringify({ ...event, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

export function createBroadcaster() {
  const clients = new Set<ClientLike>();

  return {
    addClient(client: ClientLike) {
      clients.add(client);
    },
    removeClient(client: ClientLike) {
      clients.delete(client);
    },
    clientCount() {
      return clients.size;
    },
    uiState(state: unknown) {
      sendJson(clients, { type: "ui_state", state });
    },
    userState(users: unknown[]) {
      sendJson(clients, { type: "user_state", users });
    },
    messageCreated(data: MessageRecord) {
      sendJson(clients, { type: "message_created", data });
    },
    messageUpdated(data: Partial<MessageRecord> & { id: string }) {
      sendJson(clients, { type: "message_updated", data });
    },
    messageDeleted(data: { id: string; deleted_at: number }) {
      sendJson(clients, { type: "message_deleted", data });
    },
    messageAnalyzed(data: MessageRecord) {
      sendJson(clients, { type: "message_analyzed", data });
    },
    attachmentCreated(data: AttachmentRecord) {
      sendJson(clients, { type: "attachment_created", data });
    },
    analysisQueueStatus(data: AnalysisQueueStatus) {
      sendJson(clients, { type: "analysis_queue_status", data });
    },
  };
}

export type ModerationBroadcaster = ReturnType<typeof createBroadcaster>;
