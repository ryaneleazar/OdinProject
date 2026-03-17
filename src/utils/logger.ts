import pino from "pino";
import { getConfig } from "../config.js";

export const logger = pino({
  level: getConfig().LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
