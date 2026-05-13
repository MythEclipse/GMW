import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

const recordingsDir = process.env.RECORDINGS_DIR ?? "./recordings";

interface EventMetadata {
  userId: string;
  username: string;
  tag: string;
  displayName?: string;
  avatarUrl?: string;
  bot?: boolean;
  roles?: Array<{ id: string; name: string; position: number }>;
  highestRole?: { id: string; name: string; position: number } | null;
  joinedTimestamp?: number | null;
  sessionId?: string;
  sessionStartTime?: number;
  segmentIndex?: number;
  segmentMs?: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  filename: string;
}

interface ClipInfo {
  oggPath: string;
  jsonPath: string;
  meta: EventMetadata;
}

async function startMuxingToAup3() {
  console.log("[muxer-aup3] Scanning recordings directory...");
  if (!fs.existsSync(recordingsDir)) {
    console.error("[muxer-aup3] Recordings directory not found.");
    return;
  }

  const clips: ClipInfo[] = [];

  // Scan user directories
  const items = fs.readdirSync(recordingsDir);
  console.log(`[muxer-aup3] Found ${items.length} directories to scan...`);

  let processedDirs = 0;
  for (const item of items) {
    const itemPath = path.join(recordingsDir, item);
    if (fs.statSync(itemPath).isDirectory()) {
      const files = fs.readdirSync(itemPath);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const jsonPath = path.join(itemPath, file);
          const oggPath = jsonPath.replace(/\.json$/, ".ogg");
          if (fs.existsSync(oggPath)) {
            try {
              // Check if OGG file is valid (not empty and has reasonable size)
              const oggStats = fs.statSync(oggPath);
              if (oggStats.size === 0) {
                console.warn(
                  `[muxer-aup3] Skipping empty OGG file: ${oggPath}`,
                );
                continue;
              }

              // Skip files that are too small (less than 1KB likely corrupted)
              if (oggStats.size < 1024) {
                console.warn(
                  `[muxer-aup3] Skipping too small OGG file (${oggStats.size} bytes): ${oggPath}`,
                );
                continue;
              }

              // Check if OGG file has valid header (starts with "OggS")
              const oggBuffer = fs.readFileSync(oggPath);
              const oggHeader = oggBuffer.slice(0, 4).toString();
              if (oggHeader !== "OggS") {
                console.warn(
                  `[muxer-aup3] Skipping invalid OGG file (bad header): ${oggPath}`,
                );
                continue;
              }

              const meta: EventMetadata = JSON.parse(
                fs.readFileSync(jsonPath, "utf-8"),
              );
              clips.push({ oggPath, jsonPath, meta });
            } catch (e) {
              console.error(
                `[muxer-aup3] Failed to read/parse JSON: ${jsonPath}`,
                e,
              );
            }
          }
        }
      }
      processedDirs++;
      const progress = ((processedDirs / items.length) * 100).toFixed(2);
      console.log(
        `[muxer-aup3] Scanning progress: ${progress}% (${processedDirs}/${items.length} directories)`,
      );
    }
  }

  if (clips.length === 0) {
    console.log("[muxer-aup3] No recording clips found to mux.");
    return;
  }

  // Sort by startTime so chronologically they are in order
  clips.sort((a, b) => a.meta.startTime - b.meta.startTime);

  // Find the global start time
  const globalStartTime = clips[0].meta.startTime;
  console.log(
    `[muxer-aup3] Found ${clips.length} clips. Base timestamp: ${globalStartTime}`,
  );

  const command = ffmpeg();
  const filterParts: string[] = [];

  console.log(
    `[muxer-aup3] Creating audio filters for ${clips.length} clips...`,
  );
  clips.forEach((clip, index) => {
    command.input(clip.oggPath);

    // Calculate delay relative to the global start time
    const delayMs = clip.meta.startTime - globalStartTime;

    // FFmpeg filter structure: [0:a]adelay=1000|1000[a0]
    // Setting adelay multiple times covers stereo channels.
    // We ensure all multiple channels get delayed.
    const inputSpecifier = `[${index}:a]`;
    const outputSpecifier = `[pad${index}]`;

    filterParts.push(
      `${inputSpecifier}adelay=${delayMs}|${delayMs}${outputSpecifier}`,
    );

    const progress = (((index + 1) / clips.length) * 100).toFixed(2);
    console.log(
      `[muxer-aup3] Filter creation progress: ${progress}% (${index + 1}/${clips.length} clips)`,
    );
  });

  // Merge them using amix
  const amixInputs = clips.map((_, i) => `[pad${i}]`).join("");
  // We add the amix command. dropout_transition=0 avoids volume drop when streams end.
  filterParts.push(
    `${amixInputs}amix=inputs=${clips.length}:dropout_transition=0[out]`,
  );

  const timestamp = Date.now();
  const wavFilename = path.join(recordingsDir, `muxed-${timestamp}.wav`);
  const aup3Filename = path.join(recordingsDir, `muxed-${timestamp}.aup3`);

  console.log(
    `[muxer-aup3] Combining clips to WAV. This might take a while...`,
  );

  // Using fluent-ffmpeg's complexFilter
  command
    .complexFilter(filterParts, "out")
    .audioCodec("pcm_s16le")
    .audioFrequency(44100)
    .audioChannels(2)
    .save(wavFilename)
    .on("progress", (progress) => {
      if (progress.percent) {
        console.log(
          `[muxer-aup3] WAV Progress: ${progress.percent.toFixed(2)}%`,
        );
      }
    })
    .on("end", () => {
      console.log(`[muxer-aup3] WAV file created: ${wavFilename}`);
      console.log(`[muxer-aup3] Creating AUP3 project file...`);
      createAup3Project(wavFilename, aup3Filename, clips, globalStartTime);
    })
    .on("error", (err) => {
      console.error(`[muxer-aup3] FFmpeg Error:`, err);
    });
}

