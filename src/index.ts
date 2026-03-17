import { getConfig } from "./config.js";
import { Orchestrator } from "./orchestrator/Orchestrator.js";
import { createChildLogger } from "./utils/logger.js";

const log = createChildLogger({ module: "main" });

async function main() {
  const config = getConfig();
  log.info(
    {
      team: config.LINEAR_TEAM_ID,
      repo: `${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}`,
      cheapModel: config.CLAUDE_CHEAP_MODEL,
      standardModel: config.CLAUDE_MODEL,
      maxConcurrent: config.MAX_CONCURRENT_TICKETS,
      pollInterval: config.POLL_INTERVAL_MS,
    },
    "Odin starting up"
  );

  const orchestrator = new Orchestrator();

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await orchestrator.start();
  log.info("Odin is running. Watching for @odin implement comments...");
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});
