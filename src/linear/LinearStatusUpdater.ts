import { LinearClient } from "@linear/sdk";
import { getConfig } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger({ module: "LinearStatusUpdater" });

type StatusName = "In Progress" | "Ready for Review" | "QA" | "Done";

export class LinearStatusUpdater {
  private client: LinearClient;
  private teamId: string;
  private stateCache = new Map<string, string>();

  constructor() {
    const config = getConfig();
    this.client = new LinearClient({ apiKey: config.LINEAR_API_KEY });
    this.teamId = config.LINEAR_TEAM_ID;
  }

  private async getStateId(name: StatusName): Promise<string> {
    if (this.stateCache.has(name)) return this.stateCache.get(name)!;

    const team = await this.client.team(this.teamId);
    const states = await team.states();
    const state = states.nodes.find((s) => s.name === name);

    if (!state) {
      throw new Error(
        `Workflow state "${name}" not found. Available: ${states.nodes.map((s) => s.name).join(", ")}`
      );
    }

    this.stateCache.set(name, state.id);
    return state.id;
  }

  async moveToInProgress(ticketId: string) {
    const stateId = await this.getStateId("In Progress");
    await this.client.updateIssue(ticketId, { stateId });
    log.info({ ticketId }, "Moved to In Progress");
  }

  async moveToInReview(ticketId: string) {
    const stateId = await this.getStateId("Ready for Review");
    await this.client.updateIssue(ticketId, { stateId });
    log.info({ ticketId }, "Moved to Ready for Review");
  }

  async moveToQA(ticketId: string) {
    const stateId = await this.getStateId("QA");
    await this.client.updateIssue(ticketId, { stateId });
    log.info({ ticketId }, "Moved to QA");
  }

  async removeTriggerComment(commentId: string) {
    try {
      await this.client.deleteComment(commentId);
      log.info({ commentId }, "Removed @odin implement comment");
    } catch (err) {
      log.warn({ err, commentId }, "Failed to remove trigger comment");
    }
  }

  async addComment(ticketId: string, body: string) {
    await this.client.createComment({ issueId: ticketId, body });
    log.info({ ticketId }, "Added comment to ticket");
  }
}
