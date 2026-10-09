export interface Env {
  ROOM: DurableObjectNamespace;
  /** Set with: npx wrangler secret put ANTHROPIC_API_KEY */
  ANTHROPIC_API_KEY: string;
  AI_MODEL?: string;
  /** Optional override, e.g. a Cloudflare AI Gateway URL. */
  AI_BASE_URL?: string;
}
