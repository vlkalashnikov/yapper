const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  // vscode is provided by the runtime, never bundle it. The rest are optional
  // native/media peers of Baileys (WhatsApp) and discord.js-selfbot (Discord) —
  // voice/thumbnail features we don't use in the text-first providers. Left
  // external (never required at runtime) to keep the bundle lean and avoid
  // bundling native .node bindings.
  external: [
    "vscode",
    // Baileys optional peers
    "sharp",
    "jimp",
    "link-preview-js",
    "qrcode-terminal",
    "audio-decode",
    // discord.js-selfbot voice/native peers (unused — text-first)
    "ffmpeg-static",
    "@snazzah/davey",
    "@discordjs/opus",
    "opusscript",
    "node-opus",
    "sodium-native",
    "sodium",
    "libsodium-wrappers",
    "tweetnacl",
    "zlib-sync",
  ],
  sourcemap: !production,
  minify: production,
  // discord.js registers gateway actions by `Class.name` (e.g. ThreadListSync),
  // so minifying class names breaks the dispatch (crashes on THREAD_LIST_SYNC).
  // keepNames preserves runtime .name through minification.
  keepNames: true,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build complete");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
