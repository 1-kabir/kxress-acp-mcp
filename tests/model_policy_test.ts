import {
  type AgentModelPolicy,
  filterModels,
  resolveModelSelection,
  validateModelPolicy,
} from "../src/models/policy.ts";
import type { DiscoveredModel } from "../src/models/discovery.ts";

function model(id: string, selected = false): DiscoveredModel {
  return {
    id,
    name: id,
    configId: "model",
    available: true,
    selected,
    availabilitySource: "acp",
  };
}

function assertThrows(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return;
    throw error;
  }
  throw new Error(`Expected error containing ${expected}`);
}

Deno.test("model policy validates the public sizes and effort vocabulary strictly", () => {
  const valid = validateModelPolicy(
    {
      default: { modelSize: "xlarge", thinkingEffort: "ultra" },
      modelSizes: { large: { model: "exact" } },
      thinkingEffort: {
        configOption: "reasoning_effort",
        values: { xhigh: "x-high" },
      },
    },
    "agent",
    "fixture.json",
  );
  if (valid.default?.modelSize !== "xlarge") {
    throw new Error("valid size rejected");
  }
  for (
    const value of ["xl", "x-large", "extra_high", "extra-high", "maximum"]
  ) {
    assertThrows(() =>
      validateModelPolicy(
        { default: { modelSize: value } },
        "agent",
        "fixture.json",
      ), "unsupported value");
  }
  assertThrows(
    () =>
      validateModelPolicy(
        { default: { model: "a", modelSize: "large" } },
        "agent",
        "fixture.json",
      ),
    "exactly one",
  );
});

Deno.test("exact and size defaults resolve only from the live catalog", () => {
  const catalog = [model("small-one"), model("large-one", true)];
  const exact = resolveModelSelection(catalog, [], {
    default: { model: "small-one" },
  }, {});
  const sized = resolveModelSelection(catalog, [], {
    default: { modelSize: "large" },
    modelSizes: { large: { model: "large-one" } },
  }, {});
  if (exact.model?.id !== "small-one" || sized.model?.id !== "large-one") {
    throw new Error("default did not resolve");
  }
  const explicitOverride = resolveModelSelection(catalog, [], {
    default: { model: "small-one" },
  }, { model: "large-one" });
  if (explicitOverride.model?.id !== "large-one") {
    throw new Error(
      "explicit exact model did not override the configured default",
    );
  }
  assertThrows(() =>
    resolveModelSelection(catalog, [], {}, {
      model: "small-one",
      modelSize: "large",
    }), "mutually exclusive");
  assertThrows(
    () =>
      resolveModelSelection(
        catalog,
        [],
        { default: { model: "unadvertised" } },
        {},
      ),
    "not advertised",
  );
  assertThrows(
    () =>
      resolveModelSelection(catalog, [], {
        default: { modelSize: "large" },
        modelSizes: { large: { model: "unadvertised" } },
      }, {}),
    "not advertised",
  );
});

Deno.test("allow and deny patterns filter live model IDs, with deny taking precedence", () => {
  const catalog = [
    model("claude-opus-5-5-low"),
    model("claude-sonnet-5-5-high"),
    model("gpt-6-luna"),
  ];
  const filtered = filterModels(catalog, {
    allowedModels: ["claude-*"],
    deniedModels: ["*-low"],
  });
  if (filtered.map((item) => item.id).join() !== "claude-sonnet-5-5-high") {
    throw new Error("unexpected policy filtering");
  }
  assertThrows(
    () =>
      resolveModelSelection(catalog, [], { deniedModels: ["claude-*"] }, {
        model: "claude-opus-5-5-low",
      }),
    "denied",
  );
});

