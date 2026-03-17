import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger({ module: "AgentService" });

export type AgentTier = "cheap" | "standard" | "premium";

export interface AgentResult {
  output: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class AgentService {
  private config = getConfig();

  private getModel(tier: AgentTier): string {
    switch (tier) {
      case "cheap":
        return this.config.CLAUDE_CHEAP_MODEL; // Haiku — ralph
      case "standard":
        return this.config.CLAUDE_MODEL; // Sonnet
      case "premium":
        return "claude-opus-4-6"; // Only for the hardest tasks
    }
  }

  async query(params: {
    prompt: string;
    systemPrompt?: string;
    workingDir: string;
    tier?: AgentTier;
    maxBudgetUsd?: number;
    allowedTools?: string[];
  }): Promise<AgentResult> {
    const tier = params.tier ?? "cheap"; // Default to Haiku (ralph)
    const model = this.getModel(tier);
    const maxBudget =
      params.maxBudgetUsd ?? this.config.MAX_BUDGET_PER_TICKET_USD;

    log.info(
      { model, tier, workingDir: params.workingDir },
      "Starting agent query"
    );

    const messages: SDKMessage[] = [];
    let resultText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const stream = claudeQuery({
      prompt: params.prompt,
      options: {
        model,
        cwd: params.workingDir,
        maxBudgetUsd: maxBudget,
        systemPrompt: params.systemPrompt
          ? params.systemPrompt
          : undefined,
        allowedTools: params.allowedTools ?? [
          "Read",
          "Write",
          "Edit",
          "Bash",
          "Grep",
          "Glob",
        ],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });

    for await (const message of stream) {
      messages.push(message);

      if (message.type === "assistant" && message.message) {
        if (typeof message.message.content === "string") {
          resultText += message.message.content;
        } else if (Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              resultText += block.text;
            }
          }
        }
      }

      if (message.type === "result") {
        totalInputTokens = (message as any).totalInputTokens ?? 0;
        totalOutputTokens = (message as any).totalOutputTokens ?? 0;
        if ((message as any).result) {
          resultText = (message as any).result;
        }
      }
    }

    log.info(
      { model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      "Agent query completed"
    );

    return {
      output: resultText,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  /**
   * Try with cheap model first (Haiku/Ralph), escalate if it fails or
   * indicates it can't handle the task.
   */
  async queryWithEscalation(params: {
    prompt: string;
    systemPrompt?: string;
    workingDir: string;
    maxBudgetUsd?: number;
  }): Promise<AgentResult> {
    try {
      const result = await this.query({ ...params, tier: "cheap" });

      // Check if Haiku flagged itself as unable to complete
      const lowerOutput = result.output.toLowerCase();
      if (
        lowerOutput.includes("i cannot complete this") ||
        lowerOutput.includes("this task is too complex") ||
        lowerOutput.includes("i need a more capable model")
      ) {
        log.info("Haiku flagged task as too complex, escalating to Sonnet");
        return this.query({ ...params, tier: "standard" });
      }

      return result;
    } catch (err) {
      log.warn({ err }, "Cheap model failed, escalating to standard");
      return this.query({ ...params, tier: "standard" });
    }
  }
}
