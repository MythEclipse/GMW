import fs from "node:fs";
import path from "node:path";
import winston from "winston";

const isDev = process.env.NODE_ENV !== "production";
const logLevel = process.env.LOG_LEVEL || (isDev ? "debug" : "info");
const logsDir = path.resolve(process.cwd(), "logs");

fs.mkdirSync(logsDir, { recursive: true });

type LogMetadata = Record<string, unknown>;

type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: unknown;
  statusCode?: unknown;
} & Record<string, unknown>;

const serializeError = (error: Error): SerializedError => {
  const serialized: SerializedError = {
    name: error.name,
    message: error.message,
  };

  if (error.stack) {
    serialized.stack = error.stack;
  }

  const errorWithFields = error as Error & {
    code?: unknown;
    statusCode?: unknown;
    [key: string]: unknown;
  };

  if (errorWithFields.code !== undefined) {
    serialized.code = errorWithFields.code;
  }

  if (errorWithFields.statusCode !== undefined) {
    serialized.statusCode = errorWithFields.statusCode;
  }

  for (const [key, value] of Object.entries(errorWithFields)) {
    if (serialized[key] === undefined) {
      serialized[key] = value;
    }
  }

  return serialized;
};

const serializeLogValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map(serializeLogValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        serializeLogValue(nestedValue),
      ]),
    );
  }

  return value;
};

const formatLogMetadata = (metadata: LogMetadata): LogMetadata => {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, serializeLogValue(value)]),
  );
};

const metadataFormat = winston.format((info) => {
  const { level, message, timestamp, ...metadata } = info;
  return {
    level,
    message,
    timestamp,
    ...formatLogMetadata(metadata),
  };
});

const consoleFormat = winston.format.printf((info) => {
  const { level, message, timestamp, context, ...metadata } = info;
  const contextLabel = context ? ` [${String(context)}]` : "";
  const metadataText = Object.keys(metadata).length
    ? ` ${JSON.stringify(metadata)}`
    : "";

  return `${timestamp} ${level}${contextLabel}: ${message}${metadataText}`;
});

export interface CustomLogger {
  error: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  warn: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  info: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  debug: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  trace: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  fatal: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  silent: (msgOrObj: any, msgOrArgs?: any, ...args: any[]) => void;
  child(options: { context: string } & Record<string, any>): CustomLogger;
  [key: string]: any;
}

const winstonLogger = winston.createLogger({
  level: logLevel,
  levels: winston.config.npm.levels,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    metadataFormat(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        metadataFormat(),
        consoleFormat,
      ),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "app.log"),
      format: winston.format.json(),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      format: winston.format.json(),
    }),
  ],
});

function wrapLogger(wLogger: winston.Logger): CustomLogger {
  const logAtLevel = (level: string) => {
    return (arg1: any, arg2?: any) => {
      if (typeof arg1 === "object" && arg1 !== null) {
        // arg1 is object, arg2 is message string
        const msg = typeof arg2 === "string" ? arg2 : "";
        wLogger.log(level, msg, { ...arg1 });
      } else {
        // arg1 is message string, arg2 is metadata (or nothing)
        const msg = typeof arg1 === "string" ? arg1 : String(arg1);
        const meta = typeof arg2 === "object" && arg2 !== null ? arg2 : {};
        wLogger.log(level, msg, meta);
      }
    };
  };

  const wrapped: CustomLogger = {
    error: logAtLevel("error"),
    warn: logAtLevel("warn"),
    info: logAtLevel("info"),
    debug: logAtLevel("debug"),
    trace: logAtLevel("debug"), // Map trace to debug in Winston npm levels
    fatal: logAtLevel("error"), // Map fatal to error in Winston npm levels
    silent: () => {},
    child: (options: any) => {
      const childWinston = wLogger.child(options);
      return wrapLogger(childWinston);
    }
  };

  // Add all winston.Logger properties/methods to custom logger to make typescript happy for standard properties
  const proxy = new Proxy(wrapped, {
    get(target, prop) {
      if (prop in target) {
        return (target as any)[prop];
      }
      const val = (wLogger as any)[prop];
      if (typeof val === "function") {
        return val.bind(wLogger);
      }
      return val;
    }
  });

  return proxy;
}

export const logger: CustomLogger = wrapLogger(winstonLogger);

export const createChildLogger = (context: string): CustomLogger => {
  return logger.child({ context });
};

export const serializeLogValueForTest = serializeLogValue;
export const formatLogMetadataForTest = formatLogMetadata;
