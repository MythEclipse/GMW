import type { ChildProcess } from "node:child_process";
import dotenv from "dotenv";
import { createYtDlp } from "./src/media/ytdlp.js";
import { prepareStream } from "./src/streaming/index.js";

dotenv.config();

async function test() {
  const ytdlp = createYtDlp();
  const url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // Small video

  console.log("Getting direct video url...");
  const directUrl = await ytdlp.getDirectVideoUrl(url);
  console.log("Direct URL:", directUrl);

  console.log("Preparing stream...");
  const { command, output } = prepareStream(directUrl, {
    logLevel: "debug",
    customInputOptions: [
      "-headers",
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.3\r\nConnection: keep-alive\r\n",
    ],
  });

  const ffmpeg = command as ChildProcess;
  ffmpeg.stderr?.on("data", (data: Buffer) => {
    console.log("FFMPEG STDERR:", data.toString());
  });

  let bytesRead = 0;
  output.on("data", (chunk: Buffer) => {
    bytesRead += chunk.length;
    console.log("Stream bytes:", bytesRead);
    if (bytesRead > 1024 * 1024) {
      ffmpeg.kill("SIGTERM");
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg.on("exit", (code) => {
        if (code === 0 || code === null) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ffmpeg.on("error", reject);
    });
  } catch (error: unknown) {
    console.error(
      "Debug stream failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  process.exit(0);
}

test();
