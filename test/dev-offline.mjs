// Runs the whole site on your machine with a fake AI and a fake "sign in" page, so you can preview
// changes in a browser with no accounts, keys or internet. Stop it with Ctrl+C.
import { spawn, execFileSync } from "node:child_process";
const here = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = process.env.PORT || "8787";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(process.execPath, ["test/make-test-config.mjs", "--dev"], { cwd: here, stdio: "inherit" });

const run = (cmd, args) => spawn(cmd, args, { cwd: here, stdio: "inherit", shell: process.platform === "win32" });
const procs = [
  run(process.execPath, ["test/mock-ai.mjs"]),
  run(process.execPath, ["test/mock-oauth.mjs"]),
  run(npx, ["wrangler", "dev", "-c", "wrangler.dev.jsonc", "--port", port, "--persist-to", ".wrangler-dev"]),
];
const stop = () => { for (const p of procs) { try { p.kill(); } catch { /* already gone */ } } };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
procs[2].on("exit", () => { stop(); process.exit(0); });

setTimeout(() => console.log(`
  Preview ready: http://localhost:${port}

  - Edit anything in public/ (pages, styles, scripts), save, then refresh the browser.
  - Edit anything in src/ and the server restarts by itself.
  - Sign-in shows a fake page where you type any name. Use two browser windows (one private) to be two players.
  - Every topic returns the same fake list (the NATO alphabet), so you can test the game without AI.
  - To start with a clean slate, stop this and delete the .wrangler-dev folder.
`), 6000);
