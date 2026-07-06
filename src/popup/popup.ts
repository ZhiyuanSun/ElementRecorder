type RecorderCommand = "START_SCREEN_RECORDING" | "START_ELEMENT_SELECTION";
type RecordingFormat = "webm" | "mp4" | "gif";

const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const screenButton = document.querySelector<HTMLButtonElement>("#record-screen");
const elementButton = document.querySelector<HTMLButtonElement>("#record-element");
const formatInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[name='format']"));

void restoreFormat();

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

async function restoreFormat(): Promise<void> {
  const { recordingFormat } = await chrome.storage.local.get("recordingFormat");
  const format = recordingFormat === "mp4" || recordingFormat === "gif" ? recordingFormat : "webm";
  const input = formatInputs.find((candidate) => candidate.value === format);
  if (input) input.checked = true;
}

async function sendCommand(command: RecorderCommand, format: RecordingFormat): Promise<void> {
  const tab = await getActiveTab();

  try {
    await chrome.tabs.sendMessage(tab.id!, { type: command, format });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["content/content-script.js"]
    });
    await chrome.tabs.sendMessage(tab.id!, { type: command, format });
  }
}

async function start(command: RecorderCommand): Promise<void> {
  const format = getSelectedFormat();
  await chrome.storage.local.set({ recordingFormat: format });
  setStatus(command === "START_SCREEN_RECORDING" ? "Opening recorder..." : "Select an element on the page...");
  screenButton?.setAttribute("disabled", "true");
  elementButton?.setAttribute("disabled", "true");

  try {
    await sendCommand(command, format);
    window.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start recording.";
    setStatus(message, true);
    screenButton?.removeAttribute("disabled");
    elementButton?.removeAttribute("disabled");
  }
}

screenButton?.addEventListener("click", () => {
  void start("START_SCREEN_RECORDING");
});

elementButton?.addEventListener("click", () => {
  void start("START_ELEMENT_SELECTION");
});

for (const input of formatInputs) {
  input.addEventListener("change", () => {
    void chrome.storage.local.set({ recordingFormat: getSelectedFormat() });
  });
}
