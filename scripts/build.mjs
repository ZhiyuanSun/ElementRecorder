import { mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import "./generate-icons.mjs";

const root = process.cwd();
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    "background/service-worker": "src/background/service-worker.ts",
    "content/content-script": "src/content/content-script.ts",
    "offscreen/offscreen": "src/offscreen/offscreen.ts",
    "popup/popup": "src/popup/popup.ts"
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  sourcemap: false,
  minify: true,
  legalComments: "none"
});

await mkdir(join(dist, "popup"), { recursive: true });
await mkdir(join(dist, "offscreen"), { recursive: true });
await mkdir(join(dist, "icons"), { recursive: true });
await copyFile("src/manifest.json", join(dist, "manifest.json"));
await copyFile("src/popup/popup.html", join(dist, "popup/popup.html"));
await copyFile("src/popup/popup.css", join(dist, "popup/popup.css"));
await copyFile("src/offscreen/offscreen.html", join(dist, "offscreen/offscreen.html"));
await copyFile("src/icons/icon-16.png", join(dist, "icons/icon-16.png"));
await copyFile("src/icons/icon-32.png", join(dist, "icons/icon-32.png"));
await copyFile("src/icons/icon-48.png", join(dist, "icons/icon-48.png"));
await copyFile("src/icons/icon-128.png", join(dist, "icons/icon-128.png"));

console.log("Built Chrome extension in dist/");
