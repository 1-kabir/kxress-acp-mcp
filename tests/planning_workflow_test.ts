import {
  type PlannerCandidate,
  type PlanningModelList,
  type PlanningTaskResult,
  type PlanningWorkflowServices,
  runPlanningWorkflow,
} from "../src/workspaces/planning_workflow.ts";
import type { WorkspaceSnapshot } from "../src/workspaces/snapshot.ts";

const preferred = {
  agentId: "opencode",
  modelId: "opencode/nemotron-3-ultra-free",
};
const fallback = {
  agentId: "opencode",
  modelId: "opencode/longcat-2.5-preview-free",
};

function modelList(
  entries: Array<{
    id: string;
    privacy?: Record<string, unknown>;
  }>,
): PlanningModelList {
  return {
    status: "completed",
    models: entries.map((entry) => ({
      id: entry.id,
      configId: "engine",
      available: true,
      ...(entry.privacy ? { metadata: { privacy: entry.privacy } } : {}),
    })),
  };
}

function fakeServices(
  options: {
    models?: PlanningModelList;
    run?: PlanningWorkflowServices["runTask"];
    cleanupFailsFor?: string;
  } = {},
) {
  let next = 0;
  const snapshots = new Map<string, Map<string, string>>();
  const cleaned: string[] = [];
  const timeline: string[] = [];
  const runCalls: Array<Parameters<PlanningWorkflowServices["runTask"]>[0]> =
    [];
  const discoveryCalls: string[] = [];
  const make = (files: Map<string, string>) => {
    const cwd = `C:\\temp\\planning-test-${++next}`;
    timeline.push(`created:${cwd}`);
    snapshots.set(cwd, new Map(files));
    const snapshot: WorkspaceSnapshot = {
      cwd,
      sourceRoot: "D:\\repo",
      fileCount: files.size,
      sizeBytes: 0,
      creationMs: 1,
      cleanup() {
        if (options.cleanupFailsFor === cwd) throw new Error("cleanup denied");
        cleaned.push(cwd);
        timeline.push(`cleaned:${cwd}`);
        snapshots.delete(cwd);
        return Promise.resolve();
      },
    };
    return snapshot;
  };
  const services: PlanningWorkflowServices = {
    createSnapshot() {
      return Promise.resolve(make(
        new Map([[
          "tracked.txt",
          "current repository contents",
        ]]),
      ));
    },
    cloneSnapshot(source) {
      return Promise.resolve(make(snapshots.get(source) ?? new Map()));
    },
    listModels(agentId) {
      discoveryCalls.push(agentId);
      return Promise.resolve(
        options.models ?? modelList([
          {
            id: preferred.modelId,
            privacy: {
              trainingUse: "not_used_for_training",
              retention: "zero",
            },
          },
          {
            id: fallback.modelId,
            privacy: {
              trainingUse: "not_used_for_training",
              retention: "zero",
            },
          },
        ]),
      );
    },
    async runTask(args) {
      runCalls.push(args);
      timeline.push(`run:${args.cwd}`);
      return options.run
        ? await options.run(args)
        : { status: "completed", response: "PROJECT=acp-mcp" };
    },
  };
  return { services, snapshots, cleaned, timeline, runCalls, discoveryCalls };
}

function workflowOptions(
  overrides: Partial<Parameters<typeof runPlanningWorkflow>[0]> = {},
) {
  return {
    repository: "D:\\repo",
    task: "Identify the project name",
    preferred,
    fallbacks: [fallback],
    privacyPolicy: "require_no_training_and_zero_retention" as const,
    ...overrides,
  };
}

