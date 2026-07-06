import { GIFEncoder, applyPalette, quantize } from "gifenc";

type RecorderMode = "screen" | "element";
type RecordingFormat = "webm" | "mp4" | "gif";
type ScreenshotFormat = "png" | "jpeg" | "webp";

type CropRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ViewportSize = {
  width: number;
  height: number;
};

type StartOffscreenRecordingMessage = {
  target: "offscreen";
  type: "START_OFFSCREEN_RECORDING";
  mode: RecorderMode;
  format: RecordingFormat;
  streamId: string;
  tabId: number;
  crop?: CropRect;
  viewport: ViewportSize;
};

type OffscreenControlMessage =
  | { target: "offscreen"; type: "STOP_TAB_RECORDING"; save: boolean }
  | { target: "offscreen"; type: "TOGGLE_TAB_RECORDING_PAUSE" }
  | { target: "offscreen"; type: "UPDATE_TAB_RECORDING_CROP"; crop: CropRect; viewport: ViewportSize };

type ProcessAndDownloadScreenshotMessage = {
  target: "offscreen";
  type: "PROCESS_AND_DOWNLOAD_SCREENSHOT";
  tabId: number;
  filename: string;
  dataUrl: string;
  format: ScreenshotFormat;
  crop?: CropRect;
  viewport: ViewportSize;
};

type OffscreenMessage = StartOffscreenRecordingMessage | OffscreenControlMessage | ProcessAndDownloadScreenshotMessage;

export {};

const GIF_FRAME_DELAY_MS = 67;
const MAX_GIF_DURATION_MS = 15_000;
const VIDEO_FRAME_DELAY_MS = 16;

class OffscreenRecorder {
  private sourceStream: MediaStream | undefined;
  private recordingStream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private mode: RecorderMode = "screen";
  private format: RecordingFormat = "webm";
  private saveOnStop = true;
  private video: HTMLVideoElement | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private ctx: CanvasRenderingContext2D | undefined;
  private animationId = 0;
  private croppedFrameTimerId = 0;
  private crop: CropRect | undefined;
  private viewport: ViewportSize = { width: 1, height: 1 };
  private outputSize: { width: number; height: number } | undefined;
  private audioContext: AudioContext | undefined;
  private tabId: number | undefined;
  private gifEncoder: ReturnType<typeof GIFEncoder> | undefined;
  private gifFrameTimerId = 0;
  private gifFrameCount = 0;
  private gifStartedAt = 0;
  private gifPaused = false;

