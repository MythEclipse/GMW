import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors";
import type { ResolvedMediaSource } from "./mediaTypes";

export async function resolveMediaSource(
  input: string,
): Promise<ResolvedMediaSource> {
  const source = input.trim();
  if (!source) {
    throw new AppError("Media source is required", "MISSING_MEDIA_SOURCE", 400);
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return {
      source,
      title: titleFromUrl(source),
      kind: "url",
    };
  }

  if (existsSync(source) && statSync(source).isFile()) {
    return {
      source,
      title: path.basename(source),
      kind: "local",
    };
  }

  throw new AppError(
    "Media source must be an HTTP(S) URL or existing local file",
    "UNSUPPORTED_MEDIA_SOURCE",
    400,
  );
}

function titleFromUrl(source: string): string {
  const url = new URL(source);
  const filename = decodeURIComponent(url.pathname.split("/").pop() || "");
  return filename || url.hostname;
}