Deno.test("planning workflow uses preferred model and cleans both snapshots", async () => {
  const fake = fakeServices();
  const result = await runPlanningWorkflow(workflowOptions(), fake.services);
  if (
    result.status !== "completed" || result.response !== "PROJECT=acp-mcp" ||
    result.selectedModel?.modelId !== preferred.modelId ||
    fake.runCalls.length !== 1 || fake.cleaned.length !== 3 ||
    fake.snapshots.size !== 0
  ) {
    throw new Error(
      `Preferred success lifecycle was incorrect: ${JSON.stringify(result)}`,
    );
  }
  if (fake.runCalls[0].cwd === "D:\\repo") {
    throw new Error("Planner was given the source repository as cwd");
  }
});

Deno.test("rate-limit fallback gets a pristine independent snapshot", async () => {
  const fake = fakeServices({
    run: ({ cwd }) => {
      const files = fake.snapshots.get(cwd)!;
      if (fake.runCalls.length === 1) {
        files.set("BAD.txt", "mutation from failed planner");
        return Promise.resolve({
          status: "failed",
          error: {
            kind: "prompt_failed",
            classification: {
              reason: "rate_limited",
              source: "opencode",
              evidence: "message_heuristic",
            },
          },
        });
      }
      if (files.has("BAD.txt")) {
        throw new Error("Fallback inherited planner mutation");
      }
      return Promise.resolve({
        status: "completed",
        response: "fallback plan",
      });
    },
  });
  const result = await runPlanningWorkflow(
    workflowOptions({ allowRateLimitedFallback: true }),
    fake.services,
  );
  if (
    result.status !== "completed" || result.response !== "fallback plan" ||
    result.selectedModel?.modelId !== fallback.modelId ||
    fake.runCalls.length !== 2 ||
    fake.runCalls[0].cwd === fake.runCalls[1].cwd ||
    fake.cleaned.length !== 4 || fake.snapshots.size !== 0
  ) {
    throw new Error(
      `Fallback lifecycle was incorrect: ${JSON.stringify(result)}`,
    );
  }
  if (
    fake.timeline.indexOf(`cleaned:${fake.runCalls[0].cwd}`) >
      fake.timeline.indexOf(`run:${fake.runCalls[1].cwd}`)
  ) {
    throw new Error(
      "Fallback started before the preferred attempt was cleaned",
    );
  }
});

Deno.test("ambiguous failures and timeouts never trigger fallback", async () => {
  for (
    const taskResult of [
      {
        status: "failed",
        error: { kind: "prompt_failed", acpCode: -32603 },
      },
      { status: "timed_out" },
    ] as PlanningTaskResult[]
  ) {
    const fake = fakeServices({ run: () => Promise.resolve(taskResult) });
    const result = await runPlanningWorkflow(
      workflowOptions({ allowRateLimitedFallback: true }),
      fake.services,
    );
    if (
      fake.runCalls.length !== 1 || result.attempts.length !== 1 ||
      fake.cleaned.length !== 3
    ) {
      throw new Error(`Unsafe replay after ${taskResult.status}`);
    }
  }
});

Deno.test("cancellation before an attempt cleans the canonical snapshot", async () => {
  const fake = fakeServices();
  const controller = new AbortController();
  controller.abort();
  const result = await runPlanningWorkflow(
    workflowOptions({ signal: controller.signal }),
    fake.services,
  );
  if (
    result.stopReason !== "cancelled" || fake.runCalls.length ||
    fake.cleaned.length !== 1 || fake.snapshots.size
  ) throw new Error(`Cancellation cleanup failed: ${JSON.stringify(result)}`);
});

Deno.test("privacy rejection skips a candidate and selects only an allowed fallback", async () => {
  const fake = fakeServices({
    models: modelList([
      {
        id: preferred.modelId,
        privacy: { trainingUse: "may_be_used_for_improvement" },
      },
      {
        id: fallback.modelId,
        privacy: { trainingUse: "not_used_for_training", retention: "zero" },
      },
    ]),
  });
  const result = await runPlanningWorkflow(workflowOptions(), fake.services);
  if (
    result.status !== "completed" ||
    result.selectedModel?.modelId !== fallback.modelId ||
    result.attempts[0]?.reason !== "privacy_policy_rejected" ||
    fake.runCalls.length !== 1
  ) throw new Error(`Privacy filtering failed: ${JSON.stringify(result)}`);
});