  async start(message: StartOffscreenRecordingMessage): Promise<void> {
    this.stop(false);

    this.mode = message.mode;
    this.format = message.format;
    this.crop = message.crop;
    this.tabId = message.tabId;
    this.viewport = sanitizeViewport(message.viewport);
    this.chunks = [];
    this.saveOnStop = true;
    this.outputSize = undefined;

    this.sourceStream = await navigator.mediaDevices.getUserMedia(createTabCaptureConstraints(message.streamId));
    this.keepTabAudioAudible(this.sourceStream);

    if (message.format === "gif") {
      await this.startGifRecording(message);
      return;
    }

    this.recordingStream =
      message.mode === "element" && message.crop
        ? await this.createCroppedStream(this.sourceStream, message.crop)
        : this.sourceStream;

    const mimeType = getBestMimeType(message.format);
    if (!mimeType) {
      throw new Error(`${message.format.toUpperCase()} recording is not supported by this Chrome build.`);
    }

    this.recorder = new MediaRecorder(this.recordingStream, {
      mimeType,
      videoBitsPerSecond: message.mode === "element" ? 12_000_000 : 16_000_000,
      audioBitsPerSecond: 128_000
    });

    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    });

    this.sourceStream.getVideoTracks()[0]?.addEventListener("ended", () => {
      this.stop(true);
    });

    this.recorder.addEventListener("stop", () => {
      void this.finish();
    });

    this.recorder.start(1000);
  }

  stop(save = true): void {
    this.saveOnStop = save;

    if (this.format === "gif" && this.gifEncoder) {
      void this.finishGif();
      return;
    }

    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
      return;
    }

    this.cleanupStreams();
  }

  togglePause(): boolean {
    if (this.format === "gif" && this.gifEncoder) {
      this.gifPaused = !this.gifPaused;
      return this.gifPaused;
    }

    if (!this.recorder) return false;

    if (this.recorder.state === "recording") {
      this.recorder.pause();
      return true;
    }

    if (this.recorder.state === "paused") {
      this.recorder.resume();
      return false;
    }

    return false;
  }

  updateCrop(crop: CropRect, viewport: ViewportSize): void {
    this.crop = sanitizeCrop(crop);
    this.viewport = sanitizeViewport(viewport);
  }

  private async createCroppedStream(source: MediaStream, crop: CropRect): Promise<MediaStream> {
    this.crop = sanitizeCrop(crop);
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = source;

    await this.video.play();
    await waitForVideoMetadata(this.video);

    const initialScale = this.getScale();
    this.outputSize = {
      width: Math.max(2, Math.round(crop.width * initialScale.x)),
      height: Math.max(2, Math.round(crop.height * initialScale.y))
    };

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.outputSize.width;
    this.canvas.height = this.outputSize.height;
    this.ctx = this.canvas.getContext("2d", { alpha: false }) ?? undefined;

    if (!this.ctx) {
      throw new Error("Canvas rendering is unavailable.");
    }

    const canvasStream = this.canvas.captureStream(60);
    const canvasTrack = canvasStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    const audioTracks = source.getAudioTracks();
    this.recordingStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    this.drawCroppedFrame(canvasTrack);
    this.croppedFrameTimerId = window.setInterval(() => {
      this.drawCroppedFrame(canvasTrack);
    }, VIDEO_FRAME_DELAY_MS);
    return this.recordingStream;
  }

  private async startGifRecording(message: StartOffscreenRecordingMessage): Promise<void> {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.sourceStream ?? null;

    await this.video.play();
    await waitForVideoMetadata(this.video);

    const sourceRect = this.getGifSourceRect(message);
    const outputSize = fitWithin(sourceRect.width, sourceRect.height, message.mode === "element" ? 1600 : 1920);
    this.outputSize = outputSize;
    this.canvas = document.createElement("canvas");
    this.canvas.width = outputSize.width;
    this.canvas.height = outputSize.height;
    this.ctx = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true }) ?? undefined;

    if (!this.ctx) {
      throw new Error("Canvas rendering is unavailable.");
    }

    this.gifEncoder = GIFEncoder();
    this.gifFrameCount = 0;
    this.gifStartedAt = Date.now();
    this.gifPaused = false;
    this.captureGifFrame();
  }

  private captureGifFrame = (): void => {
    if (!this.gifEncoder || !this.video || !this.canvas || !this.ctx || !this.outputSize) return;

    if (!this.gifPaused) {
      const sourceRect = this.getGifSourceRect({
        mode: this.mode,
        crop: this.crop,
        viewport: this.viewport
      });

      this.ctx.drawImage(
        this.video,
        sourceRect.left,
        sourceRect.top,
        sourceRect.width,
        sourceRect.height,
        0,
        0,
        this.outputSize.width,
        this.outputSize.height
      );

      const imageData = this.ctx.getImageData(0, 0, this.outputSize.width, this.outputSize.height);
      const palette = quantize(imageData.data, 256, { format: "rgb565" });
      const indexedFrame = applyPalette(imageData.data, palette, "rgb565");
      this.gifEncoder.writeFrame(indexedFrame, this.outputSize.width, this.outputSize.height, {
        palette,
        delay: GIF_FRAME_DELAY_MS
      });
      this.gifFrameCount += 1;
    }

    if (Date.now() - this.gifStartedAt >= MAX_GIF_DURATION_MS) {
      void this.finishGif();
      return;
    }

    this.gifFrameTimerId = window.setTimeout(this.captureGifFrame, GIF_FRAME_DELAY_MS);
  };

  private getGifSourceRect(message: {
    mode: RecorderMode;
    crop?: CropRect | undefined;
    viewport: ViewportSize;
  }): CropRect {
    const scale = this.getScale();
    if (message.mode === "element" && message.crop) {
      const crop = sanitizeCrop(message.crop);
      return {
        left: Math.max(0, Math.round(crop.left * scale.x)),
        top: Math.max(0, Math.round(crop.top * scale.y)),
        width: Math.max(2, Math.round(crop.width * scale.x)),
        height: Math.max(2, Math.round(crop.height * scale.y))
      };
    }

    return {
      left: 0,
      top: 0,
      width: Math.max(2, this.video?.videoWidth ?? message.viewport.width),
      height: Math.max(2, this.video?.videoHeight ?? message.viewport.height)
    };
  }

  private async finishGif(): Promise<void> {
    const shouldSave = this.saveOnStop;
    const gif = this.gifEncoder;
    const mode = this.mode;
    const tabId = this.tabId;
    const filename = createDownloadFilename(mode, "gif");

    window.clearTimeout(this.gifFrameTimerId);
    this.gifFrameTimerId = 0;
    this.gifEncoder = undefined;

    if (gif && this.gifFrameCount > 0) {
      gif.finish();
      const bytes = gif.bytes();
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      this.cleanupStreams();

      if (shouldSave && tabId !== undefined) {
        try {
          await downloadBlob(new Blob([copy], { type: "image/gif" }), filename, tabId);
        } catch (error) {
          await chrome.runtime.sendMessage({
            type: "OFFSCREEN_RECORDING_SAVE_FAILED",
            tabId,
            error: getErrorMessage(error)
          });
        }
      }
      return;
    }

    this.cleanupStreams();
  }

  private drawCroppedFrame(canvasTrack?: CanvasCaptureMediaStreamTrack): void {
    if (!this.video || !this.canvas || !this.ctx || !this.crop || !this.outputSize) return;

    const scale = this.getScale();
    const sourceX = Math.max(0, Math.round(this.crop.left * scale.x));
    const sourceY = Math.max(0, Math.round(this.crop.top * scale.y));
    const sourceWidth = Math.max(2, Math.round(this.crop.width * scale.x));
    const sourceHeight = Math.max(2, Math.round(this.crop.height * scale.y));

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(
      this.video,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      this.outputSize.width,
      this.outputSize.height
    );

    canvasTrack?.requestFrame();
  }

  private getScale(): { x: number; y: number } {
    const videoWidth = Math.max(1, this.video?.videoWidth ?? this.viewport.width);
    const videoHeight = Math.max(1, this.video?.videoHeight ?? this.viewport.height);
    return {
      x: videoWidth / Math.max(1, this.viewport.width),
      y: videoHeight / Math.max(1, this.viewport.height)
    };
  }

  private keepTabAudioAudible(stream: MediaStream): void {
    if (stream.getAudioTracks().length === 0) return;
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.audioContext.destination);
  }

  private async finish(): Promise<void> {
    const shouldSave = this.saveOnStop;
    const chunks = [...this.chunks];
    const type = this.recorder?.mimeType || getFallbackMimeType(this.format);
    const mode = this.mode;
    const tabId = this.tabId;
    const filename = createDownloadFilename(mode, this.format);

    this.cleanupStreams();

    if (shouldSave && chunks.length > 0 && tabId !== undefined) {
      try {
        await downloadBlob(new Blob(chunks, { type }), filename, tabId);
      } catch (error) {
        await chrome.runtime.sendMessage({
          type: "OFFSCREEN_RECORDING_SAVE_FAILED",
          tabId,
          error: getErrorMessage(error)
        });
      }
    }
  }

  private cleanupStreams(): void {
    cancelAnimationFrame(this.animationId);
    window.clearTimeout(this.gifFrameTimerId);
    window.clearInterval(this.croppedFrameTimerId);
    this.animationId = 0;
    this.gifFrameTimerId = 0;
    this.croppedFrameTimerId = 0;

    for (const track of this.sourceStream?.getTracks() ?? []) {
      track.stop();
    }

    if (this.recordingStream !== this.sourceStream) {
      for (const track of this.recordingStream?.getTracks() ?? []) {
        track.stop();
      }
    }

    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
    this.sourceStream = undefined;
    this.recordingStream = undefined;
    this.recorder = undefined;
    this.video = undefined;
    this.canvas = undefined;
    this.ctx = undefined;
    this.chunks = [];
    this.tabId = undefined;
    this.gifEncoder = undefined;
    this.gifFrameCount = 0;
    this.gifPaused = false;
  }
}

