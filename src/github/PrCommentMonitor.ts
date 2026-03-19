import { GitHubApiService, PRComment } from "./GitHubApiService.js";
import { eventBus } from "../utils/eventBus.js";
import { createChildLogger } from "../utils/logger.js";
import { getConfig } from "../config.js";

const log = createChildLogger({ module: "PrCommentMonitor" });

interface MonitoredPR {
  ticketId: string;
  prNumber: number;
  lastCommentAt: Date;
  lastCheckedCommentId: number;
}

export class PrCommentMonitor {
  private github: GitHubApiService;
  private monitored = new Map<number, MonitoredPR>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(github: GitHubApiService) {
    this.github = github;
  }

  watch(ticketId: string, prNumber: number) {
    this.monitored.set(prNumber, {
      ticketId,
      prNumber,
      lastCommentAt: new Date(),
      lastCheckedCommentId: 0,
    });
    log.info({ prNumber, ticketId }, "Watching PR for comments");
  }

  unwatch(prNumber: number) {
    this.monitored.delete(prNumber);
  }

  start() {
    const interval = 60000; // Poll every 60s
    this.pollTimer = setInterval(() => this.poll(), interval);
    log.info("PR comment monitor started");
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll() {
    const config = getConfig();
    const cooldownMs = config.PR_COMMENT_COOLDOWN_MS;

    for (const [prNumber, info] of this.monitored) {
      try {
        // Check if PR was merged
        const status = await this.github.getPRStatus(prNumber);
        if (status === "merged") {
          log.info({ prNumber }, "PR merged");
          eventBus.emit("ticket:completed", { ticketId: info.ticketId });
          this.monitored.delete(prNumber);
          continue;
        }

        // Check for new comments
        const comments = await this.github.getPRComments(prNumber);
        const newComments = comments.filter(
          (c) => c.id > info.lastCheckedCommentId
        );

        if (newComments.length > 0) {
          // New comments found — update tracking but don't trigger yet.
          // Reset the cooldown timer so we wait for reviewers to finish commenting.
          const latestComment = newComments[newComments.length - 1];
          info.lastCheckedCommentId = latestComment.id;
          info.lastCommentAt = new Date(latestComment.createdAt);
          log.debug(
            { prNumber, newComments: newComments.length },
            "New comments detected, starting cooldown"
          );
          continue;
        }

        // No new comments — check if cooldown has elapsed since the last comment
        const timeSinceLastComment =
          Date.now() - info.lastCommentAt.getTime();
        if (timeSinceLastComment >= cooldownMs) {
          // Only trigger if there were comments we haven't addressed yet
          if (info.lastCheckedCommentId > 0) {
            log.info(
              { prNumber },
              "Cooldown elapsed, addressing feedback"
            );
            eventBus.emit("ticket:addressingFeedback", {
              ticketId: info.ticketId,
              prNumber,
            });
          }
        } else {
          log.debug(
            { prNumber, remainingMs: cooldownMs - timeSinceLastComment },
            "Waiting for cooldown"
          );
        }
      } catch (err) {
        log.error({ err, prNumber }, "Error checking PR");
      }
    }
  }
}
