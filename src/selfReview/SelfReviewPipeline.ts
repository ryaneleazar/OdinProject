import { execFile } from "child_process";
import { promisify } from "util";
import { AgentService } from "../agent/AgentService.js";
import { selfReviewPrompt } from "../agent/prompts/selfReview.js";
import { createChildLogger } from "../utils/logger.js";

const exec = promisify(execFile);
const log = createChildLogger({ module: "SelfReviewPipeline" });
const MAX_ITERATIONS = 5;

interface ReviewResult {
  passed: boolean;
  iterations: number;
  errors: string[];
}

export class SelfReviewPipeline {
  private agent: AgentService;

  constructor(agent: AgentService) {
    this.agent = agent;
  }

  async run(worktreePath: string): Promise<ReviewResult> {
    const errors: string[] = [];

    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      log.info({ iteration: i, worktreePath }, "Self-review iteration");

      const changedFiles = await this.getChangedFiles(worktreePath);
      if (changedFiles.length === 0) {
        log.info("No changed files, skipping review");
        return { passed: true, iterations: i, errors: [] };
      }

      // Run checks
      const lintErrors = await this.runLintAndTypeCheck(worktreePath);
      const testErrors = await this.runTests(worktreePath);

      const hasErrors = lintErrors || testErrors;

      if (!hasErrors) {
        // Use Haiku for quick AI review (cheap)
        const aiReview = await this.agent.query({
          prompt: selfReviewPrompt({
            changedFiles,
            lintErrors: undefined,
            testErrors: undefined,
          }),
          workingDir: worktreePath,
          tier: "cheap", // Ralph/Haiku for review
        });

        if (aiReview.output.toLowerCase().includes("all checks passed")) {
          log.info({ iteration: i }, "Self-review passed");
          return { passed: true, iterations: i, errors: [] };
        }
      }

      if (hasErrors && i < MAX_ITERATIONS) {
        // Use escalation: Haiku first, escalate if needed
        await this.agent.queryWithEscalation({
          prompt: selfReviewPrompt({
            changedFiles,
            lintErrors: lintErrors || undefined,
            testErrors: testErrors || undefined,
          }),
          workingDir: worktreePath,
        });
      }

      if (lintErrors) errors.push(`Lint/Types: ${lintErrors}`);
      if (testErrors) errors.push(`Tests: ${testErrors}`);
    }

    const finalLint = await this.runLintAndTypeCheck(worktreePath);
    const finalTests = await this.runTests(worktreePath);
    const passed = !finalLint && !finalTests;

    log.info({ passed, iterations: MAX_ITERATIONS }, "Self-review complete");
    return { passed, iterations: MAX_ITERATIONS, errors };
  }

  private async getChangedFiles(cwd: string): Promise<string[]> {
    try {
      const { stdout } = await exec("git", ["diff", "--name-only", "HEAD"], {
        cwd,
      });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      // If no HEAD yet, list all files
      const { stdout } = await exec(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd }
      );
      return stdout.trim().split("\n").filter(Boolean);
    }
  }

  private async runLintAndTypeCheck(cwd: string): Promise<string | null> {
    try {
      await exec("npx", ["tsc", "--noEmit"], { cwd, timeout: 60000 });
      return null;
    } catch (err: any) {
      return err.stdout || err.message;
    }
  }

  private async runTests(cwd: string): Promise<string | null> {
    try {
      await exec("npx", ["vitest", "run", "--reporter=verbose"], {
        cwd,
        timeout: 120000,
      });
      return null;
    } catch (err: any) {
      return err.stdout || err.message;
    }
  }
}
