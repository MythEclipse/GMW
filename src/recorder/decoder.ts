import prism from "prism-media";

export interface OpusDecoderOptions {
  cooldownMs: number;
  rotateMs: number;
  createDecoder?: () => prism.opus.Decoder;
  onData: (pcm: Buffer) => void;
}

export class OpusDecoder {
  private decoder: prism.opus.Decoder | null = null;
  private disabledUntil = 0;
  private createdAt = 0;
  private readonly cooldownMs: number;
  private readonly rotateMs: number;
  private readonly createDecoderFn: () => prism.opus.Decoder;
  private readonly onData: (pcm: Buffer) => void;

  constructor(options: OpusDecoderOptions) {
    this.cooldownMs = options.cooldownMs;
    this.rotateMs = options.rotateMs;
    this.onData = options.onData;
    this.createDecoderFn =
      options.createDecoder ??
      (() =>
        new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }));
  }

  rotateIfNeeded(): void {
    if (!this.decoder || this.rotateMs <= 0) return;
    if (Date.now() - this.createdAt < this.rotateMs) return;
    this.destroy();
    this.ensureDecoder();
  }

  write(chunk: Buffer): void {
    const decoder = this.ensureDecoder();
    if (!decoder) return;
    try {
      decoder.write(chunk);
    } catch (error) {
      console.warn(
        "[recorder] Opus decoder write failed, cooling down:",
        error,
      );
      this.coolDown();
    }
  }

  destroy(): void {
    if (!this.decoder) return;
    this.decoder.removeAllListeners();
    this.decoder.destroy();
    this.decoder = null;
    this.createdAt = 0;
  }

  private ensureDecoder(): prism.opus.Decoder | null {
    if (this.decoder) return this.decoder;
    if (Date.now() < this.disabledUntil) return null;
    try {
      const decoder = this.createDecoderFn();
      decoder.on("data", this.onData);
      decoder.on("error", (error) => {
        console.warn("[recorder] Opus decoder error, cooling down:", error);
        this.coolDown();
      });
      this.decoder = decoder;
      this.createdAt = Date.now();
      return decoder;
    } catch (error) {
      console.warn("[recorder] Opus decoder init failed, cooling down:", error);
      this.disabledUntil = Date.now() + this.cooldownMs;
      return null;
    }
  }

  private coolDown(): void {
    this.disabledUntil = Date.now() + this.cooldownMs;
    this.destroy();
  }
}
