import type { WebSocket } from "ws";
import { createChildLogger } from "../logger";
import type {
  AnalysisQueueStatus,
  AttachmentRecord,
  MessageRecord,
  ModerationWsEvent,
} from "./types";

type ClientLike = Pick<WebSocket, "readyState" | "send">;

const log = createChildLogger("broadcaster");

function sendJson(clients: Set<ClientLike>, event: ModerationWsEvent): void {
  const payload = JSON.stringify({ ...event, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (error) {
        log.warn(
          { error, eventType: event.type },
          "Failed to send event to client",
        );
      }
    }
  }
}

export function createBroadcaster() {
  const clients = new Set<ClientLike>();

  return {
    addClient(client: ClientLike) {
      clients.add(client);
      log.debug({ clientCount: clients.size }, "Client added");
    },
    removeClient(client: ClientLike) {
      clients.delete(client);
      log.debug({ clientCount: clients.size }, "Client removed");
    },
    clientCount() {
      return clients.size;
    },
    getClients() {
      return Array.from(clients);
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
