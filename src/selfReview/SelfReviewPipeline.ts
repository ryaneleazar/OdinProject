import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
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

interface RepoScripts {
  lint: string | null;
  typecheck: string | null;
  test: string | null;
}

export class SelfReviewPipeline {
  private agent: AgentService;

  constructor(agent: AgentService) {
    this.agent = agent;
  }

  async run(worktreePath: string): Promise<ReviewResult> {
    const errors: string[] = [];
    const scripts = await this.detectRepoScripts(worktreePath);

    log.info({ worktreePath, scripts }, "Detected repo scripts");

    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      log.info({ iteration: i, worktreePath }, "Self-review iteration");

      const changedFiles = await this.getChangedFiles(worktreePath);
      if (changedFiles.length === 0) {
        log.info("No changed files, skipping review");
        return { passed: true, iterations: i, errors: [] };
      }

      // Run checks
      const lintErrors = await this.runLint(worktreePath, scripts);
      const typeErrors = await this.runTypeCheck(worktreePath, scripts);
      const testErrors = await this.runTests(worktreePath, scripts);

      const allErrors = [lintErrors, typeErrors, testErrors].filter(Boolean);
      const hasErrors = allErrors.length > 0;

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
        const combinedLintErrors = [lintErrors, typeErrors]
          .filter(Boolean)
          .join("\n") || undefined;

        // Use escalation: Haiku first, escalate if needed
        await this.agent.queryWithEscalation({
          prompt: selfReviewPrompt({
            changedFiles,
            lintErrors: combinedLintErrors,
            testErrors: testErrors || undefined,
          }),
          workingDir: worktreePath,
        });
      }

      if (lintErrors) errors.push(`Lint: ${lintErrors}`);
      if (typeErrors) errors.push(`Types: ${typeErrors}`);
      if (testErrors) errors.push(`Tests: ${testErrors}`);
    }

    const finalLint = await this.runLint(worktreePath, scripts);
    const finalTypes = await this.runTypeCheck(worktreePath, scripts);
    const finalTests = await this.runTests(worktreePath, scripts);
    const passed = !finalLint && !finalTypes && !finalTests;

    log.info({ passed, iterations: MAX_ITERATIONS }, "Self-review complete");
    return { passed, iterations: MAX_ITERATIONS, errors };
  }

  /**
   * Reads the target repo's package.json to detect available lint, typecheck,
   * and test scripts. Returns null for any script not found.
   */
  private async detectRepoScripts(cwd: string): Promise<RepoScripts> {
    const result: RepoScripts = { lint: null, typecheck: null, test: null };

    try {
      const raw = await readFile(join(cwd, "package.json"), "utf-8");
      const pkg = JSON.parse(raw);
      const scripts: Record<string, string> = pkg.scripts ?? {};

      // Lint: check common script names
      for (const name of ["lint", "lint:fix", "eslint", "biome:check"]) {
        if (scripts[name]) {
          result.lint = name;
          break;
        }
      }

      // Type checking: check common script names
      for (const name of ["typecheck", "type-check", "tsc", "check:types", "types"]) {
        if (scripts[name]) {
          result.typecheck = name;
          break;
        }
      }

      // Test: check common script names
      for (const name of ["test", "test:run", "test:ci", "vitest", "jest"]) {
        if (scripts[name]) {
          result.test = name;
          break;
        }
      }

      log.info({ scripts: result, availableScripts: Object.keys(scripts) }, "Resolved repo scripts");
    } catch (err) {
      log.warn({ err, cwd }, "Could not read package.json, falling back to defaults");
      // Fallback: assume tsc + generic test
      result.typecheck = "__fallback_tsc";
      result.test = "__fallback_test";
    }

    return result;
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

  private async runLint(cwd: string, scripts: RepoScripts): Promise<string | null> {
    if (!scripts.lint) {
      log.debug("No lint script detected, skipping");
      return null;
    }

    try {
      await exec("npm", ["run", scripts.lint], { cwd, timeout: 60000 });
      return null;
    } catch (err: any) {
      return err.stdout || err.stderr || err.message;
    }
  }

  private async runTypeCheck(cwd: string, scripts: RepoScripts): Promise<string | null> {
    if (!scripts.typecheck) {
      log.debug("No typecheck script detected, skipping");
      return null;
    }

    try {
      if (scripts.typecheck === "__fallback_tsc") {
        await exec("npx", ["tsc", "--noEmit"], { cwd, timeout: 60000 });
      } else {
        await exec("npm", ["run", scripts.typecheck], { cwd, timeout: 60000 });
      }
      return null;
    } catch (err: any) {
      return err.stdout || err.stderr || err.message;
    }
  }

  private async runTests(cwd: string, scripts: RepoScripts): Promise<string | null> {
    if (!scripts.test) {
      log.debug("No test script detected, skipping");
      return null;
    }

    try {
      if (scripts.test === "__fallback_test") {
        await exec("npx", ["vitest", "run", "--reporter=verbose"], {
          cwd,
          timeout: 120000,
        });
      } else {
        await exec("npm", ["run", scripts.test], { cwd, timeout: 120000 });
      }
      return null;
    } catch (err: any) {
      return err.stdout || err.stderr || err.message;
    }
  }
}
