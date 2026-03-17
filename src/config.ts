import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  // Linear
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_TEAM_ID: z.string().uuid(),

  // GitHub (personal account)
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPO_OWNER: z.string().min(1),
  GITHUB_REPO_NAME: z.string().min(1),
  GITHUB_REPO_URL: z.string().url(),

  // Agent config
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  CLAUDE_CHEAP_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  MAX_CONCURRENT_TICKETS: z.coerce.number().int().min(1).default(2),
  POLL_INTERVAL_MS: z.coerce.number().int().min(10000).default(60000),
  PR_COMMENT_COOLDOWN_MS: z.coerce.number().int().default(600000),
  MAX_BUDGET_PER_TICKET_USD: z.coerce.number().min(1).default(10),
  WORKSPACE_DIR: z.string().default("/workspace"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    const result = configSchema.safeParse(process.env);
    if (!result.success) {
      console.error("Invalid configuration:", result.error.format());
      process.exit(1);
    }
    _config = result.data;
  }
  return _config;
}
