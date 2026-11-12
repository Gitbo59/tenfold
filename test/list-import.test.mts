import { importListUrl, parseRankingPage } from "../src/list-import.ts";

let failures = 0;
const ok = (condition: boolean, message: string) => { console.log(condition ? "  PASS" : "  FAIL", message); if (!condition) failures++; };
const table = `<table><tr><th>Rank</th><th>Country</th></tr>${Array.from({ length: 10 }, (_, i) => `<tr><td>${i + 1}</td><td><a href="#">Country ${i + 1}</a><sup>[${i + 1}]</sup></td></tr>`).join("")}</table>`;
const page = `<html><head><title>Country rankings - Example</title></head><body><h1>Top countries</h1>${table}</body></html>`;

console.log("list page parsing");
const parsed = parseRankingPage(page, new URL("https://lists.example/countries"));
ok(parsed.title === "Top countries" && parsed.answers.length === 10, "imports the heading and top ten rows");
ok(parsed.answers[0].answer === "Country 1" && parsed.answers[9].answer === "Country 10", "preserves ranking order and removes footnotes");
const ordered = parseRankingPage(`<h1>Ten items</h1><ol>${Array.from({ length: 10 }, (_, i) => `<li>Item ${i + 1}</li>`).join("")}</ol>`, new URL("https://lists.example/items"));
ok(ordered.answers.length === 10 && ordered.answers[0].answer === "Item 1", "imports ordered lists without a ranking table");
let badPage = false;
try { parseRankingPage("<html><title>Not a list</title></html>", new URL("https://lists.example/")); } catch { badPage = true; }
ok(badPage, "rejects pages without a usable ten-item list");

console.log("URL fetch restrictions");
let invalidUrl = false;
try { await importListUrl("http://lists.example/ranking"); } catch (error) { invalidUrl = /HTTPS/.test(String(error)); }
ok(invalidUrl, "requires HTTPS");
let localUrl = false;
try { await importListUrl("https://127.0.0.1/private"); } catch (error) { localUrl = /public HTTPS/.test(String(error)); }
ok(localUrl, "rejects local and IP-address targets");

const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input) => {
  calls++;
  return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};
try {
  const imported = await importListUrl("https://lists.example/ranking");
  ok(calls === 1 && imported.answers.length === 10 && imported.source === "https://lists.example/ranking", "fetches and imports a public HTTPS list page");
} finally {
  globalThis.fetch = originalFetch;
}

calls = 0;
globalThis.fetch = async (input) => {
  calls++;
  return String(input).endsWith("/start")
    ? new Response(null, { status: 302, headers: { location: "/final" } })
    : new Response(page, { status: 200, headers: { "content-type": "text/html" } });
};
try {
  const redirected = await importListUrl("https://lists.example/start");
  ok(calls === 2 && redirected.source === "https://lists.example/final", "follows a same-host redirect");
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://other.example/ranking" } });
let crossHost = false;
try { await importListUrl("https://lists.example/start"); } catch (error) { crossHost = /same website/.test(String(error)); }
finally { globalThis.fetch = originalFetch; }
ok(crossHost, "refuses redirects to another host");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nLIST IMPORT CHECKS PASSED");
process.exit(failures ? 1 : 0);
