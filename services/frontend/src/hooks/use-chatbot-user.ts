"use client";

import { useEffect, useState } from "react";

/**
 * A stable per-browser id for the chatbot.
 *
 * The backend keys `chatbot_history` by an actor id and falls back to the
 * literal "anonymous" when none is given — which would pool every visitor's
 * conversations into one shared history. A random id in localStorage keeps
 * them separate. It is generated on the client only, so it is never part of a
 * server render and never causes a hydration mismatch.
 */
const STORAGE_KEY = "gmw:chatbot-user";

function generate(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `anon-${Math.random().toString(36).slice(2, 12)}`;
}

export function useChatbotUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) {
        setUserId(existing);
        return;
      }
      const created = generate();
      window.localStorage.setItem(STORAGE_KEY, created);
      setUserId(created);
    } catch {
      // Private mode or blocked storage: fall back to a session-scoped id so
      // the chatbot still works, it just will not remember across reloads.
      setUserId(generate());
    }
  }, []);

  return userId;
}
