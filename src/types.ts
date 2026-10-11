import type { Quota } from "./quota";

export interface Env {
  ROOM: DurableObjectNamespace;
  /** One global instance: daily AI budget, per-IP limits, list cache and reports. */
  QUOTA: DurableObjectNamespace<Quota>;
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
}
