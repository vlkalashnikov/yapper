const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  // vscode is provided by the runtime, never bundle it. The rest are Baileys'
  // optional media/thumbnail peers — unused in the text-only WhatsApp provider,
  // so they are left external (never required at runtime) to keep the bundle lean.
  external: [
    "vscode",
    "sharp",
    "jimp",
    "link-preview-js",
    "qrcode-terminal",
    "audio-decode",
  ],
  sourcemap: !production,
  minify: production,
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
