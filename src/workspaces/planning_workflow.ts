import type { WorkspaceSnapshot } from "./snapshot.ts";

export interface PlannerCandidate {
  agentId: string;
  modelId: string;
}

export type PlanningPrivacyPolicy =
  | "allow_any"
  | "require_no_training"
  | "require_no_training_and_zero_retention";

export interface PlanningModel {
  id: string;
  configId: string;
  available: true;
  metadata?: Record<string, unknown>;
}

export interface PlanningModelList {
  status: "completed" | "failed" | "timed_out" | "cancelled";
  models?: PlanningModel[];
}

export interface PlanningTaskResult {
  status:
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "permission_required";
  response?: string;
  stopReason?: string;
  error?: {
    kind?: string;
    stage?: string;
    acpCode?: number;
    classification?: PlannerFailureClassification;
  };
}

export interface PlannerFailureClassification {
  reason?: string;
  source?: string;
  evidence?: string;
}

export interface PlanningWorkflowServices {
  createSnapshot(repository: string): Promise<WorkspaceSnapshot>;
  cloneSnapshot(canonicalSnapshotPath: string): Promise<WorkspaceSnapshot>;
  listModels(
    agentId: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<PlanningModelList>;
  runTask(args: {
    agentId: string;
    modelId: string;
    configId: string;
    task: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<PlanningTaskResult>;
}

export interface PlanningWorkflowOptions {
  repository: string;
  task: string;
  preferred: PlannerCandidate;
  fallbacks?: PlannerCandidate[];
  privacyPolicy: PlanningPrivacyPolicy;
  allowRateLimitedFallback?: boolean;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface AttemptRecord {
  agentId: string;
  modelId: string;
  status: string;
  reason?: string;
  privacy?: Record<string, unknown> | null;
  error?: PlanningTaskResult["error"];
}

export interface PlanningWorkflowResult {
  status: "completed" | "failed";
  response?: string;
  selectedModel?: PlannerCandidate;
  stopReason: string;
  policy: {
    privacyPolicy: PlanningPrivacyPolicy;
    allowRateLimitedFallback: boolean;
    maxAttempts: number;
  };
  attempts: AttemptRecord[];
  cleanupWarnings: Array<{ path: string; message: string }>;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS = 5;
const MAX_CANDIDATES = 20;

function modelPrivacy(model: PlanningModel): Record<string, unknown> | null {
  const value = model.metadata?.privacy;
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function privacyAllowed(
  privacy: Record<string, unknown> | null,
  policy: PlanningPrivacyPolicy,
) {
  if (policy === "allow_any") return true;
  if (privacy?.trainingUse !== "not_used_for_training") return false;
  return policy === "require_no_training" || privacy.retention === "zero";
}

function fallbackClassificationReason(
  classification?: PlannerFailureClassification,
) {
  if (!classification) return "unclassified_failure";
  if (classification.reason !== "rate_limited") {
    return "classification_not_allowed";
  }
  if (classification.evidence === "structured") return undefined;
  if (
    classification.source === "opencode" &&
    classification.evidence === "message_heuristic"
  ) return undefined;
  return "classification_not_allowed";
}

function planningPrompt(task: string) {
  return `Inspect the repository. Do not modify files. Return the plan only in the final response.\n\n${task}`;
}

/** Orchestrates explicit planning candidates around the existing ACP tools. */
export async function runPlanningWorkflow(
  options: PlanningWorkflowOptions,
  services: PlanningWorkflowServices,
): Promise<PlanningWorkflowResult> {
  const candidates = [options.preferred, ...(options.fallbacks ?? [])];
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const result: PlanningWorkflowResult = {
    status: "failed",
    stopReason: "not_started",
    policy: {
      privacyPolicy: options.privacyPolicy,
      allowRateLimitedFallback: options.allowRateLimitedFallback ?? false,
      maxAttempts,
    },
    attempts: [],
    cleanupWarnings: [],
  };
  if (
    !options.repository || !options.task ||
    candidates.length > MAX_CANDIDATES ||
    !Number.isInteger(maxAttempts) || maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS
  ) {
    result.stopReason = "invalid_workflow_options";
    return result;
  }

  const candidateKeys = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = `${candidate.agentId}\0${candidate.modelId}`;
    if (!candidate.agentId || !candidate.modelId || candidateKeys.has(key)) {
      return false;
    }
    candidateKeys.add(key);
    return true;
  });
  let canonical: WorkspaceSnapshot | undefined;
  let attemptedCount = 0;
  let rateLimitFallbackAuthorized = false;
  const modelLists = new Map<string, PlanningModelList>();

  try {
    try {
      canonical = await services.createSnapshot(options.repository);
    } catch {
      result.stopReason = "snapshot_creation_failed";
      return result;
    }

    for (let index = 0; index < uniqueCandidates.length; index++) {
      if (options.signal?.aborted) {
        result.stopReason = "cancelled";
        return result;
      }
      const candidate = uniqueCandidates[index];
      let listing = modelLists.get(candidate.agentId);
      if (!listing) {
        let discoveryWorkspace: WorkspaceSnapshot | undefined;
        try {
          discoveryWorkspace = await services.cloneSnapshot(canonical.cwd);
          listing = await services.listModels(
            candidate.agentId,
            discoveryWorkspace.cwd,
            options.signal,
          );
          modelLists.set(candidate.agentId, listing);
        } catch {
          result.attempts.push({
            ...candidate,
            status: "skipped",
            reason: options.signal?.aborted
              ? "model_discovery_cancelled"
              : "model_discovery_failed",
          });
          result.stopReason = options.signal?.aborted
            ? "cancelled"
            : "model_discovery_failed";
          return result;
        } finally {
          if (discoveryWorkspace) {
            try {
              await discoveryWorkspace.cleanup();
            } catch {
              result.cleanupWarnings.push({
                path: discoveryWorkspace.cwd,
                message: "Model-discovery workspace cleanup failed",
              });
            }
          }
        }
      }
      if (listing.status !== "completed") {
        result.attempts.push({
          ...candidate,
          status: "skipped",
          reason: listing.status === "timed_out"
            ? "model_discovery_timed_out"
            : listing.status === "cancelled"
            ? "model_discovery_cancelled"
            : "model_discovery_failed",
        });
        result.stopReason = listing.status === "cancelled"
          ? "cancelled"
          : listing.status === "timed_out"
          ? "model_discovery_timed_out"
          : "model_discovery_failed";
        return result;
      }
      const model = listing.models?.find((entry) =>
        entry.available === true && entry.id === candidate.modelId
      );
      if (!model) {
        result.attempts.push({
          ...candidate,
          status: "skipped",
          reason: "not_advertised",
        });
        continue;
      }
      const privacy = modelPrivacy(model);
      if (!privacyAllowed(privacy, options.privacyPolicy)) {
        result.attempts.push({
          ...candidate,
          status: "skipped",
          reason: "privacy_policy_rejected",
          privacy,
        });
        continue;
      }
      if (attemptedCount >= maxAttempts) {
        result.stopReason = "attempt_limit_reached";
        return result;
      }
      if (attemptedCount > 0 && !rateLimitFallbackAuthorized) {
        result.stopReason = "fallback_not_authorized";
        return result;
      }

      let attemptWorkspace: WorkspaceSnapshot;
      try {
        attemptWorkspace = await services.cloneSnapshot(canonical.cwd);
      } catch {
        result.stopReason = "attempt_snapshot_creation_failed";
        return result;
      }

      attemptedCount++;
      let taskResult: PlanningTaskResult;
      try {
        taskResult = await services.runTask({
          agentId: candidate.agentId,
          modelId: candidate.modelId,
          configId: model.configId,
          task: planningPrompt(options.task),
          cwd: attemptWorkspace.cwd,
          signal: options.signal,
        });
      } catch {
        taskResult = options.signal?.aborted
          ? { status: "cancelled" }
          : { status: "failed", error: { kind: "tool_call_failed" } };
      }

      const classification = taskResult.error?.classification;
      const attempt: AttemptRecord = {
        ...candidate,
        status: taskResult.status,
        privacy,
        ...(taskResult.error
          ? {
            error: {
              ...(taskResult.error.kind ? { kind: taskResult.error.kind } : {}),
              ...(taskResult.error.stage
                ? { stage: taskResult.error.stage }
                : {}),
              ...(taskResult.error.acpCode !== undefined
                ? { acpCode: taskResult.error.acpCode }
                : {}),
              ...(classification ? { classification } : {}),
            },
          }
          : {}),
      };
      result.attempts.push(attempt);
      try {
        await attemptWorkspace.cleanup();
      } catch {
        result.cleanupWarnings.push({
          path: attemptWorkspace.cwd,
          message: "Attempt workspace cleanup failed",
        });
      }

      if (taskResult.status === "completed") {
        result.status = "completed";
        result.response = taskResult.response ?? "";
        result.selectedModel = candidate;
        result.stopReason = "completed";
        return result;
      }
      if (taskResult.status !== "failed") {
        result.stopReason = taskResult.status === "timed_out"
          ? "timed_out"
          : taskResult.status === "cancelled"
          ? "cancelled"
          : "permission_required";
        return result;
      }
      const classificationStop = fallbackClassificationReason(classification);
      if (classificationStop) {
        result.stopReason = classificationStop;
        return result;
      }
      if (!options.allowRateLimitedFallback) {
        result.stopReason = "fallback_not_authorized";
        return result;
      }
      rateLimitFallbackAuthorized = true;
      if (index === uniqueCandidates.length - 1) {
        result.stopReason = "candidates_exhausted";
        return result;
      }
    }

    result.stopReason = attemptedCount === 0
      ? "no_eligible_candidate"
      : rateLimitFallbackAuthorized
      ? "candidates_exhausted"
      : "no_eligible_candidate";
    return result;
  } finally {
    if (canonical) {
      try {
        await canonical.cleanup();
      } catch {
        result.cleanupWarnings.push({
          path: canonical.cwd,
          message: "Canonical snapshot cleanup failed",
        });
      }
    }
  }
}