function createAup3Project(
  wavFilename: string,
  aup3Filename: string,
  clips: ClipInfo[],
  globalStartTime: number,
) {
  try {
    console.log(`[muxer-aup3] AUP3 Progress: Reading WAV file...`);

    // Read WAV file to get duration
    const wavStats = fs.statSync(wavFilename);
    const wavSize = wavStats.size;

    // Calculate approximate duration (assuming 44.1kHz, 16-bit, stereo)
    // Duration = (file_size - 44) / (44100 * 2 * 2) for WAV
    const duration = (wavSize - 44) / (44100 * 4);

    console.log(
      `[muxer-aup3] AUP3 Progress: Calculating duration... ${duration.toFixed(2)}s`,
    );
    console.log(`[muxer-aup3] AUP3 Progress: Creating XML structure...`);

    // Create AUP3 project XML structure
    const aup3Content = `<?xml version="1.0" encoding="UTF-8"?>
<audacityproject xmlns="http://audacity.sourceforge.net/xml/" projname="muxed" version="1.3.0" audacityversion="3.5.1">
  <tags>
    <tag name="GENRE" value=""/>
    <tag name="ARTIST" value=""/>
    <tag name="ALBUM" value=""/>
    <tag name="TRACKNUMBER" value=""/>
    <tag name="YEAR" value=""/>
    <tag name="TITLE" value="Muxed Recording"/>
  </tags>
  <wavetrack name="Muxed Audio" channel="2" linked="0" mute="0" solo="0" height="150" minimized="0" isSelected="0" rate="44100">
    <waveclip offset="0.0">
      <sequence maxsamples="262144" sampleformat="262159" numsamples="${Math.floor(duration * 44100)}">
        <waveblock start="0">
          <simpleblockfile filename="${path.basename(wavFilename)}" len="${Math.floor(duration * 44100)}" min="-1.0" max="1.0" rms="0.1"/>
        </waveblock>
      </sequence>
      <envelope numpoints="0"/>
    </waveclip>
  </wavetrack>
  <timetrack name="Time Track" height="150" minimized="0" isSelected="0">
    <envelope numpoints="0"/>
  </timetrack>
</audacityproject>`;

    console.log(`[muxer-aup3] AUP3 Progress: Writing AUP3 file...`);

    // Write AUP3 file
    fs.writeFileSync(aup3Filename, aup3Content, "utf-8");

    console.log(`[muxer-aup3] AUP3 Progress: Creating clip info file...`);

    // Create a simple info file with clip details
    const infoFilename = aup3Filename.replace(".aup3", "-info.txt");
    const infoContent = clips
      .map((clip, index) => {
        const delayMs = clip.meta.startTime - globalStartTime;
        return `Clip ${index + 1}:
  User: ${clip.meta.username} (${clip.meta.userId})
  Tag: ${clip.meta.tag}
  Start Time: ${new Date(clip.meta.startTime).toISOString()}
  Delay: ${delayMs}ms
  Duration: ${clip.meta.durationMs}ms
  File: ${path.basename(clip.oggPath)}`;
      })
      .join("\n\n");

    fs.writeFileSync(infoFilename, infoContent, "utf-8");

    console.log(`[muxer-aup3] AUP3 Progress: 100% - Complete!`);
    console.log(`[muxer-aup3] Successfully created AUP3 project!`);
    console.log(`[muxer-aup3] WAV file: ${wavFilename}`);
    console.log(`[muxer-aup3] AUP3 file: ${aup3Filename}`);
    console.log(`[muxer-aup3] Clip info saved to: ${infoFilename}`);
    console.log(`[muxer-aup3] Total clips processed: ${clips.length}`);
    console.log(`[muxer-aup3] Duration: ${duration.toFixed(2)} seconds`);
  } catch (error) {
    console.error(`[muxer-aup3] Error creating AUP3 project:`, error);
  }
}

startMuxingToAup3();
