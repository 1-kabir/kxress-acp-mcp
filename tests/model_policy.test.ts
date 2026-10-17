import { test } from "node:test";
import {
  type AgentModelPolicy,
  filterModels,
  resolveModelSelection,
  THINKING_EFFORTS,
  type ThinkingEffort,
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

function assertProjection(
  available: ThinkingEffort[],
  requested: ThinkingEffort,
  expected: ThinkingEffort,
): void {
  const encodedModels = available.map((effort) => model(`family-${effort}`));
  const encodedPolicy: AgentModelPolicy = {
    modelSizes: {
      large: {
        modelsByThinkingEffort: Object.fromEntries(
          available.map((effort) => [effort, `family-${effort}`]),
        ) as Partial<Record<ThinkingEffort, string>>,
      },
    },
  };
  const encoded = resolveModelSelection(encodedModels, [], encodedPolicy, {
    modelSize: "large",
    thinkingEffort: requested,
  });
  if (
    encoded.model?.id !== `family-${expected}` ||
    encoded.thinkingEffort !== expected
  ) {
    throw new Error(
      `Encoded effort ${requested} over ${available.join(
        "/",
      )} resolved to ${encoded.model?.id}/${encoded.thinkingEffort}, expected ${expected}`,
    );
  }

  const separatePolicy: AgentModelPolicy = {
    default: { model: "separate-model" },
    thinkingEffort: {
      configOption: "effort",
      values: Object.fromEntries(
        THINKING_EFFORTS.map((effort) => [effort, effort]),
      ) as Partial<Record<ThinkingEffort, string>>,
    },
  };
  const options = [
    {
      id: "effort",
      type: "select",
      options: available.map((effort) => ({ value: effort, name: effort })),
    },
  ];
  const separate = resolveModelSelection(
    [model("separate-model", true)],
    options,
    separatePolicy,
    { thinkingEffort: requested },
  );
  if (
    separate.thinkingEffort !== expected ||
    separate.thinkingConfigValue !== expected
  ) {
    throw new Error(
      `Separate effort ${requested} over ${available.join(
        "/",
      )} resolved to ${separate.thinkingEffort}/${separate.thinkingConfigValue}, expected ${expected}`,
    );
  }
}

test("model policy validates the public sizes and effort vocabulary strictly", () => {
  const valid = validateModelPolicy(
    {
      default: { modelSize: "xlarge", thinkingEffort: "ultra" },
      modelSizes: { large: { model: "exact" } },
      thinkingEffort: {
        configOption: "reasoning_effort",
        values: { off: "disabled", xhigh: "x-high" },
      },
    },
    "agent",
    "fixture.json",
  );
  if (valid.default?.modelSize !== "xlarge") {
    throw new Error("valid size rejected");
  }
  for (const value of [
    "xl",
    "x-large",
    "extra_high",
    "extra-high",
    "maximum",
    "u",
    "xh",
    "0",
  ]) {
    assertThrows(
      () =>
        validateModelPolicy(
          { default: { modelSize: value } },
          "agent",
          "fixture.json",
        ),
      "unsupported value",
    );
  }
  const off = validateModelPolicy(
    { default: { modelSize: "large", thinkingEffort: "off" } },
    "agent",
    "fixture.json",
  );
  if (off.default?.thinkingEffort !== "off") {
    throw new Error("normalized off effort was rejected");
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

test("exact and size defaults resolve only from the live catalog", () => {
  const catalog = [model("small-one"), model("large-one", true)];
  const exact = resolveModelSelection(
    catalog,
    [],
    {
      default: { model: "small-one" },
    },
    {},
  );
  const sized = resolveModelSelection(
    catalog,
    [],
    {
      default: { modelSize: "large" },
      modelSizes: { large: { model: "large-one" } },
    },
    {},
  );
  if (exact.model?.id !== "small-one" || sized.model?.id !== "large-one") {
    throw new Error("default did not resolve");
  }
  const explicitOverride = resolveModelSelection(
    catalog,
    [],
    {
      default: { model: "small-one" },
    },
    { model: "large-one" },
  );
  if (explicitOverride.model?.id !== "large-one") {
    throw new Error(
      "explicit exact model did not override the configured default",
    );
  }
  assertThrows(
    () =>
      resolveModelSelection(
        catalog,
        [],
        {},
        {
          model: "small-one",
          modelSize: "large",
        },
      ),
    "mutually exclusive",
  );
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
      resolveModelSelection(
        catalog,
        [],
        {
          default: { modelSize: "large" },
          modelSizes: { large: { model: "unadvertised" } },
        },
        {},
      ),
    "not advertised",
  );
});

test("allow and deny patterns filter live model IDs, with deny taking precedence", () => {
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
      resolveModelSelection(
        catalog,
        [],
        { deniedModels: ["claude-*"] },
        {
          model: "claude-opus-5-5-low",
        },
      ),
    "denied",
  );
});

test("effort encoded model IDs preserve exact IDs and saturate max and ultra", () => {
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
  const projected: Array<
    [
      "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra",
      "low" | "medium" | "high",
    ]
  > = [
    ["off", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "high"],
    ["ultra", "high"],
  ];
  for (const [requested, expected] of projected) {
    const resolved = resolveModelSelection(catalog, [], policy, {
      modelSize: "large",
      thinkingEffort: requested,
    });
    if (
      resolved.model?.id !== `claude-opus-${expected}` ||
      resolved.thinkingEffort !== expected
    )
      throw new Error(`${requested} did not project to ${expected}`);
  }
  const exact = resolveModelSelection(catalog, [], policy, {
    model: "claude-opus-medium",
    thinkingEffort: "ultra",
  });
  if (
    exact.model?.id !== "claude-opus-medium" ||
    exact.thinkingEffort !== "medium"
  )
    throw new Error("exact model ID changed or its effort was not projected");
  const deniedEffort = resolveModelSelection(
    catalog,
    [],
    {
      ...policy,
      deniedModels: ["claude-opus-high"],
    },
    { modelSize: "large", thinkingEffort: "high" },
  );
  if (
    deniedEffort.model?.id !== "claude-opus-medium" ||
    deniedEffort.thinkingEffort !== "medium"
  )
    throw new Error("denied encoded effort was not removed before projection");
});

test("separate effort config options project across live advertised choices", () => {
  const catalog = [model("opus", true)];
  const options = [
    {
      id: "reasoning_effort",
      type: "select",
      options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
        value,
        name: value,
      })),
    },
  ];
  const policy: AgentModelPolicy = {
    default: { modelSize: "large" },
    modelSizes: { large: { model: "opus" } },
    thinkingEffort: {
      configOption: "reasoning_effort",
      values: {
        off: "off",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
        ultra: "ultra",
      },
    },
  };
  for (const [requested, expected] of [
    ["off", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
    ["ultra", "max"],
  ] as const) {
    const resolved = resolveModelSelection(catalog, options, policy, {
      thinkingEffort: requested,
    });
    if (
      resolved.thinkingEffort !== expected ||
      resolved.thinkingConfigValue !== expected
    )
      throw new Error(`${requested} did not saturate to ${expected}`);
  }
  const cappedOptions = [
    {
      ...options[0],
      options: options[0].options.slice(0, 3),
    },
  ];
  const capped = resolveModelSelection(catalog, cappedOptions, policy, {
    thinkingEffort: "max",
  });
  if (capped.thinkingEffort !== "high") {
    throw new Error("max did not cap at live high choice");
  }
  const projected = resolveModelSelection(catalog, cappedOptions, policy, {
    thinkingEffort: "xhigh",
  });
  if (
    projected.thinkingEffort !== "high" ||
    projected.thinkingConfigValue !== "high"
  )
    throw new Error("xhigh did not project down to live high choice");
});

