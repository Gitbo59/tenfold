import type { Arena } from "./arena";
import type { Quota } from "./quota";

export interface Env {
  ROOM: DurableObjectNamespace;
  /** One global instance: daily AI budget, per-IP limits, list cache and reports. */
  QUOTA: DurableObjectNamespace<Quota>;
  /** Accounts, daily challenge lists, attempts and leaderboards. */
  ARENA: DurableObjectNamespace<Arena>;
  /** Workers AI binding (the default, free provider). */
  AI: Ai;

  /** "workers-ai" (default, free), "anthropic" or "openai" (any OpenAI-compatible API). */
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  /** Secret for AI_PROVIDER=openai. */
  AI_API_KEY?: string;
  /** Secret for AI_PROVIDER=anthropic. */
  ANTHROPIC_API_KEY?: string;

  // Cost protection (all optional; see wrangler.jsonc)
  DAILY_GENERATION_CAP?: string | number;
  IP_DAILY_GENERATIONS?: string | number;
  ROOM_GENERATIONS?: string | number;
  IP_ROOMS_PER_HOUR?: string | number;
  IDLE_MINUTES?: string | number;
  /** How often an occupied room checks for idleness (default 120). */
  IDLE_CHECK_SECONDS?: string | number;
  /** Distinct reporters needed before a cached list is retired (default 2). */
  REPORT_EVICT_AFTER?: string | number;

  /** Optional secret that unlocks /api/admin/* */
  ADMIN_TOKEN?: string;

  // ---- Competitive mode ----
  /** Secret used to sign login cookies. Generate with: openssl rand -hex 32 */
  AUTH_SECRET?: string;
  /** Secret used to hash sign-in IDs. Defaults to AUTH_SECRET. Changing it signs everyone out of their account. */
  ID_PEPPER?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** Tests only: base URL of a fake OAuth provider. Never set in production. */
  OAUTH_MOCK_BASE?: string;
  /** Seconds allowed per answer in the daily challenge (default 30). */
  DAILY_TURN_SECONDS?: string | number;
  /** "easy" (default) or "hard" lists for the daily challenge. */
  DAILY_DIFFICULTY?: string;
}
