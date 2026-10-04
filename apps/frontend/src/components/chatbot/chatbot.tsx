"use client";

import { cn } from "cn";
import { Bot, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/shared/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { useChatbotUserId } from "@/hooks/use-chatbot-user";
import { useIsMobile } from "@/hooks/use-mobile";
import { browserApi } from "@/lib/api/browser";
import type { ChatbotTurn } from "@/lib/types";

interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
}

/**
 * Floating moderator assistant.
 *
 * The backend exposes a tool-calling chatbot over oRPC (search messages, read
 * a user profile, read channel culture, get server stats). Each turn is stored
 * server-side against a per-browser actor id, so history survives a reload.
 *
 * MOBILE NOTE: the launcher is `bottom-safe-launcher`, which lifts it above the
 * mobile dock. The previous version sat at `bottom-5` with a higher z-index and
 * physically covered the right-hand dock items, making them untappable.
 */
export function Chatbot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const userId = useChatbotUserId();
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = useAction(async (text: string) => {
    const response = (await browserApi.chatbot.chat({
      message: text,
      userId: userId ?? undefined,
    })) as { response: string; timestamp: string };

    return response.response;
  });

  // Load history when the panel is first opened, not on mount: most visitors
  // never open it and the request is wasted for them.
  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = (await browserApi.chatbot.history({
          limit: 50,
          userId,
        })) as { history: ChatbotTurn[] };
        if (cancelled) return;
        setMessages(
          result.history.map((turn) => ({
            id: turn.id,
            role: turn.user_id === userId ? "user" : "bot",
            text:
              turn.user_id === userId ? turn.user_message : turn.bot_response,
          })),
        );
      } catch {
        // A failed history load is not worth interrupting the user over; they
        // can still chat, they just start with an empty panel.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  // Keep the transcript pinned to the newest message.
  //
  // `scrollRef.current` is a DOM node the exhaustive-deps rule cannot see a
  // dependency in, so "something was appended" is tracked as explicit state
  // rather than satisfying the rule with an empty array — which would compile
  // and then silently never scroll again.
  //
  // No `open` in the deps on purpose: when the panel opens with no messages,
  // history loads a moment later and THAT is what sets the id and scrolls. When
  // it reopens with messages already loaded, the scroll position is already at
  // the bottom, so there is nothing to do.
  const [lastMessageId, setLastMessageId] = useState<string | null>(null);

  useEffect(() => {
    setLastMessageId(messages.at(-1)?.id ?? null);
  }, [messages]);

  useEffect(() => {
    if (lastMessageId === null) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lastMessageId]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || send.isPending) return;

    const userMessage: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      text,
    };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");

    const answer = await send.run(text);
    if (answer) {
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}-a`, role: "bot", text: answer },
      ]);
    }
  }, [draft, send]);

  const clear = useCallback(async () => {
    if (!userId) return;
    try {
      await browserApi.chatbot.clearHistory({ userId });
    } finally {
      setMessages([]);
    }
  }, [userId]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open moderation assistant"
        className={cn(
          "glass bottom-safe-launcher fixed right-4 z-40 flex size-11",
          "items-center justify-center rounded-full shadow-lg",
          "transition-transform hover:scale-105",
          "focus-visible:outline-2 focus-visible:outline-offset-2",
          "focus-visible:outline-signal",
        )}
      >
        <Bot className="size-4" aria-hidden />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "glass fixed right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl",
        "bottom-safe-launcher max-h-[min(32rem,70dvh)]",
      )}
      role="dialog"
      aria-label="Moderation assistant"
    >
      <header className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <Bot className="size-4 text-signal" aria-hidden />
        <span className="text-sm font-medium text-ink">Assistant</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={clear}
            aria-label="Clear conversation"
            disabled={messages.length === 0}
          >
            <Trash2 aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setOpen(false)}
            aria-label="Close assistant"
          >
            <X aria-hidden />
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <p className="py-6 text-center text-xs text-ink-muted">
            Ask about a user, a channel, or what has been flagged recently.
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "rounded-lg border px-3 py-2",
              message.role === "user"
                ? "ml-8 border-hairline bg-surface-2"
                : "mr-4 border-hairline bg-surface",
            )}
          >
            {message.role === "bot" ? (
              <Markdown compact>{message.text}</Markdown>
            ) : (
              <p className="text-sm break-words text-ink-soft">
                {message.text}
              </p>
            )}
          </div>
        ))}

        {send.isPending && <p className="text-xs text-ink-faint">Thinking…</p>}

        {send.error && (
          <p className="rounded-md border border-vermilion/30 bg-vermilion/10 px-2 py-1.5 text-xs text-vermilion">
            {send.error.message}
          </p>
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-hairline px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isMobile) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask about moderation…"
          rows={1}
          aria-label="Message"
          className="min-h-9 resize-none"
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={send.isPending || draft.trim().length === 0}
          aria-label="Send"
        >
          <Send aria-hidden />
        </Button>
      </form>
    </div>
  );
}
