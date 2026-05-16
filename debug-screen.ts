import { Client } from "discord.js-selfbot-v13";
import dotenv from "dotenv";
import { createYtDlp } from "./src/media/ytdlp.js";
import { Streamer } from "./vendor/Discord-video-stream/dist/client/index.js";
import {
  playStream,
  prepareStream,
} from "./vendor/Discord-video-stream/dist/media/newApi.js";

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

  command.on("stderr", (data) => {
    console.log("FFMPEG STDERR:", data);
  });

  console.log("Testing demux manually...");
  const { demux } = await import(
    "./vendor/Discord-video-stream/dist/media/LibavDemuxer.js"
  );
  try {
    const demuxPromise = demux(output, { format: "nut" });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Demux timeout")), 15000),
    );

    const { video, audio } = (await Promise.race([
      demuxPromise,
      timeoutPromise,
    ])) as any;
    console.log("Demux success!");
    console.log("Video stream:", !!video);
    console.log("Audio stream:", !!audio);
  } catch (err) {
    console.error("Demux failed:", err.message);
  }

  process.exit(0);
}

test();
