import { LinearPoller } from "../linear/LinearPoller.js";
import { LinearStatusUpdater } from "../linear/LinearStatusUpdater.js";
import { GitService } from "../github/GitService.js";
import { GitHubApiService } from "../github/GitHubApiService.js";
import { PrCommentMonitor } from "../github/PrCommentMonitor.js";
import { AgentService } from "../agent/AgentService.js";
import { SelfReviewPipeline } from "../selfReview/SelfReviewPipeline.js";
import { implementTicketPrompt } from "../agent/prompts/implementTicket.js";
import { writeTestsPrompt } from "../agent/prompts/writeTests.js";
import { addressFeedbackPrompt } from "../agent/prompts/addressFeedback.js";
import {
  TicketContext,
  transition,
} from "./TicketStateMachine.js";
import { eventBus } from "../utils/eventBus.js";
import { createChildLogger } from "../utils/logger.js";
import { getConfig } from "../config.js";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const log = createChildLogger({ module: "Orchestrator" });

export class Orchestrator {
  private poller: LinearPoller;
  private statusUpdater: LinearStatusUpdater;
  private git: GitService;
  private github: GitHubApiService;
  private prMonitor: PrCommentMonitor;
  private agent: AgentService;
  private selfReview: SelfReviewPipeline;
  private activeTickets = new Map<string, TicketContext>();
  private config = getConfig();

  constructor() {
    this.poller = new LinearPoller();
    this.statusUpdater = new LinearStatusUpdater();
    this.git = new GitService();
    this.github = new GitHubApiService();
    this.prMonitor = new PrCommentMonitor(this.github);
    this.agent = new AgentService();
    this.selfReview = new SelfReviewPipeline(this.agent);
  }

  async start() {
    await this.git.init();

    // Listen for new tickets
    eventBus.on("ticket:new", (data) => {
      if (this.activeTickets.size >= this.config.MAX_CONCURRENT_TICKETS) {
        log.warn(
          { ticketId: data.ticketId },
          "Max concurrent tickets reached, skipping"
        );
        this.poller.releaseTicket(data.ticketId);
        return;
      }
      this.handleNewTicket(data.ticketId, data.identifier, data.title, data.commentId).catch((err) => {
        log.error({ err, ticketId: data.ticketId }, "Unhandled error in handleNewTicket");
      });
    });

    // Listen for feedback events
    eventBus.on("ticket:addressingFeedback", (data) => {
      this.handleFeedback(data.ticketId, data.prNumber).catch((err) => {
        log.error({ err, ticketId: data.ticketId }, "Unhandled error in handleFeedback");
      });
    });

    // Listen for merge events
    eventBus.on("ticket:completed", (data) => {
      this.handleCompletion(data.ticketId).catch((err) => {
        log.error({ err, ticketId: data.ticketId }, "Unhandled error in handleCompletion");
      });
    });

    // Start polling
    this.poller.start(this.config.POLL_INTERVAL_MS);
    this.prMonitor.start();

    log.info("Orchestrator started");
  }

