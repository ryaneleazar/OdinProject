import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { getConfig } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const exec = promisify(execFile);
const log = createChildLogger({ module: "GitService" });

export class GitService {
  private bareDir: string;
  private repoUrl: string;
  private workspaceDir: string;
  private initialized = false;

  constructor() {
    const config = getConfig();
    this.repoUrl = config.GITHUB_REPO_URL;
    this.workspaceDir = config.WORKSPACE_DIR;
    this.bareDir = path.join(this.workspaceDir, "bare-repo.git");
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd: cwd ?? this.bareDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  async init() {
    if (this.initialized) return;

    const config = getConfig();
    const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${config.GITHUB_TOKEN}`).toString("base64")}`;

    try {
      await exec("ls", [this.bareDir]);
      await this.git(["-c", `http.extraheader=${authHeader}`, "fetch", "--all"]);
      log.info("Fetched existing bare clone");
    } catch {
      await exec("mkdir", ["-p", this.workspaceDir]);
      await exec("git", ["-c", `http.extraheader=${authHeader}`, "clone", "--bare", this.repoUrl, this.bareDir]);
      log.info("Created bare clone");
    }

    this.initialized = true;
  }

  async createWorktree(branchName: string): Promise<string> {
    await this.init();
    const worktreePath = path.join(this.workspaceDir, "worktrees", branchName);

    // Always fetch the latest main from origin (valhalla) to branch from fresh state
    await this.git(["fetch", "origin", "main"]);

    try {
      await this.git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"]);
    } catch {
      // Branch already exists — reset it to latest origin/main before using it
      await this.git(["branch", "-D", branchName]);
      await this.git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"]);
    }

    // Install dependencies so git hooks (pre-commit, pre-push) can run
    await exec("npm", ["ci"], { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });

    log.info({ branchName, worktreePath }, "Created worktree");
    return worktreePath;
  }

  async commitAndPush(
    worktreePath: string,
    branchName: string,
    message: string
  ) {
    await this.git(["add", "-A"], worktreePath);

    const status = await this.git(["status", "--porcelain"], worktreePath);
    if (!status) {
      log.warn({ branchName }, "Nothing to commit");
      return false;
    }

    await this.git(["commit", "-m", message], worktreePath);

    const config = getConfig();
    const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${config.GITHUB_TOKEN}`).toString("base64")}`;
    await this.git(
      ["-c", `http.extraheader=${authHeader}`, "push", "origin", `${branchName}:${branchName}`],
      worktreePath
    );

    log.info({ branchName }, "Committed and pushed");
    return true;
  }

  async removeWorktree(branchName: string) {
    const worktreePath = path.join(this.workspaceDir, "worktrees", branchName);
    try {
      await this.git(["worktree", "remove", worktreePath, "--force"]);
      log.info({ branchName }, "Removed worktree");
    } catch (err) {
      log.warn({ err, branchName }, "Failed to remove worktree");
    }
  }

  getWorktreePath(branchName: string): string {
    return path.join(this.workspaceDir, "worktrees", branchName);
  }
}
