// Builds the Vercel deployment with the Build Output API (.vercel/output):
//   static/                 web/ (landing page, app page and its bundle, images)
//   functions/index.func/   the whole app bundled into one Node function
//   config.json             / → index.html, /app → app.html, static files first, everything else → the function
// Run by Vercel through vercel.json ("buildCommand"); locally: npm run build:vercel
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const out = ".vercel/output";
const fn = `${out}/functions/index.func`;
rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

cpSync("web", `${out}/static`, { recursive: true });

await build({
  entryPoints: ["src/app/vercel.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: `${fn}/index.js`,
  logLevel: "warning",
  // server.ts only uses import.meta.url as a fallback when no webDir is given (vercel.ts gives one).
  define: { "import.meta.url": JSON.stringify("file:///var/task/src/app/server.js") },
  // Vercel's Node launcher calls the module's export as (req, res).
  footer: { js: "module.exports = module.exports.default || module.exports;" },
});
if (existsSync("testnet.json")) cpSync("testnet.json", `${fn}/testnet.json`);
// The bundle is CommonJS; without this, the repo's "type": "module" would make Node load it as ESM.
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: "commonjs" }));

writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/$", dest: "/index.html" },
        { src: "^/app/?$", dest: "/app.html" },
        { src: "^/play/?$", dest: "/play.html" },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index" },
      ],
    },
    null,
    2,
  ),
);
console.log(`Built ${out}`);
