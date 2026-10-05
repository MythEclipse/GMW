import pino from "pino";

/**
 * Log verbosity, read straight from the environment.
 *
 * Deliberately NOT part of the Zod config schema: the logger is what reports
 * a bad config, so it cannot depend on the config module loading successfully.
 * A validation error thrown at import time would otherwise be invisible.
 */
export const DEBUG_VERBOSE = process.env.VERBOSE === "true";

const rootLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
} as pino.LoggerOptions);

export type Logger = ReturnType<typeof createChildLogger>;

/**
 * Alias kept for the capture modules, which read better with this name.
 */
export type CustomLogger = Logger;

/**
 * Returns a child logger bound to the root singleton via pino's .child().
 * Preserves parent context and is efficient (no transport re-init per call).
 */
export function createChildLogger(context: string) {
  return rootLogger.child({ context });
}
