type RecorderMode = "screen" | "element";
type RecordingFormat = "webm" | "mp4" | "gif";
type ScreenshotFormat = "png" | "jpeg" | "webp";
type RecorderState = "idle" | "selecting" | "locked" | "recording";

type RectSnapshot = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type RecorderCommandMessage = {
  type:
    | "START_SCREEN_RECORDING"
    | "START_ELEMENT_SELECTION"
    | "TAKE_SCREEN_SCREENSHOT"
    | "START_ELEMENT_SCREENSHOT_SELECTION";
  format?: RecordingFormat;
  screenshotFormat?: ScreenshotFormat;
  hideMouse?: boolean;
} | {
  type: "RECORDING_SAVED";
  filename: string;
  path?: string;
  downloadId: number;
} | {
  type: "RECORDING_SAVE_FAILED";
  error: string;
};

export {};

declare global {
  interface Window {
    __elementRecorderLoaded?: boolean;
  }
}

if (!window.__elementRecorderLoaded) {
  window.__elementRecorderLoaded = true;

  class MessagingBridge {
    constructor(private readonly controller: RecordingController) {
      chrome.runtime.onMessage.addListener((message: RecorderCommandMessage) => {
        if (message?.type === "START_SCREEN_RECORDING") {
          void this.controller.startScreenRecording(getMessageFormat(message), getMessageHideMouse(message));
        }

        if (message?.type === "START_ELEMENT_SELECTION") {
          this.controller.startElementSelection(getMessageFormat(message), getMessageHideMouse(message));
        }

        if (message?.type === "TAKE_SCREEN_SCREENSHOT") {
          void this.controller.captureScreenScreenshot(getMessageScreenshotFormat(message));
        }

        if (message?.type === "START_ELEMENT_SCREENSHOT_SELECTION") {
          this.controller.startElementScreenshotSelection(getMessageScreenshotFormat(message));
        }

        if (message?.type === "RECORDING_SAVE_FAILED") {
          this.controller.showToast(`Could not save recording: ${message.error}`);
        }

        return false;
      });
    }
  }

  class UIStateManager {
    private state: RecorderState = "idle";

    set(next: RecorderState): void {
      this.state = next;
    }

    get(): RecorderState {
      return this.state;
    }

    isBusy(): boolean {
      return this.state !== "idle";
    }
  }

  class ShadowUIRoot {
    readonly host: HTMLDivElement;
    readonly root: ShadowRoot;

    constructor() {
      this.host = document.createElement("div");
      this.host.id = "element-recorder-root";
      this.host.style.position = "fixed";
      this.host.style.inset = "0";
      this.host.style.zIndex = "2147483647";
      this.host.style.pointerEvents = "none";
      document.documentElement.append(this.host);
      this.root = this.host.attachShadow({ mode: "open" });
      this.root.append(createStyle());
    }

    dispose(): void {
      this.host.remove();
    }
  }

  class CursorScope {
    private styleEl: HTMLStyleElement | undefined;

    enable(): void {
      if (this.styleEl) return;
      this.styleEl = document.createElement("style");
      this.styleEl.id = "element-recorder-cursor";
      this.styleEl.textContent = `
        html.element-recorder-selecting,
        html.element-recorder-selecting * {
          cursor: crosshair !important;
        }
      `;
      document.documentElement.classList.add("element-recorder-selecting");
      document.documentElement.append(this.styleEl);
    }

    disable(): void {
      document.documentElement.classList.remove("element-recorder-selecting");
      this.styleEl?.remove();
      this.styleEl = undefined;
    }
  }

  class RecordingCursorSuppressor {
    private styleEl: HTMLStyleElement | undefined;
    private target: Element | undefined;

    enableForElement(target: Element): void {
      this.target = target;
      this.target.classList.add("element-recorder-hide-cursor-target");

      if (!this.styleEl) {
        this.styleEl = document.createElement("style");
        this.styleEl.id = "element-recorder-hide-cursor";
        this.styleEl.textContent = `
          .element-recorder-hide-cursor-target,
          .element-recorder-hide-cursor-target * {
            cursor: none !important;
          }
        `;
        document.documentElement.append(this.styleEl);
      }
    }

    disable(): void {
      this.target?.classList.remove("element-recorder-hide-cursor-target");
      this.target = undefined;
      this.styleEl?.remove();
      this.styleEl = undefined;
    }
  }

  class HoverHighlighter {
    private readonly box: HTMLDivElement;
    private target: Element | null = null;
    private rafId = 0;
    private enabled = false;

    constructor(private readonly ui: ShadowUIRoot) {
      this.box = document.createElement("div");
      this.box.className = "er-hover-box";
      this.ui.root.append(this.box);
    }

    start(onSelect: (element: Element) => void): void {
      this.enabled = true;
      this.box.classList.add("visible");

      const onMove = (event: PointerEvent): void => {
        const target = this.getSelectableElement(event);
        if (target !== this.target) {
          this.target = target;
          this.update();
        }
      };

      const onClick = (event: MouseEvent): void => {
        if (!this.enabled || !this.target) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.enabled = false;
        this.cleanup();
        onSelect(this.target);
      };

      const onRefresh = (): void => this.update();
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent("element-recorder-cancel"));
        }
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("click", onClick, true);
      window.addEventListener("scroll", onRefresh, true);
      window.addEventListener("resize", onRefresh, true);
      window.addEventListener("keydown", onKey, true);

      this.cleanup = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("click", onClick, true);
        window.removeEventListener("scroll", onRefresh, true);
        window.removeEventListener("resize", onRefresh, true);
        window.removeEventListener("keydown", onKey, true);
      };
    }

    stop(): void {
      this.enabled = false;
      this.cleanup();
      this.target = null;
      this.box.classList.remove("visible", "locked");
      cancelAnimationFrame(this.rafId);
    }

    lockTo(element: Element): void {
      this.target = element;
      this.box.classList.add("visible", "locked");
      this.update();
    }

    hide(): void {
      this.box.classList.remove("visible", "locked");
    }

    private cleanup = (): void => undefined;

    private getSelectableElement(event: PointerEvent): Element | null {
      const path = event.composedPath();
      const pathElement = path.find((item): item is Element => {
        return item instanceof Element && item !== this.ui.host && !this.ui.host.contains(item);
      });

      const candidate = pathElement ?? document.elementFromPoint(event.clientX, event.clientY);
      if (!candidate || candidate === document.documentElement || candidate === document.body) {
        return document.body;
      }

      return candidate;
    }

    private update(): void {
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(() => {
        if (!this.target) return;
        const rect = getClampedRect(this.target);
        setRectStyle(this.box, rect);
      });
    }
  }

  class OverlayRenderer {
    private readonly top = document.createElement("div");
    private readonly bottom = document.createElement("div");
    private readonly left = document.createElement("div");
    private readonly right = document.createElement("div");
    private readonly focus = document.createElement("div");
    private target: Element | null = null;
    private rafId = 0;
    private resizeObserver?: ResizeObserver;
    private mutationObserver?: MutationObserver;
    private active = false;
    private readonly dimOpacity = 0.78;

    constructor(private readonly ui: ShadowUIRoot) {
      for (const node of [this.top, this.bottom, this.left, this.right]) {
        node.className = "er-mask";
        this.ui.root.append(node);
      }
      this.focus.className = "er-focus-ring";
      this.ui.root.append(this.focus);
    }

    show(target: Element, mode: "locked" | "recording"): void {
      this.target = target;
      this.active = true;
      this.focus.classList.toggle("recording", mode === "recording");

      for (const node of [this.top, this.bottom, this.left, this.right, this.focus]) {
        node.classList.add("visible");
      }

      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(target);

      this.mutationObserver?.disconnect();
      this.mutationObserver = new MutationObserver(() => this.schedule());
      this.mutationObserver.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true
      });

      window.addEventListener("scroll", this.schedule, true);
      window.addEventListener("resize", this.schedule, true);
      this.tick();
    }

    hide(): void {
      this.active = false;
      this.target = null;
      this.resizeObserver?.disconnect();
      this.mutationObserver?.disconnect();
      window.removeEventListener("scroll", this.schedule, true);
      window.removeEventListener("resize", this.schedule, true);
      cancelAnimationFrame(this.rafId);

      for (const node of [this.top, this.bottom, this.left, this.right, this.focus]) {
        node.classList.remove("visible", "recording");
      }
    }

    private schedule = (): void => {
      if (!this.active) return;
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(() => this.paint());
    };

    private tick = (): void => {
      if (!this.active) return;
      this.paint();
      this.rafId = requestAnimationFrame(this.tick);
    };

    private paint(): void {
      if (!this.target) return;
      const rect = padRect(getClampedRect(this.target), 8);
      const width = window.innerWidth;
      const height = window.innerHeight;

      applyBox(this.top, 0, 0, width, rect.top);
      applyBox(this.bottom, 0, rect.bottom, width, Math.max(0, height - rect.bottom));
      applyBox(this.left, 0, rect.top, rect.left, rect.height);
      applyBox(this.right, rect.right, rect.top, Math.max(0, width - rect.right), rect.height);
      setRectStyle(this.focus, rect);

      for (const node of [this.top, this.bottom, this.left, this.right]) {
        node.style.background = `rgb(7 11 18 / ${this.dimOpacity})`;
      }
    }
  }

  class FloatingActionBubble {
    private readonly bubble = document.createElement("div");
    private target: Element | null = null;
    private rafId = 0;

    constructor(private readonly ui: ShadowUIRoot) {
      this.bubble.className = "er-action-bubble";
      this.bubble.innerHTML = `
        <button class="er-pill er-record" type="button" data-action="record" aria-label="Record selected element">
          <span class="er-pill-icon record" aria-hidden="true">●</span><strong>Record</strong>
        </button>
        <button class="er-icon-button" type="button" data-action="cancel" aria-label="Cancel selection">×</button>
      `;
      this.ui.root.append(this.bubble);
    }

    show(
      target: Element,
      handlers: { onRecord: () => void; onCancel: () => void },
      primaryLabel = "Record",
      primaryIcon: "record" | "camera" = "record"
    ): void {
      this.target = target;
      this.setPrimaryAction(primaryLabel, primaryIcon);
      this.bubble.classList.add("visible");
      this.bubble.addEventListener("click", this.onClick);
      this.handlers = handlers;
      window.addEventListener("scroll", this.update, true);
      window.addEventListener("resize", this.update, true);
      this.update();
    }

    hide(): void {
      this.target = null;
      this.bubble.classList.remove("visible");
      this.bubble.removeEventListener("click", this.onClick);
      window.removeEventListener("scroll", this.update, true);
      window.removeEventListener("resize", this.update, true);
      cancelAnimationFrame(this.rafId);
    }

    private handlers: { onRecord: () => void; onCancel: () => void } = {
      onRecord: () => undefined,
      onCancel: () => undefined
    };

    private onClick = (event: MouseEvent): void => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      if (button.dataset.action === "record") {
        this.handlers.onRecord();
      } else {
        this.handlers.onCancel();
      }
    };

    private setPrimaryAction(label: string, icon: "record" | "camera"): void {
      const button = this.bubble.querySelector<HTMLButtonElement>("button[data-action='record']");
      const text = button?.querySelector("strong");
      const iconEl = button?.querySelector<HTMLElement>(".er-pill-icon");
      if (text) text.textContent = label;
      if (iconEl) {
        iconEl.textContent = icon === "record" ? "●" : "";
        iconEl.classList.toggle("record", icon === "record");
        iconEl.classList.toggle("camera", icon === "camera");
      }
      button?.setAttribute("aria-label", `${label} selected element`);
    }

    private update = (): void => {
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(() => {
        if (!this.target) return;
        const rect = getClampedRect(this.target);
        const bubbleRect = this.bubble.getBoundingClientRect();
        const gap = 12;
        let top = rect.bottom + gap;
        let left = rect.left;

        if (top + bubbleRect.height > window.innerHeight - gap) {
          top = rect.top - bubbleRect.height - gap;
        }

        left = clamp(left, gap, window.innerWidth - bubbleRect.width - gap);
        top = clamp(top, gap, window.innerHeight - bubbleRect.height - gap);

        this.bubble.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      });
    };
  }

  class ScreenStartBubble {
    private readonly bubble = document.createElement("div");
    private handlers: { onRecord: () => void; onCancel: () => void } = {
      onRecord: () => undefined,
      onCancel: () => undefined
    };

    constructor(private readonly ui: ShadowUIRoot) {
      this.bubble.className = "er-screen-start-bubble";
      this.bubble.innerHTML = `
        <button class="er-pill er-record" type="button" data-action="record" aria-label="Start screen recording">
          <span aria-hidden="true">●</span><strong>Record</strong>
        </button>
        <button class="er-icon-button" type="button" data-action="cancel" aria-label="Cancel recording">×</button>
      `;
      this.ui.root.append(this.bubble);
    }

    show(handlers: { onRecord: () => void; onCancel: () => void }): void {
      this.handlers = handlers;
      this.bubble.classList.add("visible");
      this.bubble.addEventListener("click", this.onClick);
    }

    hide(): void {
      this.bubble.classList.remove("visible");
      this.bubble.removeEventListener("click", this.onClick);
    }

    private onClick = (event: MouseEvent): void => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      if (button.dataset.action === "record") {
        this.hide();
        this.handlers.onRecord();
      } else {
        this.handlers.onCancel();
      }
    };
  }

  class RecordingControlPanel {
    private readonly panel = document.createElement("div");
    private timerId = 0;
    private startedAt = 0;
    private elapsedBeforePause = 0;
    private dragging = false;
    private dragOffsetX = 0;
    private dragOffsetY = 0;
    private position = { x: 18, y: 18 };
    private handlers: {
      onStop: () => void;
      onCancel: () => void;
      onPauseToggle: () => boolean;
    } = {
      onStop: () => undefined,
      onCancel: () => undefined,
      onPauseToggle: () => false
    };

    constructor(private readonly ui: ShadowUIRoot) {
      this.panel.className = "er-control-panel";
      this.panel.innerHTML = `
        <div class="er-drag-handle" aria-hidden="true"></div>
        <div class="er-rec-status"><span></span><strong>Recording</strong></div>
        <time>00:00</time>
        <button class="er-icon-button pause" type="button" data-action="pause" aria-label="Pause recording">Ⅱ</button>
        <button class="er-stop-button" type="button" data-action="stop">Stop</button>
        <button class="er-icon-button" type="button" data-action="cancel" aria-label="Cancel recording">×</button>
      `;
      this.ui.root.append(this.panel);
      this.attachDragging();
    }

    show(handlers: typeof this.handlers): void {
      this.handlers = handlers;
      this.startedAt = Date.now();
      this.elapsedBeforePause = 0;
      this.position = this.defaultPosition();
      this.applyPosition();
      this.panel.classList.add("visible");
      this.panel.addEventListener("click", this.onClick);
      window.addEventListener("resize", this.keepInViewport);
      this.timerId = window.setInterval(() => this.updateTimer(), 250);
      this.updateTimer();
    }

    hide(): void {
      this.panel.classList.remove("visible", "paused");
      this.panel.removeEventListener("click", this.onClick);
      window.removeEventListener("resize", this.keepInViewport);
      window.clearInterval(this.timerId);
    }

    private defaultPosition(): { x: number; y: number } {
      const width = 258;
      return {
        x: Math.max(18, window.innerWidth - width - 18),
        y: 18
      };
    }

    private onClick = (event: MouseEvent): void => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      if (button.dataset.action === "stop") {
        this.handlers.onStop();
        return;
      }

      if (button.dataset.action === "cancel") {
        this.handlers.onCancel();
        return;
      }

      if (button.dataset.action === "pause") {
        const paused = this.handlers.onPauseToggle();
        this.panel.classList.toggle("paused", paused);
        button.textContent = paused ? "▶" : "Ⅱ";

        if (paused) {
          this.elapsedBeforePause += Date.now() - this.startedAt;
          window.clearInterval(this.timerId);
        } else {
          this.startedAt = Date.now();
          this.timerId = window.setInterval(() => this.updateTimer(), 250);
        }
      }
    };

    private updateTimer(): void {
      const time = this.panel.querySelector("time");
      if (!time) return;
      const elapsed = this.elapsedBeforePause + Date.now() - this.startedAt;
      time.textContent = formatDuration(elapsed);
    }

    private attachDragging(): void {
      this.panel.addEventListener("pointerdown", (event) => {
        const target = event.target as Element | null;
        if (target?.closest("button")) return;
        this.dragging = true;
        this.dragOffsetX = event.clientX - this.position.x;
        this.dragOffsetY = event.clientY - this.position.y;
        this.panel.setPointerCapture(event.pointerId);
      });

      this.panel.addEventListener("pointermove", (event) => {
        if (!this.dragging) return;
        this.position.x = event.clientX - this.dragOffsetX;
        this.position.y = event.clientY - this.dragOffsetY;
        this.keepInViewport();
      });

      this.panel.addEventListener("pointerup", (event) => {
        this.dragging = false;
        if (this.panel.hasPointerCapture(event.pointerId)) {
          this.panel.releasePointerCapture(event.pointerId);
        }
      });
    }

    private keepInViewport = (): void => {
      const rect = this.panel.getBoundingClientRect();
      const margin = 10;
      this.position.x = clamp(this.position.x, margin, window.innerWidth - rect.width - margin);
      this.position.y = clamp(this.position.y, margin, window.innerHeight - rect.height - margin);
      this.applyPosition();
    };

    private applyPosition(): void {
      this.panel.style.transform = `translate3d(${Math.round(this.position.x)}px, ${Math.round(this.position.y)}px, 0)`;
    }
  }

  class ScreenRecorder {
    private paused = false;

    async start(mode: RecorderMode, format: RecordingFormat, crop?: RectSnapshot): Promise<void> {
      this.paused = false;
      const response = await chrome.runtime.sendMessage({
        type: "START_TAB_RECORDING",
        mode,
        format,
        crop: crop ? toCropRect(crop) : undefined,
        viewport: getViewportSize()
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? "Unable to start recording.");
      }
    }

    voidStop(save = true): void {
      void chrome.runtime.sendMessage({ type: "STOP_TAB_RECORDING", save });
    }

    togglePause(): boolean {
      this.paused = !this.paused;
      void chrome.runtime.sendMessage({ type: "TOGGLE_TAB_RECORDING_PAUSE" }).then((response) => {
        if (typeof response?.paused === "boolean") {
          this.paused = response.paused;
        }
      });
      return this.paused;
    }

    updateCrop(crop: RectSnapshot): void {
      void chrome.runtime.sendMessage({
        type: "UPDATE_TAB_RECORDING_CROP",
        crop: toCropRect(crop),
        viewport: getViewportSize()
      });
    }
  }

  class ScreenshotCapturer {
    async capture(mode: RecorderMode, format: ScreenshotFormat, crop?: RectSnapshot): Promise<void> {
      const response = await chrome.runtime.sendMessage({
        type: "CAPTURE_TAB_SCREENSHOT",
        mode,
        format,
        crop: crop ? toCropRect(crop) : undefined,
        viewport: getViewportSize()
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? "Unable to save screenshot.");
      }
    }
  }

  class ElementSelectionController {
    selectedElement: Element | null = null;
    private readonly cursor = new CursorScope();

    constructor(
      private readonly state: UIStateManager,
      private readonly highlighter: HoverHighlighter,
      private readonly overlay: OverlayRenderer,
      private readonly bubble: FloatingActionBubble
    ) {}

    start(
      onRecord: (element: Element) => void,
      onCancel: () => void,
      primaryLabel = "Record",
      primaryIcon: "record" | "camera" = "record"
    ): void {
      this.selectedElement = null;
      this.state.set("selecting");
      this.cursor.enable();
      this.overlay.hide();
      this.bubble.hide();

      const cancelHandler = (): void => {
        window.removeEventListener("element-recorder-cancel", cancelHandler);
        this.cancel();
        onCancel();
      };

      window.addEventListener("element-recorder-cancel", cancelHandler);

      this.highlighter.start((element) => {
        this.selectedElement = element;
        this.state.set("locked");
        this.cursor.disable();
        this.highlighter.lockTo(element);
        this.overlay.show(element, "locked");
        this.bubble.show(element, {
          onRecord: () => {
            window.removeEventListener("element-recorder-cancel", cancelHandler);
            onRecord(element);
          },
          onCancel: cancelHandler
        }, primaryLabel, primaryIcon);
      });
    }

    transitionToRecording(): void {
      this.highlighter.hide();
      this.bubble.hide();
      this.overlay.hide();
    }

    cancel(): void {
      this.cursor.disable();
      this.highlighter.stop();
      this.overlay.hide();
      this.bubble.hide();
      this.selectedElement = null;
      this.state.set("idle");
    }
  }

  class RecordingController {
    private ui: ShadowUIRoot | null = null;
    private state = new UIStateManager();
    private recorder = new ScreenRecorder();
    private screenshot = new ScreenshotCapturer();
    private selection: ElementSelectionController | undefined;
    private controls: RecordingControlPanel | undefined;
    private startGate: ScreenStartBubble | undefined;
    private cropAnimationId = 0;
    private cropTarget: Element | null = null;
    private lastCropSignature = "";
    private format: RecordingFormat = "webm";
    private hideMouse = true;
    private readonly cursorSuppressor = new RecordingCursorSuppressor();

    startElementSelection(format: RecordingFormat, hideMouse: boolean): void {
      if (this.state.isBusy()) {
        this.reset();
      }

      this.format = format;
      this.hideMouse = hideMouse;
      const ui = this.ensureUI();
      const highlighter = new HoverHighlighter(ui);
      const overlay = new OverlayRenderer(ui);
      const bubble = new FloatingActionBubble(ui);
      this.controls = new RecordingControlPanel(ui);
      this.selection = new ElementSelectionController(this.state, highlighter, overlay, bubble);
      this.selection.start(
        (element) => void this.startElementRecording(element),
        () => this.reset()
      );
    }

    async startScreenRecording(format: RecordingFormat, hideMouse: boolean): Promise<void> {
      if (this.state.isBusy()) {
        this.reset();
      }

      this.format = format;
      this.hideMouse = hideMouse;
      const ui = this.ensureUI();
      this.controls = new RecordingControlPanel(ui);
      await this.startRecording("screen");
    }

    startElementScreenshotSelection(format: ScreenshotFormat): void {
      if (this.state.isBusy()) {
        this.reset();
      }

      const ui = this.ensureUI();
      const highlighter = new HoverHighlighter(ui);
      const overlay = new OverlayRenderer(ui);
      const bubble = new FloatingActionBubble(ui);
      this.selection = new ElementSelectionController(this.state, highlighter, overlay, bubble);
      this.selection.start(
        (element) => void this.captureElementScreenshot(element, format),
        () => this.reset(),
        "Screenshot",
        "camera"
      );
    }

    async captureScreenScreenshot(format: ScreenshotFormat): Promise<void> {
      if (this.state.isBusy()) {
        this.reset();
      }

      try {
        await this.screenshot.capture("screen", format);
        this.showToast("Screenshot saved.");
      } catch (error) {
        this.showToast(error instanceof Error ? error.message : "Screenshot could not be saved.");
      }
    }

    private async startElementRecording(element: Element): Promise<void> {
      this.selection?.transitionToRecording();
      await waitForSelectionUiToClear();
      if (this.hideMouse) {
        this.cursorSuppressor.enableForElement(element);
      }
      await this.startRecording("element", getClampedRect(element));
      this.startCropUpdates(element);
    }

    private async captureElementScreenshot(element: Element, format: ScreenshotFormat): Promise<void> {
      try {
        this.selection?.transitionToRecording();
        await waitForSelectionUiToClear();
        await this.screenshot.capture("element", format, getClampedRect(element));
        this.reset();
        this.showToast("Screenshot saved.");
      } catch (error) {
        this.reset();
        this.showToast(error instanceof Error ? error.message : "Screenshot could not be saved.");
      }
    }

    private async startRecording(mode: RecorderMode, crop?: RectSnapshot): Promise<void> {
      try {
        this.state.set("recording");
        await this.recorder.start(mode, this.format, crop);
        this.controls?.show({
          onStop: () => this.finish(true),
          onCancel: () => this.finish(false),
          onPauseToggle: () => this.recorder.togglePause()
        });
      } catch (error) {
        this.cursorSuppressor.disable();
        this.selection?.cancel();
        this.controls?.hide();
        this.startGate?.hide();
        this.selection = undefined;
        this.controls = undefined;
        this.startGate = undefined;
        this.state.set("idle");
        this.showToast(error instanceof Error ? error.message : "Recording could not start.");
      }
    }

    private finish(save: boolean): void {
      this.recorder.voidStop(save);
      this.reset();
    }

    private reset(): void {
      this.cursorSuppressor.disable();
      this.stopCropUpdates();
      this.selection?.cancel();
      this.controls?.hide();
      this.startGate?.hide();
      this.selection = undefined;
      this.controls = undefined;
      this.startGate = undefined;
      this.state.set("idle");
      this.ui?.dispose();
      this.ui = null;
    }

    private startCropUpdates(element: Element): void {
      this.cropTarget = element;
      this.lastCropSignature = "";

      const tick = (): void => {
        if (!this.cropTarget || this.state.get() !== "recording") return;
        const rect = getClampedRect(this.cropTarget);
        const signature = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${window.innerWidth}:${window.innerHeight}`;

        if (signature !== this.lastCropSignature) {
          this.lastCropSignature = signature;
          this.recorder.updateCrop(rect);
        }

        this.cropAnimationId = requestAnimationFrame(tick);
      };

      tick();
    }

    private stopCropUpdates(): void {
      cancelAnimationFrame(this.cropAnimationId);
      this.cropAnimationId = 0;
      this.cropTarget = null;
      this.lastCropSignature = "";
    }

    private ensureUI(): ShadowUIRoot {
      this.ui?.dispose();
      this.ui = new ShadowUIRoot();
      return this.ui;
    }

    showToast(message: string): void {
      const ui = this.ensureUI();
      const toast = document.createElement("div");
      toast.className = "er-toast";
      toast.textContent = message;
      ui.root.append(toast);
      requestAnimationFrame(() => toast.classList.add("visible"));
      window.setTimeout(() => {
        toast.remove();
        this.reset();
      }, 2800);
    }
  }

  function createStyle(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #121417;
      }

      * {
        box-sizing: border-box;
      }

      .er-hover-box,
      .er-focus-ring {
        position: fixed;
        opacity: 0;
        pointer-events: none;
        border: 2px solid #1e6bff;
        background: rgb(30 107 255 / 14%);
        box-shadow: 0 0 0 1px rgb(255 255 255 / 72%), 0 8px 26px rgb(30 107 255 / 18%);
        border-radius: 6px;
        transition: opacity 120ms ease, transform 150ms ease, box-shadow 150ms ease;
        will-change: transform, width, height;
      }

      .er-hover-box.visible,
      .er-focus-ring.visible {
        opacity: 1;
      }

      .er-hover-box.locked,
      .er-focus-ring.visible {
        box-shadow: 0 0 0 1px rgb(255 255 255 / 80%), 0 14px 38px rgb(30 107 255 / 28%);
      }

      .er-focus-ring.recording {
        background: transparent;
        border-color: rgb(255 255 255 / 82%);
        box-shadow: 0 0 0 2px rgb(30 107 255 / 85%), 0 18px 60px rgb(0 0 0 / 30%);
      }

      .er-mask {
        position: fixed;
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
        will-change: transform, width, height;
      }

      .er-mask.visible {
        opacity: 1;
      }

      .er-action-bubble,
      .er-screen-start-bubble,
      .er-control-panel,
      .er-toast {
        position: fixed;
        pointer-events: auto;
        opacity: 0;
        transform: translate3d(16px, 16px, 0);
        transition: opacity 150ms ease, transform 150ms ease;
      }

      .er-action-bubble.visible,
      .er-screen-start-bubble.visible,
      .er-control-panel.visible,
      .er-toast.visible {
        opacity: 1;
      }

      .er-action-bubble,
      .er-screen-start-bubble {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px;
        border-radius: 999px;
        background: rgb(17 24 39 / 92%);
        box-shadow: 0 14px 44px rgb(0 0 0 / 30%);
        backdrop-filter: blur(18px);
      }

      .er-screen-start-bubble {
        right: 18px;
        top: 18px;
        transform: translate3d(0, -8px, 0);
      }

      .er-screen-start-bubble.visible {
        transform: translate3d(0, 0, 0);
      }

      button {
        font: inherit;
      }

      .er-pill,
      .er-stop-button,
      .er-icon-button {
        border: 0;
        cursor: pointer;
        user-select: none;
      }

      .er-pill {
        height: 34px;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 0 13px;
        border-radius: 999px;
        background: #fff;
        color: #101318;
        font-size: 13px;
      }

      .er-pill span {
        color: #ed3045;
        font-size: 13px;
      }

      .er-pill-icon.camera {
        position: relative;
        width: 17px;
        height: 13px;
        flex: 0 0 auto;
        border: 2px solid #00a884;
        border-radius: 4px;
      }

      .er-pill-icon.camera::before {
        content: "";
        position: absolute;
        left: 4px;
        top: 2px;
        width: 5px;
        height: 5px;
        border: 2px solid #00a884;
        border-radius: 50%;
      }

      .er-pill-icon.camera::after {
        content: "";
        position: absolute;
        left: 2px;
        top: -5px;
        width: 7px;
        height: 3px;
        border-radius: 3px 3px 0 0;
        background: #00a884;
      }

      .er-icon-button {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: rgb(255 255 255 / 12%);
        color: #fff;
        font-size: 20px;
        line-height: 1;
      }

      .er-icon-button:hover {
        background: rgb(255 255 255 / 22%);
      }

      .er-control-panel {
        width: 258px;
        height: 48px;
        display: grid;
        grid-template-columns: 12px 1fr 48px 34px 56px 34px;
        gap: 6px;
        align-items: center;
        padding: 7px;
        border: 1px solid rgb(255 255 255 / 18%);
        border-radius: 8px;
        background: rgb(18 20 23 / 92%);
        color: #fff;
        box-shadow: 0 16px 48px rgb(0 0 0 / 28%);
        backdrop-filter: blur(18px);
      }

      .er-drag-handle {
        width: 4px;
        height: 24px;
        border-radius: 999px;
        background: repeating-linear-gradient(to bottom, rgb(255 255 255 / 30%) 0 2px, transparent 2px 5px);
      }

      .er-rec-status {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 7px;
        font-size: 12px;
      }

      .er-rec-status span {
        width: 9px;
        height: 9px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #ff3347;
        box-shadow: 0 0 0 4px rgb(255 51 71 / 16%);
        animation: er-pulse 1.3s ease infinite;
      }

      .er-control-panel.paused .er-rec-status span {
        background: #ffb020;
        animation: none;
      }

      .er-rec-status strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        line-height: 1;
      }

      time {
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        color: rgb(255 255 255 / 82%);
      }

      .er-stop-button {
        height: 34px;
        border-radius: 999px;
        background: #fff;
        color: #111827;
        font-size: 12px;
        font-weight: 700;
      }

      .er-stop-button:hover {
        background: #f3f5f8;
      }

      .er-control-panel .er-icon-button {
        font-size: 16px;
      }

      .er-control-panel .er-icon-button.pause {
        font-size: 13px;
      }

      .er-toast {
        left: 50%;
        top: 18px;
        max-width: min(460px, calc(100vw - 32px));
        padding: 11px 14px;
        border-radius: 8px;
        background: rgb(18 20 23 / 94%);
        color: #fff;
        box-shadow: 0 12px 36px rgb(0 0 0 / 24%);
        font-size: 13px;
        line-height: 1.35;
      }

      .er-toast.visible {
        transform: translate3d(-50%, 0, 0);
      }

      @keyframes er-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .48; }
      }
    `;
    return style;
  }

  function getClampedRect(element: Element): RectSnapshot {
    const rect = element.getBoundingClientRect();
    const left = clamp(rect.left, 0, window.innerWidth);
    const top = clamp(rect.top, 0, window.innerHeight);
    const right = clamp(rect.right, 0, window.innerWidth);
    const bottom = clamp(rect.bottom, 0, window.innerHeight);

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function padRect(rect: RectSnapshot, padding: number): RectSnapshot {
    const left = clamp(rect.left - padding, 0, window.innerWidth);
    const top = clamp(rect.top - padding, 0, window.innerHeight);
    const right = clamp(rect.right + padding, 0, window.innerWidth);
    const bottom = clamp(rect.bottom + padding, 0, window.innerHeight);
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function setRectStyle(element: HTMLElement, rect: RectSnapshot): void {
    applyBox(element, rect.left, rect.top, rect.width, rect.height);
  }

  function applyBox(element: HTMLElement, left: number, top: number, width: number, height: number): void {
    element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    element.style.width = `${Math.max(0, Math.round(width))}px`;
    element.style.height = `${Math.max(0, Math.round(height))}px`;
  }

  function clamp(value: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  function toCropRect(rect: RectSnapshot): { left: number; top: number; width: number; height: number } {
    return {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      width: Math.max(2, rect.width),
      height: Math.max(2, rect.height)
    };
  }

  function getViewportSize(): { width: number; height: number } {
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight)
    };
  }

  function getMessageFormat(message: { format?: RecordingFormat }): RecordingFormat {
    return message.format === "mp4" || message.format === "gif" ? message.format : "webm";
  }

  function getMessageHideMouse(message: { hideMouse?: boolean }): boolean {
    return message.hideMouse !== false;
  }

  function getMessageScreenshotFormat(message: { screenshotFormat?: ScreenshotFormat }): ScreenshotFormat {
    if (message.screenshotFormat === "jpeg" || message.screenshotFormat === "webp") return message.screenshotFormat;
    return "png";
  }

  function waitForSelectionUiToClear(): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, 260);
    });
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

  function getBestMimeType(): string {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/webm"
    ];

    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
  }

  const controller = new RecordingController();
  new MessagingBridge(controller);
}
