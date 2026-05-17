import { Encoders, prepareStream } from "@dank074/discord-video-stream";
import { demux } from "@dank074/discord-video-stream/dist/media/LibavDemuxer.js";

async function run() {
  console.log("Starting prepareStream...");
  const { command, output } = prepareStream(
    "https://samplelib.com/preview/mp4/sample-5s.mp4",
    {
      encoder: Encoders.software(),
      width: 1280,
      height: 720,
      includeAudio: true,
      minimizeLatency: false, // Add this
    },
  );

  try {
    const { video, audio } = await demux(output, { format: "nut" });
    console.log("DEMUX VIDEO:", !!video);
    console.log("DEMUX AUDIO:", !!audio);
  } catch (e) {
    console.error("DEMUX ERR:", e);
  }

  setTimeout(() => {
    try {
      command.kill("SIGKILL");
    } catch (e) {}
    process.exit(0);
  }, 10000);
}
run();
