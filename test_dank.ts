import { Encoders, prepareStream } from "@dank074/discord-video-stream";
import fs from "fs";

async function run() {
  console.log("Starting prepareStream...");
  const { command, output } = prepareStream(
    "https://rr3---sn-2uuxa3vh-unte.googlevideo.com/videoplayback?expire=1779046518&ei=FsQJatGDGNqp9fwP4qz4SA&ip=180.252.24.35&id=o-APFvGry6yPgoap-1RT0pu59DxD-pcXC4oXtMQuCMtjOy&itag=18&source=youtube&requiressl=yes&xpc=EgVo2aDSNQ%3D%3D&cps=618&met=1779024918%2C&mh=VD&mm=31%2C29&mn=sn-2uuxa3vh-unte%2Csn-oguelnze&ms=au%2Crdu&mv=m&mvi=3&pcm2cms=yes&pl=20&rms=au%2Cau&initcwndbps=763750&bui=AbKmrwofOLw_tOID4kBHnWgaXP2wnDlEYmbyHyrnZk1n7vjMaQIuY046T9MhH0PuL9JGJwj6YlwCr2Uu&spc=96Xrv8WI7iTS7MOF7Dvg-8a3RT-sMI9ux49zUa4Pg6GHkzXExSS0&vprv=1&svpuc=1&mime=video%2Fmp4&rqh=1&cnr=14&ratebypass=yes&dur=19.063&lmt=1772437158054287&mt=1779024581&fvip=4&fexp=51565116%2C51565681&c=ANDROID_VR&txp=4530534&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Cxpc%2Cbui%2Cspc%2Cvprv%2Csvpuc%2Cmime%2Crqh%2Ccnr%2Cratebypass%2Cdur%2Clmt&sig=AHEqNM4wRgIhAJe1vu37ssUQQm3scVgXY7NYDx_frKW1AZ4gHRdcqsUlAiEAkKt6jxaCNvaEh6jag1OWheo5qQeu3ObfCCoQIZ9xnCA%3D&lsparams=cps%2Cmet%2Cmh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpcm2cms%2Cpl%2Crms%2Cinitcwndbps&lsig=APaTxxMwRQIhAMkeJ6WrDFU7fTfSb6s_WbdDpn4J-4NqkfzKV3B_y1cgAiBJ7aExkhh-0hvIWwNorjDwoOkTIKIfmzx6o6Z3mxlazA%3D%3D",
    {
      encoder: Encoders.software(),
      width: 1280,
      height: 720,
      includeAudio: true,
      minimizeLatency: false, // Add this
    },
  );

  const fileStream = fs.createWriteStream("/mnt/code/bete/test_out.nut");
  output.pipe(fileStream);

  command.on("error", (err, stdout, stderr) => {
    console.error("FFMPEG ERROR:", err.message);
  });
  command.on("stderr", (stderrLine) => {
    console.log("FFMPEG LOG:", stderrLine);
  });
  command.on("end", () => {
    console.log("FFMPEG FINISHED");
    process.exit(0);
  });

  setTimeout(() => {
    try {
      command.kill("SIGKILL");
    } catch (e) {}
    process.exit(0);
  }, 10000);
}
run();
