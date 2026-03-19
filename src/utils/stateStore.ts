import fs from "fs/promises";
import path from "path";
import { TicketContext } from "../orchestrator/TicketStateMachine.js";
import { getConfig } from "../config.js";
import { createChildLogger } from "./logger.js";

const log = createChildLogger({ module: "StateStore" });

export class StateStore {
  private filePath: string;

  constructor() {
    const config = getConfig();
    this.filePath = path.join(config.WORKSPACE_DIR, "odin-state.json");
  }

  async save(tickets: Map<string, TicketContext>): Promise<void> {
    const data = Object.fromEntries(tickets);
    try {
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error({ err }, "Failed to save state");
    }
  }

  async load(): Promise<Map<string, TicketContext>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, TicketContext>;
      return new Map(Object.entries(data));
    } catch {
      // No state file or invalid — start fresh
      return new Map();
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // File didn't exist, that's fine
    }
  }
}