const recorder = new OffscreenRecorder();

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === "START_OFFSCREEN_RECORDING") {
    void recorder
      .start(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message.type === "STOP_TAB_RECORDING") {
    recorder.stop(message.save);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "TOGGLE_TAB_RECORDING_PAUSE") {
    sendResponse({ ok: true, paused: recorder.togglePause() });
    return true;
  }

  if (message.type === "UPDATE_TAB_RECORDING_CROP") {
    recorder.updateCrop(message.crop, message.viewport);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "PROCESS_AND_DOWNLOAD_SCREENSHOT") {
    void processAndDownloadScreenshot(message)
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  return false;
});

function createTabCaptureConstraints(streamId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: 60
      }
    }
  } as unknown as MediaStreamConstraints;
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out preparing the captured tab video."));
    }, 3000);

    const onLoaded = (): void => {
      cleanup();
      resolve();
    };

    const cleanup = (): void => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onLoaded);
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
  });
}

async function processAndDownloadScreenshot(
  message: ProcessAndDownloadScreenshotMessage
): Promise<{ downloadId: number; path?: string | undefined }> {
  const image = await loadImage(message.dataUrl);
  const viewport = sanitizeViewport(message.viewport);
  const scaleX = image.naturalWidth / viewport.width;
  const scaleY = image.naturalHeight / viewport.height;
  const crop = message.crop ? sanitizeCrop(message.crop) : undefined;
  const sourceX = crop ? clamp(Math.round(crop.left * scaleX), 0, image.naturalWidth - 1) : 0;
  const sourceY = crop ? clamp(Math.round(crop.top * scaleY), 0, image.naturalHeight - 1) : 0;
  const sourceWidth = crop ? clamp(Math.round(crop.width * scaleX), 1, image.naturalWidth - sourceX) : image.naturalWidth;
  const sourceHeight = crop
    ? clamp(Math.round(crop.height * scaleY), 1, image.naturalHeight - sourceY)
    : image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Canvas rendering is unavailable.");
  }

  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  return downloadBlob(await canvasToBlob(canvas, getScreenshotMimeType(message.format)), message.filename, message.tabId);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Chrome could not prepare the screenshot.")), {
      once: true
    });
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Chrome could not encode the screenshot."));
    }, type);
  });
}