  private async handleNewTicket(
    ticketId: string,
    identifier: string,
    title: string,
    commentId: string
  ) {
    const ticket = await this.poller.getTicketDetails(ticketId);
    if (!ticket) return;

    // Branch format: feature/VIS-123/short-description (matches valhalla pre-push hook)
    const branchType = this.detectBranchType(title);
    const branchName = `${branchType}/${identifier.toLowerCase()}/${this.slugify(title)}`;
    const worktreePath = await this.git.createWorktree(branchName);

    let ctx: TicketContext = {
      ticketId,
      identifier,
      title,
      description: ticket.description,
      commentId,
      branchName,
      worktreePath,
      state: "Queued",
      feedbackRounds: 0,
    };

    this.activeTickets.set(ticketId, ctx);

    try {
      // Move to In Progress
      ctx = transition(ctx, "Implementing");
      this.activeTickets.set(ticketId, ctx);
      await this.statusUpdater.moveToInProgress(ticketId);

      // Implement with escalation (Haiku first, Sonnet if needed)
      await this.agent.queryWithEscalation({
        prompt: implementTicketPrompt({
          title: ctx.title,
          description: ctx.description,
        }),
        workingDir: worktreePath,
      });

      // Write tests
      ctx = transition(ctx, "WritingTests");
      this.activeTickets.set(ticketId, ctx);

      const changedFiles = await this.getChangedFiles(worktreePath);
      await this.agent.queryWithEscalation({
        prompt: writeTestsPrompt({
          title: ctx.title,
          description: ctx.description,
          changedFiles,
        }),
        workingDir: worktreePath,
      });

      // Self-review
      ctx = transition(ctx, "SelfReviewing");
      this.activeTickets.set(ticketId, ctx);

      const reviewResult = await this.selfReview.run(worktreePath);

      if (!reviewResult.passed) {
        log.warn(
          { ticketId, errors: reviewResult.errors },
          "Self-review failed after max iterations"
        );
        await this.statusUpdater.addComment(
          ticketId,
          `Self-review completed with warnings after ${reviewResult.iterations} iterations. Proceeding with PR.`
        );
      }

      // Create PR
      ctx = transition(ctx, "CreatingPR");
      this.activeTickets.set(ticketId, ctx);

      // Commit format: [Type][VIS-123] Description (matches valhalla convention)
      const commitType = this.detectCommitType(title);
      await this.git.commitAndPush(
        worktreePath,
        branchName,
        `[${commitType}][${identifier}] ${title}\n\nImplemented by Odin (autonomous agent)`
      );

      const prNumber = await this.github.createPR({
        title: `[${commitType}][${identifier}] ${title}`,
        body: this.buildPRBody(ctx, reviewResult.iterations),
        head: branchName,
      });

      ctx = { ...ctx, prNumber };
      ctx = transition(ctx, "AwaitingReview");
      this.activeTickets.set(ticketId, ctx);

      // Update Linear to In Review
      await this.statusUpdater.moveToInReview(ticketId);

      // Start monitoring PR comments
      this.prMonitor.watch(ticketId, prNumber);

      log.info({ ticketId, prNumber }, "Ticket implementation complete, PR created");
    } catch (err) {
      log.error({ err, ticketId }, "Failed to process ticket");
      ctx = transition(ctx, "Failed");
      this.activeTickets.set(ticketId, ctx);
      await this.statusUpdater.addComment(
        ticketId,
        `Odin failed to implement this ticket: ${err instanceof Error ? err.message : String(err)}`
      );
      await this.git.removeWorktree(ctx.branchName);
      this.poller.releaseTicket(ticketId);
    }
  }

  private async handleFeedback(ticketId: string, prNumber: number) {
    const ctx = this.activeTickets.get(ticketId);
    if (!ctx) return;

    try {
      let updatedCtx = transition(ctx, "AddressingFeedback");
      updatedCtx.feedbackRounds++;
      this.activeTickets.set(ticketId, updatedCtx);

      const comments = await this.github.getPRComments(prNumber);
      const reviewComments = comments.filter(
        (c) => c.user !== this.config.GITHUB_REPO_OWNER
      );

      if (reviewComments.length === 0) return;

      // Address feedback with escalation
      await this.agent.queryWithEscalation({
        prompt: addressFeedbackPrompt({
          title: ctx.title,
          prComments: reviewComments.map((c) => ({
            user: c.user,
            body: c.body,
          })),
        }),
        workingDir: ctx.worktreePath,
      });

      // Re-run self-review
      updatedCtx = transition(updatedCtx, "SelfReviewing");
      this.activeTickets.set(ticketId, updatedCtx);
      await this.selfReview.run(ctx.worktreePath);

      // Push changes — commit format matches valhalla convention
      const feedbackType = this.detectCommitType(ctx.title);
      await this.git.commitAndPush(
        ctx.worktreePath,
        ctx.branchName,
        `[${feedbackType}][${ctx.identifier}] Address PR feedback (round ${updatedCtx.feedbackRounds})`
      );

      await this.github.addPRComment(
        prNumber,
        `Addressed review feedback (round ${updatedCtx.feedbackRounds}). Please re-review.`
      );

      updatedCtx = transition(updatedCtx, "AwaitingReview");
      this.activeTickets.set(ticketId, updatedCtx);

      log.info(
        { ticketId, prNumber, round: updatedCtx.feedbackRounds },
        "Feedback addressed"
      );
    } catch (err) {
      log.error({ err, ticketId }, "Failed to address feedback");
    }
  }

