import { useEffect, useRef, useState } from "react";
import type { MessageRecord } from "../types/messages";
import type { MediaState } from "../types/media";
import type { UIState } from "../types/ui";
import type { ActiveSpeaker } from "../types/voice";

export type WebSocketStatus = "connecting" | "connected" | "disconnected" | "error";

export interface DashboardSocketHandlers {
  onUIState?: (state: UIState) => void;
  onUserState?: (users: ActiveSpeaker[]) => void;
  onMessageCreated?: (message: MessageRecord) => void;
  onMessageUpdated?: (message: Partial<MessageRecord> & { id: string }) => void;
  onMessageDeleted?: (message: { id: string }) => void;
  onMessageAnalyzed?: (message: MessageRecord) => void;
  onAttachmentUploaded?: () => void;
  onMediaState?: (state: MediaState) => void;
  onVoiceRecordingUploaded?: (recording: any) => void;
  onPcm?: (data: ArrayBuffer) => void;
  onAnalyticsRefresh?: () => void;
}

export function useDashboardSocket(handlers: DashboardSocketHandlers) {
  const [status, setStatus] = useState<WebSocketStatus>("connecting");
  const handlersRef = useRef(handlers);
  const socketRef = useRef<WebSocket | null>(null);

  handlersRef.current = handlers;

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      setStatus("connecting");

      socket.addEventListener("open", () => setStatus("connected"));
      socket.addEventListener("error", () => setStatus("error"));
      socket.addEventListener("close", () => {
        setStatus("disconnected");
        if (!closed) reconnectTimer = window.setTimeout(connect, 2500);
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          handlersRef.current.onPcm?.(event.data);
          return;
        }
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data);
          switch (message.type) {
            case "ui_state":
              handlersRef.current.onUIState?.(message.state);
              break;
            case "user_state":
              handlersRef.current.onUserState?.(message.users || []);
              break;
            case "message_created":
              handlersRef.current.onMessageCreated?.(message.data);
              break;
            case "message_updated":
              handlersRef.current.onMessageUpdated?.(message.data);
              break;
            case "message_deleted":
              handlersRef.current.onMessageDeleted?.(message.data);
              break;
            case "message_analyzed":
              handlersRef.current.onMessageAnalyzed?.(message.data);
              break;
            case "attachment_uploaded":
              handlersRef.current.onAttachmentUploaded?.();
              break;
            case "media_state":
              handlersRef.current.onMediaState?.(message.state);
              break;
            case "voice_recording_uploaded":
              handlersRef.current.onVoiceRecordingUploaded?.(message.data);
              break;
          }
        } catch {
          // ignore malformed socket messages
        }
      });
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  return { status, socketRef };
}
