import { generateTopTen, AiError, DEFAULT_MODEL } from "../src/ai.ts";
let failures = 0;
const ok = (c: boolean, m: string) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };

const names = ["Alpha","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India","Juliet","Kilo","Lima"];
const list = (n: number) => ({ title: "NATO", basis: "Order", source: "Wikipedia: NATO phonetic alphabet", answers: names.slice(0, n).map((a) => ({ answer: a, aliases: ["x"], detail: "d" })) });

function harness(outputs: any[]) {
  const calls: any[] = []; let reserves = 0, refunds = 0; let i = 0;
  const env: any = { AI: { run: async (model: string, body: any) => { calls.push({ model, body }); const o = outputs[Math.min(i++, outputs.length - 1)]; if (o instanceof Error) throw o; return o; } } };
  const hooks = { reserve: async () => { reserves++; }, refund: async () => { refunds++; } };
  return { env, hooks, calls, counts: () => ({ reserves, refunds }) };
}
const fail = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as AiError; } };

console.log("Workers AI path");
{
  const h = harness([{ response: list(10) }]);
  const r = await generateTopTen(h.env, "capitals", "hard", h.hooks);
  const c = h.calls[0];
  ok(r.answers.length === 10 && r.source.startsWith("Wikipedia"), "object response parsed (source kept)");
  ok(c.model === DEFAULT_MODEL && c.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "default model is Llama 3.3 70B fp8 fast");
  ok(c.body.response_format.type === "json_schema" && c.body.max_tokens === 1200, "JSON-schema mode and 1,200-token ceiling");
  ok(/Difficulty HARD/.test(c.body.messages[0].content) && /Difficulty: HARD/.test(c.body.messages[1].content) && /Topic: capitals/.test(c.body.messages[1].content), "difficulty and topic reach the prompt");
  ok(h.counts().reserves === 1 && h.counts().refunds === 0, "one request reserved, nothing refunded");
}
{ const h = harness([{ response: list(10) }]); await generateTopTen(h.env, "t", "easy", h.hooks); ok(/Difficulty EASY/.test(h.calls[0].body.messages[0].content) && !/Difficulty HARD/.test(h.calls[0].body.messages[0].content), "easy prompt contains only the easy note"); }
{ const h = harness([{ response: "```json\n" + JSON.stringify(list(10)) + "\n```" }]); const r = await generateTopTen(h.env, "t", "easy", h.hooks); ok(r.answers.length === 10, "string response with markdown fences parsed"); }
{ const h = harness([{ response: "Sure! Here you go: " + JSON.stringify(list(10)) + " Hope that helps." }]); const r = await generateTopTen(h.env, "t", "easy", h.hooks); ok(r.answers.length === 10, "JSON embedded in chatter parsed"); }
{ const h = harness([{ choices: [{ message: { content: JSON.stringify(list(10)) } }] }]); const r = await generateTopTen(h.env, "t", "easy", h.hooks); ok(r.answers.length === 10, "OpenAI-style response body parsed"); }
{ const h = harness([{ response: list(12) }]); const r = await generateTopTen(h.env, "t", "easy", h.hooks); ok(r.answers.length === 10 && r.answers[9].answer === "Juliet", "12 answers trimmed to the top 10"); }
{ const dup = list(10); dup.answers[3].answer = "alpha"; const h = harness([{ response: dup }, { response: list(10) }]); const r = await generateTopTen(h.env, "t", "easy", h.hooks); ok(h.counts().reserves === 2 && r.answers.length === 10, "duplicate answers leave <10, so it retries (2 requests reserved)"); }
{ const h = harness([{ response: list(6) }, { response: list(6) }, { response: list(10) }]); const e = await fail(generateTopTen(h.env, "t", "easy", h.hooks)); ok(e instanceof AiError && /incomplete/.test(e.userMessage) && h.counts().reserves === 2 && h.calls.length === 2, "gives up after one retry; never more than 2 model calls per list"); }
{ const h = harness([{ response: { title: "x", basis: "", source: "", rejection_reason: "Not suitable.", answers: [] } }]); const e = await fail(generateTopTen(h.env, "t", "easy", h.hooks)); ok(e instanceof AiError && /can't be used: Not suitable/.test(e.userMessage) && h.counts().reserves === 1, "rejected topic: friendly message, no retry"); }
{ const h = harness([new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons")]); const e = await fail(generateTopTen(h.env, "t", "easy", h.hooks)); ok(e instanceof AiError && e.opts.budget === true && /allowance/.test(e.userMessage) && h.counts().refunds === 1, "Workers AI daily-allowance error: friendly message, flagged as budget, refunded"); }
{ const h = harness([new Error("503 service unavailable")]); const e = await fail(generateTopTen(h.env, "t", "easy", h.hooks)); ok(e instanceof AiError && !e.opts.budget && /didn't respond/.test(e.userMessage) && h.counts().refunds === 1 && !/503/.test(e.userMessage), "other binding error: refunded; raw error text not shown to players"); }
{ const h = harness([{ response: list(10) }]); const hooks = { reserve: async () => { throw new AiError("cap", "cap", { budget: true }); }, refund: async () => {} }; const e = await fail(generateTopTen(h.env, "t", "easy", hooks)); ok(e instanceof AiError && e.opts.budget === true && h.calls.length === 0, "when the budget says no, the model is never called"); }
{ const env: any = {}; const h = harness([]); const e = await fail(generateTopTen(env, "t", "easy", h.hooks)); ok(e instanceof AiError && /no Workers AI binding/.test(e.userMessage), "missing AI binding is reported clearly"); }

console.log("Other providers still work");
{
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => { (globalThis as any).__last = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(list(10)) } }] }), { status: 200 }); };
  const h = harness([]); const env: any = { AI_PROVIDER: "openai", AI_BASE_URL: "https://api.example.com/v1/", AI_API_KEY: "k", AI_MODEL: "m" };
  const r = await generateTopTen(env, "t", "easy", h.hooks);
  const last = (globalThis as any).__last;
  ok(r.answers.length === 10 && last.url === "https://api.example.com/v1/chat/completions" && last.init.headers.authorization === "Bearer k", "openai-compatible provider hits /chat/completions with a bearer key");
  (globalThis as any).fetch = async () => new Response("rate limited", { status: 429 });
  const e = await fail(generateTopTen(env, "t", "easy", h.hooks)); ok(e instanceof AiError && e.opts.budget === true, "HTTP 429 from a provider is treated as a budget failure");
  (globalThis as any).fetch = orig;
  const e2 = await fail(generateTopTen({ AI_PROVIDER: "nope" } as any, "t", "easy", h.hooks)); ok(e2 instanceof AiError && /unknown AI provider/.test(e2.userMessage), "unknown provider rejected");
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAI MODULE CHECKS PASSED");
process.exit(failures ? 1 : 0);
