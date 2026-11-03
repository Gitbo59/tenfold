import type { TopTen } from "./ai";
import type { Answer } from "./match";

const MAX_HTML_BYTES = 1_000_000;

function publicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid HTTPS URL for a public list page.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.startsWith("[")
  ) {
    throw new Error("Use a public HTTPS webpage (not a local or private address).");
  }
  return url;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|rsquo|lsquo|rdquo|ldquo);/gi, (entity, value: string) => {
    if (value[0] === "#") {
      const code = value[1].toLowerCase() === "x" ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" })[value.toLowerCase()] ?? " ";
  });
}

function textContent(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|sup|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|td|th)>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]{1,8}\]/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return textContent(value).replace(/\s*[|–-]\s*(Wikipedia|Wikidata).*$/i, "").slice(0, 100).trim();
}

function tableAnswers(html: string): Answer[] | null {
  const tables = html.match(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi) ?? [];
  for (const table of tables) {
    const rows = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) ?? [];
    if (rows.length < 11) continue;
    const cells = rows.map((row) => {
      const result: { tag: string; text: string }[] = [];
      const re = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
      for (let match = re.exec(row); match; match = re.exec(row)) result.push({ tag: match[1].toLowerCase(), text: textContent(match[2]) });
      return result;
    }).filter((row) => row.length >= 2);
    if (cells.length < 11) continue;

    const header = cells[0];
    if (!header.some((cell) => cell.tag === "th")) continue;
    const rankIndex = header.findIndex((cell) => /^(#|rank|ranking|no\.?|number|position|place)$/i.test(cell.text));
    if (rankIndex < 0) continue;
    const nameIndex = header.findIndex((cell, index) => index !== rankIndex && /name|country|player|team|title|item|city|artist|company|brand|club|location|entity|film|book/i.test(cell.text));
    const answerIndex = nameIndex >= 0 ? nameIndex : header.findIndex((_, index) => index !== rankIndex);
    if (answerIndex < 0) continue;

    const ranked = cells.slice(1).map((row, index) => {
      const rankText = row[rankIndex]?.text ?? "";
      const rank = Number.parseInt(rankText.replace(/[^\d]/g, ""), 10);
      const answer = row[answerIndex]?.text ?? "";
      return { rank: Number.isFinite(rank) ? rank : index + 1, answer };
    }).filter((row) => row.answer.length > 0);
    const answers = ranked
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 10)
      .map(({ answer }) => ({ answer, aliases: [] }));
    if (answers.length === 10 && new Set(answers.map((answer) => answer.answer.toLowerCase())).size === 10) return answers;
  }
  return null;
}

function orderedListAnswers(html: string): Answer[] | null {
  const lists = html.match(/<ol\b[^>]*>[\s\S]*?<\/ol\s*>/gi) ?? [];
  for (const list of lists) {
    const items = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)]
      .map((match) => textContent(match[1]))
      .filter(Boolean)
      .slice(0, 10);
    if (items.length === 10 && new Set(items.map((item) => item.toLowerCase())).size === 10) {
      return items.map((answer) => ({ answer, aliases: [] }));
    }
  }
  return null;
}

export function parseRankingPage(html: string, url: URL): TopTen {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const headingMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const title = cleanTitle(headingMatch?.[1] ?? titleMatch?.[1] ?? url.pathname.split("/").filter(Boolean).at(-1)?.replace(/_/g, " ") ?? "");
  const answers = tableAnswers(html) ?? orderedListAnswers(html);
  if (!answers) throw new Error("Couldn't find a ranked table or ordered list with ten distinct answers at that URL.");
  if (answers.some((answer) => answer.answer.length > 60)) throw new Error("That page has list entries that are too long to use in a game.");
  return {
    title: title || "Imported top ten",
    basis: "Order shown on the linked webpage",
    source: url.toString(),
    answers,
  };
}

async function readHtml(response: Response): Promise<string> {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
    throw new Error("That URL didn't return an HTML webpage.");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_HTML_BYTES) throw new Error("That webpage is too large to import.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error("That webpage is too large to import.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function importListUrl(raw: string): Promise<TopTen> {
  let url = publicHttpsUrl(raw);
  const originalHost = url.hostname.toLowerCase();
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects++) {
    try {
      response = await fetch(url, {
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Tenfold-List-Importer/1.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("Loading that webpage took too long. Try another list URL.");
      throw new Error("Couldn't load that list page. Check the URL and try again.");
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirects === 3) throw new Error("That list page redirected too many times.");
    url = publicHttpsUrl(new URL(location, url).toString());
    if (url.hostname.toLowerCase() !== originalHost) throw new Error("For safety, list page redirects must stay on the same website.");
  }
  if (!response || !response.ok) throw new Error(`Couldn't load that list page${response ? ` (HTTP ${response.status})` : ""}.`);
  const html = await readHtml(response);
  if (!html) throw new Error("That webpage was empty.");
  return parseRankingPage(html, url);
}
