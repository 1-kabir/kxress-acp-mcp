import type {
  FailureClassification,
  FailureClassificationContext,
} from "./failure_classifiers.ts";

/**
 * OpenCode currently maps provider prompt failures to ACP internal errors
 * whose message may retain an explicit rate-limit description. The numeric
 * JSON-RPC code alone is deliberately not interpreted.
 */
export function classifyOpenCodeFailure(
  context: FailureClassificationContext,
): FailureClassification | undefined {
  if (context.stage !== "prompt") return undefined;
  const details = context.errorData && typeof context.errorData === "object"
    ? (context.errorData as Record<string, unknown>).details
    : undefined;
  const diagnostic = [context.errorMessage, details]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (!/\b(?:rate limit exceeded|too many requests)\b/i.test(diagnostic)) {
    return undefined;
  }
  return {
    reason: "rate_limited",
    source: "opencode",
    evidence: "message_heuristic",
  };
}