Deno.test("effort encoded model IDs preserve exact IDs and saturate max and ultra", () => {
  const catalog = [
    model("claude-opus-low"),
    model("claude-opus-medium"),
    model("claude-opus-high"),
  ];
  const policy: AgentModelPolicy = {
    modelSizes: {
      large: {
        modelsByThinkingEffort: {
          low: "claude-opus-low",
          medium: "claude-opus-medium",
          high: "claude-opus-high",
        },
      },
    },
  };
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveModelSelection(catalog, [], policy, {
      modelSize: "large",
      thinkingEffort: effort,
    });
    if (resolved.thinkingEffort !== effort) {
      throw new Error(`concrete effort ${effort} was not preserved`);
    }
  }
  for (const requested of ["max", "ultra"] as const) {
    const resolved = resolveModelSelection(catalog, [], policy, {
      modelSize: "large",
      thinkingEffort: requested,
    });
    if (
      resolved.model?.id !== "claude-opus-high" ||
      resolved.thinkingEffort !== "high"
    ) throw new Error(`${requested} did not saturate`);
  }
  assertThrows(
    () =>
      resolveModelSelection(catalog, [], policy, {
        modelSize: "large",
        thinkingEffort: "xhigh",
      }),
    "thinking effort",
  );
  const exact = resolveModelSelection(catalog, [], policy, {
    model: "claude-opus-medium",
  });
  if (
    exact.model?.id !== "claude-opus-medium" ||
    exact.thinkingEffort !== "medium"
  ) throw new Error("exact model ID changed");
  assertThrows(
    () =>
      resolveModelSelection(catalog, [], {
        ...policy,
        deniedModels: ["claude-opus-high"],
      }, {
        modelSize: "large",
        thinkingEffort: "high",
      }),
    "denied",
  );
});

Deno.test("separate effort config options use live advertised choices and saturate", () => {
  const catalog = [model("opus", true)];
  const options = [{
    id: "reasoning_effort",
    type: "select",
    options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
      value,
      name: value,
    })),
  }];
  const policy: AgentModelPolicy = {
    default: { modelSize: "large" },
    modelSizes: { large: { model: "opus" } },
    thinkingEffort: {
      configOption: "reasoning_effort",
      values: {
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
        ultra: "ultra",
      },
    },
  };
  for (
    const [requested, expected] of [["max", "max"], ["ultra", "max"]] as const
  ) {
    const resolved = resolveModelSelection(catalog, options, policy, {
      thinkingEffort: requested,
    });
    if (
      resolved.thinkingEffort !== expected ||
      resolved.thinkingConfigValue !== expected
    ) throw new Error(`${requested} did not saturate to ${expected}`);
  }
  const cappedOptions = [{
    ...options[0],
    options: options[0].options.slice(0, 3),
  }];
  const capped = resolveModelSelection(catalog, cappedOptions, policy, {
    thinkingEffort: "max",
  });
  if (capped.thinkingEffort !== "high") {
    throw new Error("max did not cap at live high choice");
  }
  assertThrows(
    () =>
      resolveModelSelection(catalog, cappedOptions, policy, {
        thinkingEffort: "xhigh",
      }),
    "not supported",
  );
});

Deno.test("literal downstream ultra remains selectable when advertised", () => {
  const catalog = [model("effort-low"), model("effort-ultra")];
  const resolved = resolveModelSelection(catalog, [], {
    modelSizes: {
      large: {
        modelsByThinkingEffort: {
          low: "effort-low",
          ultra: "effort-ultra",
        },
      },
    },
  }, { modelSize: "large", thinkingEffort: "ultra" });
  if (
    resolved.model?.id !== "effort-ultra" || resolved.thinkingEffort !== "ultra"
  ) {
    throw new Error("literal advertised ultra was not preserved");
  }
});

Deno.test("model-size policy never falls through to another mapping", () => {
  const catalog = [model("large-one"), model("medium-one")];
  const policy = {
    modelSizes: {
      large: { model: "missing-large" },
      medium: { model: "medium-one" },
    },
  } as AgentModelPolicy;
  assertThrows(
    () => resolveModelSelection(catalog, [], policy, { modelSize: "large" }),
    "not advertised",
  );
});