test("literal downstream ultra remains selectable when advertised", () => {
  const catalog = [model("effort-low"), model("effort-ultra")];
  const resolved = resolveModelSelection(
    catalog,
    [],
    {
      modelSizes: {
        large: {
          modelsByThinkingEffort: {
            low: "effort-low",
            ultra: "effort-ultra",
          },
        },
      },
    },
    { modelSize: "large", thinkingEffort: "ultra" },
  );
  if (
    resolved.model?.id !== "effort-ultra" ||
    resolved.thinkingEffort !== "ultra"
  ) {
    throw new Error("literal advertised ultra was not preserved");
  }
});

test("normalized effort projects across the complete live scale in both ACP shapes", () => {
  const matrix: Array<
    [ThinkingEffort[], Partial<Record<ThinkingEffort, ThinkingEffort>>]
  > = [
    [
      [...THINKING_EFFORTS],
      Object.fromEntries(THINKING_EFFORTS.map((effort) => [effort, effort])),
    ],
    [["low", "medium", "high", "xhigh", "max"], { off: "low", ultra: "max" }],
    [
      ["low", "medium", "high"],
      {
        off: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    ],
    [
      ["medium", "high"],
      {
        off: "medium",
        low: "medium",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    ],
    [
      ["low", "high"],
      {
        off: "low",
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    ],
    [
      ["high"],
      {
        off: "high",
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    ],
  ];
  for (const [available, expectations] of matrix) {
    for (const [requested, expected] of Object.entries(expectations)) {
      assertProjection(available, requested as ThinkingEffort, expected!);
    }
  }
});

test("model-size policy never falls through to another mapping", () => {
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
