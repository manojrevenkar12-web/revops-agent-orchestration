import pino from "pino";

/** Structured logs. Free text from leads, emails or notes is never logged: callers pass ids, counts and statuses. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "revops" },
  redact: { paths: ["*.email", "*.text", "*.message", "*.body", "*.token", "*.authorization"], censor: "[redacted]" },
});
