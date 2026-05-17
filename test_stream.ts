import { prepareStream } from "@dank074/discord-video-stream";
import { Encoders } from "@dank074/discord-video-stream/dist/media/encoders/index.js";
import { demux } from "@dank074/discord-video-stream/dist/media/LibavDemuxer.js";

async function run() {
  const { command, output } = prepareStream(
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    {
      encoder: Encoders.software(),
      width: 1280,
      height: 720,
      includeAudio: true,
    },
  );

  const { video, audio } = await demux(output, { format: "nut" });
  console.log("Video found:", !!video);
  console.log("Audio found:", !!audio);
  process.exit(0);
}
run();
