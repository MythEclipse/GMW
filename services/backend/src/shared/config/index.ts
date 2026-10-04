/**
 * Unified configuration schema shared by all services.
 *
 * This is the single source of truth for all environment variables.
 * Individual services re-export from here; they do NOT define their own schemas.
 */

import { z } from "zod";
import { ConfigError } from "../errors/index.js";

export const configSchema = z
  .object({
    // ── Discord ──────────────────────────────────────────────────────────
    MONITOR_GUILD_ID: z.string().min(1).optional(),
    EXCLUDED_THREAD_IDS: z
      .string()
      .default("")
      .transform((v) => v.split(",").filter(Boolean))
      .describe("Thread IDs to exclude from capture"),

    // ── Server ───────────────────────────────────────────────────────────
    WEBSERVER_PORT: z.coerce.number().positive().default(3001),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["error", "warn", "info", "http", "verbose", "debug", "silly"])
      .default("info"),

    // ── Database (PostgreSQL) ────────────────────────────────────────────
    DATABASE_URL: z.string().optional(),
    POSTGRES_HOST: z.string().default("localhost"),
    POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
    POSTGRES_USER: z.string().optional(),
    POSTGRES_PASSWORD: z.string().optional(),
    POSTGRES_DB: z.string().optional(),
    POSTGRES_POOL_MIN: z.coerce.number().int().positive().default(2),
    POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(10),

    // ── Redis ────────────────────────────────────────────────────────────
    REDIS_URL: z.string().default("redis://localhost:6379"),

    // ── Attachments ─────────────────────────────────────────────────────
    BACKLOG_SYNC_HOURS: z.coerce.number().positive().default(24),
    BACKLOG_SYNC_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .max(100)
      .default(100),

    // ── AI Analysis ─────────────────────────────────────────────────────
    AI_LLM_API_KEY: z.string().optional(),
    // 9router — OpenAI-compatible router on this host (127.0.0.1:4014).
    // Loopback on purpose: backend runs on the same machine as 9router, so no
    // TLS/proxy hop is needed.
    AI_LLM_BASE_URL: z.string().url().default("http://127.0.0.1:4014/v1"),
    AI_LLM_MODEL: z.string().default("text"),

    // ── Retention ───────────────────────────────────────────────────────
    RETENTION_MESSAGES_DAYS: z.coerce.number().int().min(0).default(0),
    RETENTION_ATTACHMENTS_DAYS: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((value, ctx) => {
    if (!value.DATABASE_URL && !value.POSTGRES_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "Either DATABASE_URL or POSTGRES_HOST must be provided",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return configSchema.parse(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new ConfigError(`Configuration validation failed:\n${messages}`);
    }
    throw error;
  }
}

/** Singleton config loaded from process.env at import time. */
export const config = loadConfig();