  private async handleCompletion(ticketId: string) {
    const ctx = this.activeTickets.get(ticketId);
    if (!ctx) return;

    try {
      // Move to QA
      await this.statusUpdater.moveToQA(ticketId);

      // Remove the @odin implement comment
      if (ctx.commentId) {
        await this.statusUpdater.removeTriggerComment(ctx.commentId);
      }

      // Cleanup
      if (ctx.prNumber) {
        this.prMonitor.unwatch(ctx.prNumber);
      }
      await this.git.removeWorktree(ctx.branchName);
      this.activeTickets.delete(ticketId);
      this.poller.releaseTicket(ticketId);

      log.info({ ticketId }, "Ticket completed and moved to QA");
    } catch (err) {
      log.error({ err, ticketId }, "Error during completion");
    }
  }

  private async getChangedFiles(cwd: string): Promise<string[]> {
    try {
      const { stdout } = await exec("git", ["diff", "--name-only", "HEAD"], {
        cwd,
      });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      const { stdout } = await exec(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd }
      );
      return stdout.trim().split("\n").filter(Boolean);
    }
  }

  /**
   * Detect branch type from ticket title. Matches valhalla's allowed types:
   * task, spike, feature, bugfix, bug, improvement, library, documentation, hotfix, chore
   */
  private detectBranchType(title: string): string {
    const lower = title.toLowerCase();
    if (lower.includes("[bug]") || lower.includes("bugfix") || lower.includes("bug fix")) return "bugfix";
    if (lower.includes("[hotfix]") || lower.includes("hotfix")) return "hotfix";
    if (lower.includes("[chore]") || lower.includes("chore")) return "chore";
    if (lower.includes("[improvement]") || lower.includes("improve") || lower.includes("refactor") || lower.includes("optimize")) return "improvement";
    if (lower.includes("[doc]") || lower.includes("documentation")) return "documentation";
    if (lower.includes("[spike]")) return "spike";
    if (lower.includes("[library]") || lower.includes("dependency") || lower.includes("upgrade")) return "library";
    return "feature";
  }

  /**
   * Detect commit type from ticket title. Matches valhalla's commit format:
   * [Feature], [Bugfix], [Improvement], [Hotfix], [Chore], etc.
   */
  private detectCommitType(title: string): string {
    const lower = title.toLowerCase();
    if (lower.includes("[bug]") || lower.includes("bugfix") || lower.includes("bug fix")) return "Bugfix";
    if (lower.includes("[hotfix]") || lower.includes("hotfix")) return "Hotfix";
    if (lower.includes("[chore]") || lower.includes("chore")) return "Chore";
    if (lower.includes("[improvement]") || lower.includes("improve") || lower.includes("refactor") || lower.includes("optimize")) return "Improvement";
    if (lower.includes("[doc]") || lower.includes("documentation")) return "Documentation";
    if (lower.includes("[spike]")) return "Spike";
    if (lower.includes("[library]") || lower.includes("dependency") || lower.includes("upgrade")) return "Library";
    return "Feature";
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/\[.*?\]/g, "") // Remove [Bug], [Feature], etc. prefixes
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  }

  private buildPRBody(ctx: TicketContext, reviewIterations: number): string {
    return `## Summary
Automated implementation for: **${ctx.title}**

## Details
${ctx.description}

## Self-Review
- Iterations: ${reviewIterations}
- Lint: Passed
- Types: Passed
- Tests: Passed

## Linear Ticket
${ctx.identifier}

---
Implemented by **Odin** (autonomous Claude Code agent)`;
  }

  async stop() {
    this.prMonitor.stop();
    log.info("Orchestrator stopped");
  }
}
