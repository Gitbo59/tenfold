// Builds wrangler.test.jsonc from the real wrangler.jsonc: same bindings and migrations, but with the
// remote-only AI binding removed, no cron, small caps and fake AI / OAuth providers on localhost.
import fs from "node:fs";
const dev = process.argv.includes("--dev"); // a config for previewing by hand: real timings, fake AI and sign-in
let s = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
s = s.replace(/\n\s*\/\/ Workers AI:[^\n]*\n\s*"ai": \{ "binding": "AI" \},\n/, "\n");
s = s.replace(/\n\s*\/\/ Builds the next few daily lists[^\n]*\n\s*"triggers": \{ "crons": \[[^\]]*\] \},\n/, "\n");
const set = (name, value) => { const re = new RegExp(`"${name}":\\s*("[^"]*"|[0-9.]+)`); if (!re.test(s)) throw new Error("missing var " + name); s = s.replace(re, `"${name}": ${JSON.stringify(value)}`); };
set("AI_PROVIDER", "openai"); set("AI_MODEL", "mock-model");
if (dev) {
  set("RANKED_LADDER_MIN_GAMES", 1); // so you appear on the ladder after one match
} else {
  set("DAILY_GENERATION_CAP", 22); set("IP_DAILY_GENERATIONS", 20); set("ROOM_GENERATIONS", 4); set("IP_ROOMS_PER_HOUR", 25);
  set("DAILY_TURN_SECONDS", 4);
  set("RANKED_JOIN_SECONDS", 4); set("RANKED_FORFEIT_SECONDS", 3); set("RANKED_WIDEN_PER_SEC", 400); set("RANKED_LADDER_MIN_GAMES", 1);
}
s = s.replace('"vars": {', '"vars": {\n    "AI_BASE_URL": "http://127.0.0.1:9999", "AI_API_KEY": "test-key", "ADMIN_TOKEN": "admintok", "REPORT_EVICT_AFTER": 1,\n    "AUTH_SECRET": "test-auth-secret-0123456789", "OAUTH_MOCK_BASE": "http://127.0.0.1:9998",');
if (/"ai":/.test(s) || /triggers/.test(s)) throw new Error("test config still has ai binding or cron");
if (dev) s = s.replace('"vars": {', '"vars": {\n    "NAME_CHANGE_DAYS": 0,'); // rename as often as you like while experimenting
fs.writeFileSync(new URL(dev ? "../wrangler.dev.jsonc" : "../wrangler.test.jsonc", import.meta.url), s);