async function downloadBlob(
  blob: Blob,
  filename: string,
  tabId: number
): Promise<{ downloadId: number; path?: string | undefined }> {
  const url = URL.createObjectURL(blob);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_DOWNLOAD_RECORDING",
      tabId,
      filename,
      url
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Chrome could not save the recording.");
    }

    return {
      downloadId: response.downloadId,
      path: response.path
    };
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function sanitizeCrop(crop: CropRect): CropRect {
  return {
    left: Math.max(0, crop.left),
    top: Math.max(0, crop.top),
    width: Math.max(2, crop.width),
    height: Math.max(2, crop.height)
  };
}

function sanitizeViewport(viewport: ViewportSize): ViewportSize {
  return {
    width: Math.max(1, viewport.width),
    height: Math.max(1, viewport.height)
  };
}

function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const safeWidth = Math.max(2, width);
  const safeHeight = Math.max(2, height);
  const scale = Math.min(1, maxSide / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(2, Math.round(safeWidth * scale)),
    height: Math.max(2, Math.round(safeHeight * scale))
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getScreenshotMimeType(format: ScreenshotFormat): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function getBestMimeType(format: RecordingFormat): string {
  const candidates =
    format === "mp4"
      ? [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4;codecs=avc1.42001E,mp4a.40.2",
          "video/mp4"
        ]
      : [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm;codecs=h264,opus",
          "video/webm"
        ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function getFallbackMimeType(format: RecordingFormat): string {
  if (format === "mp4") return "video/mp4";
  if (format === "gif") return "image/gif";
  return "video/webm";
}

function createDownloadFilename(mode: RecorderMode, format: RecordingFormat): string {
  return `Element Recorder/element-recorder-${mode}-${timestamp()}.${format}`;
}

function timestamp(): string {
  const date = new Date();
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Recording failed.";
}
