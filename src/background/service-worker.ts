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

type StartTabRecordingMessage = {
  type: "START_TAB_RECORDING";
  mode: RecorderMode;
  format: RecordingFormat;
  crop?: CropRect;
  viewport: ViewportSize;
};

type CaptureTabScreenshotMessage = {
  type: "CAPTURE_TAB_SCREENSHOT";
  mode: RecorderMode;
  format: ScreenshotFormat;
  crop?: CropRect;
  viewport: ViewportSize;
};

type RecordingControlMessage =
  | { type: "STOP_TAB_RECORDING"; save: boolean }
  | { type: "TOGGLE_TAB_RECORDING_PAUSE" }
  | { type: "UPDATE_TAB_RECORDING_CROP"; crop: CropRect; viewport: ViewportSize }
  | { type: "SHOW_RECORDING_DOWNLOAD"; downloadId: number }
  | { type: "OPEN_DOWNLOADS_FOLDER" };

type OffscreenSavedMessage = {
  type: "OFFSCREEN_RECORDING_SAVED";
  tabId: number;
  filename: string;
  path?: string;
  downloadId: number;
};

type OffscreenSaveFailedMessage = {
  type: "OFFSCREEN_RECORDING_SAVE_FAILED";
  tabId: number;
  error: string;
};

type OffscreenDownloadMessage = {
  type: "OFFSCREEN_DOWNLOAD_RECORDING";
  tabId: number;
  filename: string;
  url: string;
};

type ExtensionMessage =
  | StartTabRecordingMessage
  | CaptureTabScreenshotMessage
  | RecordingControlMessage
  | OffscreenSavedMessage
  | OffscreenSaveFailedMessage
  | OffscreenDownloadMessage
  | { type: "ELEMENT_RECORDER_PING" };

export {};

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if ((message as { target?: string })?.target === "offscreen") {
    return false;
  }

  if (message?.type === "ELEMENT_RECORDER_PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "OFFSCREEN_RECORDING_SAVED") {
    void chrome.tabs
      .sendMessage(message.tabId, {
        type: "RECORDING_SAVED",
        filename: message.filename,
        path: message.path,
        downloadId: message.downloadId
      })
      .catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "OFFSCREEN_RECORDING_SAVE_FAILED") {
    void chrome.tabs
      .sendMessage(message.tabId, {
        type: "RECORDING_SAVE_FAILED",
        error: message.error
      })
      .catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "OFFSCREEN_DOWNLOAD_RECORDING") {
    void downloadRecording(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "SHOW_RECORDING_DOWNLOAD") {
    chrome.downloads.show(message.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "OPEN_DOWNLOADS_FOLDER") {
    chrome.downloads.showDefaultFolder();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "START_TAB_RECORDING") {
    void startTabRecording(message, sender.tab?.id)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "CAPTURE_TAB_SCREENSHOT") {
    void captureTabScreenshot(message, sender.tab)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (
    message?.type === "STOP_TAB_RECORDING" ||
    message?.type === "TOGGLE_TAB_RECORDING_PAUSE" ||
    message?.type === "UPDATE_TAB_RECORDING_CROP"
  ) {
    void chrome.runtime
      .sendMessage({ ...message, target: "offscreen" })
      .then((response) => sendResponse(response ?? { ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  return false;
});

async function downloadRecording(
  message: OffscreenDownloadMessage
): Promise<{ ok: true; downloadId: number; path?: string | undefined } | { ok: false; error: string }> {
  try {
    const downloadId = await chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: false
    });
    const path = await waitForDownloadPath(downloadId);

    await chrome.tabs
      .sendMessage(message.tabId, {
        type: "RECORDING_SAVED",
        filename: message.filename,
        path,
        downloadId
      })
      .catch(() => undefined);

    return { ok: true, downloadId, path };
  } catch (error) {
    const messageText = getErrorMessage(error);
    await chrome.tabs
      .sendMessage(message.tabId, {
        type: "RECORDING_SAVE_FAILED",
        error: messageText
      })
      .catch(() => undefined);
    return { ok: false, error: messageText };
  }
}

function waitForDownloadPath(id: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, 10_000);

    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== id || delta.state?.current !== "complete") return;
      void chrome.downloads.search({ id }).then(([item]) => {
        cleanup();
        resolve(item?.filename);
      });
    };

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function startTabRecording(message: StartTabRecordingMessage, tabId: number | undefined): Promise<{ ok: true }> {
  if (!tabId) {
    throw new Error("No active tab is available to record.");
  }

  await ensureOffscreenDocument();

  const streamId = await getTabMediaStreamId(tabId);

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_OFFSCREEN_RECORDING",
    mode: message.mode,
    format: message.format,
    streamId,
    tabId,
    crop: message.crop,
    viewport: message.viewport
  });

  if (!response?.ok) {
    throw new Error(response?.error ?? "Unable to start tab recording.");
  }

  return { ok: true };
}

async function captureTabScreenshot(
  message: CaptureTabScreenshotMessage,
  tab: chrome.tabs.Tab | undefined
): Promise<{ ok: true; downloadId: number; path?: string | undefined }> {
  if (!tab?.id || tab.windowId === undefined) {
    throw new Error("No active tab is available to capture.");
  }

  const format = sanitizeScreenshotFormat(message.format);
  const captureFormat = format === "jpeg" ? "jpeg" : "png";
  const dataUrl = await captureVisibleTab(tab.windowId, captureFormat);
  const filename = createScreenshotFilename(message.mode, format);

  if (format === "webp" || (message.mode === "element" && message.crop)) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "PROCESS_AND_DOWNLOAD_SCREENSHOT",
      tabId: tab.id,
      filename,
      dataUrl,
      format,
      crop: message.crop,
      viewport: message.viewport
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Chrome could not save the screenshot.");
    }

    return { ok: true, downloadId: response.downloadId, path: response.path };
  }

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
  const path = await waitForDownloadPath(downloadId);

  return { ok: true, downloadId, path };
}

function captureVisibleTab(windowId: number, format: "png" | "jpeg"): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!dataUrl) {
        reject(new Error("Chrome did not return a screenshot."));
        return;
      }

      resolve(dataUrl);
    });
  });
}

function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(streamId);
    });
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl]
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record the current tab with chrome.tabCapture."
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Recording failed.";
}

function sanitizeScreenshotFormat(format: ScreenshotFormat): ScreenshotFormat {
  if (format === "jpeg" || format === "webp") return format;
  return "png";
}

function createScreenshotFilename(mode: RecorderMode, format: ScreenshotFormat): string {
  const extension = format === "jpeg" ? "jpg" : format;
  return `Element Recorder/element-recorder-${mode}-screenshot-${timestamp()}.${extension}`;
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
