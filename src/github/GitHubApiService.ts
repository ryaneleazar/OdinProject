import { Octokit } from "@octokit/rest";
import { getConfig } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger({ module: "GitHubApiService" });

export interface PRComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export class GitHubApiService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor() {
    const config = getConfig();
    this.octokit = new Octokit({ auth: config.GITHUB_TOKEN });
    this.owner = config.GITHUB_REPO_OWNER;
    this.repo = config.GITHUB_REPO_NAME;
  }

  async createPR(params: {
    title: string;
    body: string;
    head: string;
    base?: string;
  }): Promise<number> {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base ?? "main",
    });

    log.info({ prNumber: data.number, title: params.title }, "Created PR");
    return data.number;
  }

  async getPRComments(prNumber: number): Promise<PRComment[]> {
    const { data: reviewComments } =
      await this.octokit.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

    const { data: issueComments } = await this.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
    });

    const all = [
      ...reviewComments.map((c) => ({
        id: c.id,
        body: c.body ?? "",
        user: c.user?.login ?? "",
        createdAt: c.created_at,
      })),
      ...issueComments.map((c) => ({
        id: c.id,
        body: c.body ?? "",
        user: c.user?.login ?? "",
        createdAt: c.created_at,
      })),
    ];

    return all.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  async addPRComment(prNumber: number, body: string) {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    });
  }

  async isPRMerged(prNumber: number): Promise<boolean> {
    try {
      await this.octokit.pulls.checkIfMerged({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPRStatus(
    prNumber: number
  ): Promise<"open" | "closed" | "merged"> {
    const { data } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    if (data.merged) return "merged";
    return data.state as "open" | "closed";
  }
}