Deno.test("unknown privacy is rejected by policies requiring known safe metadata", async () => {
  const fake = fakeServices({
    models: modelList([{ id: preferred.modelId }]),
  });
  const result = await runPlanningWorkflow(
    workflowOptions({
      fallbacks: [],
      privacyPolicy: "require_no_training",
    }),
    fake.services,
  );
  if (
    result.attempts[0]?.reason !== "privacy_policy_rejected" ||
    result.attempts[0]?.privacy !== null || fake.runCalls.length
  ) {
    throw new Error(
      `Unknown privacy was not rejected: ${JSON.stringify(result)}`,
    );
  }
});

Deno.test("missing or unadvertised preferred model is never called blindly", async () => {
  const fake = fakeServices({ models: modelList([{ id: fallback.modelId }]) });
  const result = await runPlanningWorkflow(
    workflowOptions({ fallbacks: [] }),
    fake.services,
  );
  if (
    result.status !== "failed" ||
    result.attempts[0]?.reason !== "not_advertised" ||
    fake.runCalls.length !== 0
  ) {
    throw new Error(
      `Unadvertised model was not skipped: ${JSON.stringify(result)}`,
    );
  }
});

Deno.test("attempt limit bounds rate-limit retries", async () => {
  const third: PlannerCandidate = {
    agentId: "opencode",
    modelId: "opencode/space-bunny-free",
  };
  const fake = fakeServices({
    models: modelList([
      {
        id: preferred.modelId,
        privacy: { trainingUse: "not_used_for_training", retention: "zero" },
      },
      {
        id: fallback.modelId,
        privacy: { trainingUse: "not_used_for_training", retention: "zero" },
      },
      {
        id: third.modelId,
        privacy: { trainingUse: "not_used_for_training", retention: "zero" },
      },
    ]),
    run: () =>
      Promise.resolve({
        status: "failed",
        error: {
          classification: {
            reason: "rate_limited",
            source: "opencode",
            evidence: "message_heuristic",
          },
        },
      }),
  });
  const result = await runPlanningWorkflow(
    workflowOptions({
      fallbacks: [fallback, third],
      maxAttempts: 2,
      allowRateLimitedFallback: true,
    }),
    fake.services,
  );
  if (
    fake.runCalls.length !== 2 || result.stopReason !== "attempt_limit_reached"
  ) {
    throw new Error(`Attempt bound was exceeded: ${JSON.stringify(result)}`);
  }
});

Deno.test("cleanup failure preserves the completed planning result and leftover path", async () => {
  const fake = fakeServices({ cleanupFailsFor: "C:\\temp\\planning-test-3" });
  const result = await runPlanningWorkflow(workflowOptions(), fake.services);
  if (
    result.status !== "completed" || result.cleanupWarnings.length !== 1 ||
    result.cleanupWarnings[0].path !== "C:\\temp\\planning-test-3"
  ) {
    throw new Error(
      `Cleanup failure hid or replaced the result: ${JSON.stringify(result)}`,
    );
  }
});

Deno.test("fallback requires explicit authorization and an allowed classification", async () => {
  const cases = [
    { allow: false, source: "opencode", evidence: "message_heuristic" },
    { allow: true, source: "other", evidence: "message_heuristic" },
  ];
  for (const item of cases) {
    const fake = fakeServices({
      run: () =>
        Promise.resolve({
          status: "failed",
          error: {
            classification: {
              reason: "rate_limited",
              source: item.source,
              evidence: item.evidence,
            },
          },
        }),
    });
    await runPlanningWorkflow(
      workflowOptions({ allowRateLimitedFallback: item.allow }),
      fake.services,
    );
    if (fake.runCalls.length !== 1) {
      throw new Error("Unauthorized fallback ran");
    }
  }
});
