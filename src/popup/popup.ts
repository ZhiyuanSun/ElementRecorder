type RecorderCommand =
  | "START_SCREEN_RECORDING"
  | "START_ELEMENT_SELECTION"
  | "TAKE_SCREEN_SCREENSHOT"
  | "START_ELEMENT_SCREENSHOT_SELECTION";
type RecordingFormat = "webm" | "mp4" | "gif";
type ScreenshotFormat = "png" | "jpeg" | "webp";

const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const screenButton = document.querySelector<HTMLButtonElement>("#record-screen");
const elementButton = document.querySelector<HTMLButtonElement>("#record-element");
const screenScreenshotButton = document.querySelector<HTMLButtonElement>("#screenshot-screen");
const elementScreenshotButton = document.querySelector<HTMLButtonElement>("#screenshot-element");
const hideMouseInput = document.querySelector<HTMLInputElement>("#hide-mouse");
const formatInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[name='recording-format']"));
const screenshotFormatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>("input[name='screenshot-format']")
);
const actionButtons = [screenButton, elementButton, screenScreenshotButton, elementScreenshotButton].filter(
  (button): button is HTMLButtonElement => Boolean(button)
);

void restoreFormat();
void restoreOptions();

function setStatus(message: string, isError = false): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("Open a webpage before recording.");
  }

  if (!tab.url || /^(chrome|edge|about|devtools):/i.test(tab.url)) {
    throw new Error("Chrome internal pages cannot be recorded from the extension.");
  }

  return tab;
}

function getSelectedFormat(): RecordingFormat {
  const selected = formatInputs.find((input) => input.checked)?.value;
  return selected === "mp4" || selected === "gif" ? selected : "webm";
}

function getSelectedScreenshotFormat(): ScreenshotFormat {
  const selected = screenshotFormatInputs.find((input) => input.checked)?.value;
  if (selected === "jpeg" || selected === "webp") return selected;
  return "png";
}

function shouldHideMouse(): boolean {
  return hideMouseInput?.checked ?? true;
}

async function restoreFormat(): Promise<void> {
  const { recordingFormat } = await chrome.storage.local.get("recordingFormat");
  const format = recordingFormat === "mp4" || recordingFormat === "gif" ? recordingFormat : "webm";
  const input = formatInputs.find((candidate) => candidate.value === format);
  if (input) input.checked = true;
}

async function restoreOptions(): Promise<void> {
  const { hideMouse, screenshotFormat } = await chrome.storage.local.get(["hideMouse", "screenshotFormat"]);
  if (hideMouseInput) hideMouseInput.checked = hideMouse !== false;
  const format = screenshotFormat === "jpeg" || screenshotFormat === "webp" ? screenshotFormat : "png";
  const input = screenshotFormatInputs.find((candidate) => candidate.value === format);
  if (input) input.checked = true;
}

async function sendCommand(
  command: RecorderCommand,
  format: RecordingFormat,
  screenshotFormat: ScreenshotFormat,
  hideMouse: boolean
): Promise<void> {
  const tab = await getActiveTab();

  try {
    await chrome.tabs.sendMessage(tab.id!, { type: command, format, screenshotFormat, hideMouse });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["content/content-script.js"]
    });
    await chrome.tabs.sendMessage(tab.id!, { type: command, format, screenshotFormat, hideMouse });
  }
}

async function start(command: RecorderCommand): Promise<void> {
  const format = getSelectedFormat();
  const screenshotFormat = getSelectedScreenshotFormat();
  const hideMouse = shouldHideMouse();
  await chrome.storage.local.set({ recordingFormat: format, screenshotFormat, hideMouse });
  setStatus(getPendingStatus(command));
  for (const button of actionButtons) button.setAttribute("disabled", "true");

  try {
    await sendCommand(command, format, screenshotFormat, hideMouse);
    window.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start recording.";
    setStatus(message, true);
    for (const button of actionButtons) button.removeAttribute("disabled");
  }
}

function getPendingStatus(command: RecorderCommand): string {
  if (command === "START_SCREEN_RECORDING") return "Opening recorder...";
  if (command === "TAKE_SCREEN_SCREENSHOT") return "Capturing screenshot...";
  return "Select an element on the page...";
}

screenButton?.addEventListener("click", () => {
  void start("START_SCREEN_RECORDING");
});

elementButton?.addEventListener("click", () => {
  void start("START_ELEMENT_SELECTION");
});

screenScreenshotButton?.addEventListener("click", () => {
  void start("TAKE_SCREEN_SCREENSHOT");
});

elementScreenshotButton?.addEventListener("click", () => {
  void start("START_ELEMENT_SCREENSHOT_SELECTION");
});

for (const input of formatInputs) {
  input.addEventListener("change", () => {
    void chrome.storage.local.set({ recordingFormat: getSelectedFormat() });
  });
}

for (const input of screenshotFormatInputs) {
  input.addEventListener("change", () => {
    void chrome.storage.local.set({ screenshotFormat: getSelectedScreenshotFormat() });
  });
}

hideMouseInput?.addEventListener("change", () => {
  void chrome.storage.local.set({ hideMouse: shouldHideMouse() });
});
