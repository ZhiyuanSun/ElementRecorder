# Element Recorder

A Chrome Manifest V3 extension that records either the current screen/tab or a visually isolated page element as high-fidelity WebM video.

## Build

```bash
npm install
npm run build
```

Load `dist/` in Chrome at `chrome://extensions` with Developer Mode enabled.

## How It Works

- Full screen mode uses `navigator.mediaDevices.getDisplayMedia()` and `MediaRecorder`.
- Element mode never renders or captures DOM directly. It keeps the page intact, draws a four-rectangle dimming overlay with a transparent hole over the selected element, then records the native display stream.
- The generated `.webm` is auto-downloaded at the end of the recording.
