import { LinearClient } from "@linear/sdk";
import { getConfig } from "../config.js";
import { eventBus } from "../utils/eventBus.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger({ module: "LinearPoller" });
const TRIGGER = "@odin implement";

export interface DiscoveredTicket {
  ticketId: string;
  identifier: string;
  title: string;
  description: string;
  commentId: string;
}

export class LinearPoller {
  private client: LinearClient;
  private teamId: string;
  private polling = false;
  private knownTicketIds = new Set<string>();

  constructor() {
    const config = getConfig();
    this.client = new LinearClient({ apiKey: config.LINEAR_API_KEY });
    this.teamId = config.LINEAR_TEAM_ID;
  }

  start(intervalMs: number) {
    this.polling = true;
    log.info({ intervalMs }, "Linear poller started");
    this.poll();
    const timer = setInterval(() => this.poll(), intervalMs);
    return () => {
      this.polling = false;
      clearInterval(timer);
    };
  }

  private async poll() {
    if (!this.polling) return;

    try {
      const team = await this.client.team(this.teamId);
      const issues = await team.issues({
        filter: {
          state: {
            type: { in: ["backlog", "unstarted", "started"] },
          },
        },
      });

      for (const issue of issues.nodes) {
        if (this.knownTicketIds.has(issue.id)) continue;

        const comments = await issue.comments();
        const triggerComment = comments.nodes.find(
          (c) => c.body?.trim().toLowerCase() === TRIGGER
        );

        if (triggerComment) {
          this.knownTicketIds.add(issue.id);
          log.info(
            { ticketId: issue.id, identifier: issue.identifier, title: issue.title },
            "Found @odin implement trigger"
          );

          eventBus.emit("ticket:new", {
            ticketId: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            commentId: triggerComment.id,
          });
        }
      }
    } catch (err) {
      log.error({ err }, "Error polling Linear");
    }
  }

  async getTicketDetails(ticketId: string): Promise<DiscoveredTicket | null> {
    try {
      const issue = await this.client.issue(ticketId);
      const comments = await issue.comments();
      const triggerComment = comments.nodes.find(
        (c) => c.body?.trim().toLowerCase() === TRIGGER
      );

      return {
        ticketId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? "",
        commentId: triggerComment?.id ?? "",
      };
    } catch (err) {
      log.error({ err, ticketId }, "Failed to get ticket details");
      return null;
    }
  }

  releaseTicket(ticketId: string) {
    this.knownTicketIds.delete(ticketId);
  }
}
