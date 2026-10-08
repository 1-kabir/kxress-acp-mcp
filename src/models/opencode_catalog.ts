import type { DiscoveredModel } from "./discovery.ts";

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_ZEN_DOCS_URL = "https://opencode.ai/docs/zen/";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_GO_DOCS_URL = "https://opencode.ai/docs/go/";

type OpenCodeMetadataSource = "opencode_zen" | "opencode_go";

export type UnderlyingCostTier = "low" | "medium" | "high" | "premium";

export interface OpenCodeModelPricing {
  currency: "USD";
  unit: "per_million_tokens";
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface OpenCodeModelInfo {
  id: string;
  name?: string;
  /** Current per-token pricing, not the model's underlying economic positioning. */
  pricing?: OpenCodeModelPricing;
  /** True only when current published input and output prices are both zero. */
  free?: boolean;
  pricingStatus?: "limited_time";
  /** OpenCode Go usage is included in a paid monthly subscription. */
  subscriptionRequired?: true;
  paidCounterpart?: {
    id: string;
    relation: "exact_paid_counterpart";
    pricing: OpenCodeModelPricing;
    sourceUrl: string;
  };
  underlyingCostTier?: {
    value: UnderlyingCostTier;
    basis: "published_pricing" | "paid_counterpart";
    confidence: "direct" | "documented_counterpart";
    sourceUrl: string;
    counterpartId?: string;
  };
  privacy?: {
    trainingUse?:
      | "not_used_for_training"
      | "may_be_used_for_improvement"
      | "may_be_used_for_training";
    retention?: "zero" | "not_zero" | "thirty_days" | "provider_policy";
    sourceUrl: string;
  };
  provenance?: { source: OpenCodeMetadataSource };
}

export interface OpenCodeCatalog {
  models: Map<string, OpenCodeModelInfo>;
}

const limitedTimeFreeIds = new Set([
  "big-pickle",
  "exo-free",
  "fledge-alpha-free",
  "jev-1.13-free",
  "ling-3.0-flash-fin-free",
  "ling-3.1-flash-free",
  "longcat-2.5-preview-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "space-bunny-free",
]);

/** Exact pair explicitly described by OpenCode's Zen docs. */
const documentedPaidCounterparts = new Map([
  ["jev-1.13-free", "jev-1.13"],
]);

const documentedPrivacy = new Map<string, OpenCodeModelInfo["privacy"]>([
  ["space-bunny-free", {
    trainingUse: "not_used_for_training",
    retention: "zero",
    sourceUrl: OPENCODE_ZEN_DOCS_URL,
  }],
  ["longcat-2.5-preview-free", {
    trainingUse: "not_used_for_training",
    retention: "zero",
    sourceUrl: OPENCODE_ZEN_DOCS_URL,
  }],
  ["jev-1.13-free", {
    trainingUse: "not_used_for_training",
    retention: "provider_policy",
    sourceUrl: OPENCODE_ZEN_DOCS_URL,
  }],
  ["jev-1.13", {
    trainingUse: "not_used_for_training",
    retention: "provider_policy",
    sourceUrl: OPENCODE_ZEN_DOCS_URL,
  }],
  ...[
    "big-pickle",
    "exo-free",
    "fledge-alpha-free",
    "ling-3.0-flash-fin-free",
    "ling-3.1-flash-free",
    "mimo-v2.5-free",
    "mimo-v2.6-flash-free",
  ].map((id) =>
    [id, {
      trainingUse: "may_be_used_for_improvement" as const,
      sourceUrl: OPENCODE_ZEN_DOCS_URL,
    }] as const
  ),
  ...[
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
  ].map((id) =>
    [id, {
      trainingUse: "may_be_used_for_improvement" as const,
      retention: "not_zero" as const,
      sourceUrl: OPENCODE_ZEN_DOCS_URL,
    }] as const
  ),
  ["muse-spark-1.3-contributor-free", {
    trainingUse: "may_be_used_for_training",
    retention: "not_zero",
    sourceUrl: OPENCODE_ZEN_DOCS_URL,
  }],
]);

/** Coarse project bands over max(input, output) USD per 1M tokens. */
export function economicTier(
  pricing: OpenCodeModelPricing | undefined,
): UnderlyingCostTier | undefined {
  if (!pricing) return undefined;
  const representativePrice = Math.max(pricing.input, pricing.output);
  if (representativePrice <= 0) return undefined;
  if (representativePrice < 1) return "low";
  if (representativePrice < 5) return "medium";
  if (representativePrice < 20) return "high";
  return "premium";
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(html: string): string[][][] {
  return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(
    ([, table]) =>
      [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(
        ([, row]) =>
          [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map(([, cell]) => text(cell)),
      ),
  );
}

function price(value: string): number | undefined {
  if (/^free$/i.test(value.trim())) return 0;
  const amounts = [...value.matchAll(/\$([\d,.]+)/g)];
  if (!amounts.length) return undefined;
  const parsed = Number(amounts.at(-1)![1].replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDocs(
  html: string,
  source: OpenCodeMetadataSource,
): Map<string, OpenCodeModelInfo> {
  const tables = tableRows(html);
  const catalogRows =
    tables.find((rows) =>
      rows[0]?.some((cell) => /^(model\s*)?id$/i.test(cell)) &&
      rows[0]?.some((cell) => /^model$/i.test(cell))
    ) ?? [];
  const catalogHeader = catalogRows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const modelColumn = catalogHeader.indexOf("model");
  const idColumn = catalogHeader.findIndex((cell) =>
    /^(model\s*)?id$/.test(cell)
  );
  const idsByName = new Map<string, string>();
  for (const row of catalogRows.slice(1)) {
    if (
      modelColumn < 0 || idColumn < 0 || !row[modelColumn] || !row[idColumn]
    ) continue;
    idsByName.set(row[modelColumn].toLowerCase(), row[idColumn]);
  }

  const pricingRows = tables.find((rows) => {
    const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
    return header.includes("model") && header.includes("input") &&
      header.includes("output") && header.some((cell) =>
        cell.includes("cached read")
      );
  }) ?? [];
  const header = pricingRows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const column = (label: string) => header.indexOf(label);
  const cacheReadColumn = header.findIndex((cell) =>
    cell.includes("cached read")
  );
  const cacheWriteColumn = header.findIndex((cell) =>
    cell.includes("cached write")
  );
  const result = new Map<string, OpenCodeModelInfo>();
  for (const [name, id] of idsByName) {
    result.set(id, {
      id,
      name,
      ...(source === "opencode_go"
        ? { subscriptionRequired: true as const }
        : {}),
      provenance: { source },
    });
  }
  for (const row of pricingRows.slice(1)) {
    const id = idsByName.get((row[0] ?? "").toLowerCase());
    if (!id) continue;
    const input = price(row[column("input")] ?? "");
    const output = price(row[column("output")] ?? "");
    if (input === undefined || output === undefined) continue;
    const cacheRead = cacheReadColumn >= 0
      ? price(row[cacheReadColumn] ?? "")
      : undefined;
    const cacheWrite = cacheWriteColumn >= 0
      ? price(row[cacheWriteColumn] ?? "")
      : undefined;
    result.set(id, {
      ...result.get(id),
      id,
      name: row[0],
      free: input === 0 && output === 0,
      ...(input === 0 && output === 0 && limitedTimeFreeIds.has(id)
        ? { pricingStatus: "limited_time" }
        : {}),
      pricing: {
        currency: "USD",
        unit: "per_million_tokens",
        input,
        output,
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
      },
      ...(source === "opencode_zen" && documentedPrivacy.get(id)
        ? { privacy: documentedPrivacy.get(id) }
        : {}),
    });
  }

  if (source === "opencode_go") {
    const privacyRows = tables.find((rows) => {
      const headers = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
      return headers.includes("model") &&
        headers.some((cell) => cell.includes("model training")) &&
        headers.some((cell) => cell.includes("data retention"));
    }) ?? [];
    const privacyHeader = privacyRows[0]?.map((cell) => cell.toLowerCase()) ??
      [];
    const modelIndex = privacyHeader.indexOf("model");
    const trainingIndex = privacyHeader.findIndex((cell) =>
      cell.includes("model training")
    );
    const retentionIndex = privacyHeader.findIndex((cell) =>
      cell.includes("data retention")
    );
    for (const row of privacyRows.slice(1)) {
      const id = idsByName.get((row[modelIndex] ?? "").toLowerCase());
      if (!id) continue;
      const training = (row[trainingIndex] ?? "").toLowerCase();
      const retentionText = (row[retentionIndex] ?? "").toLowerCase();
      const trainingUse = training === "not used"
        ? "not_used_for_training"
        : training === "yes"
        ? "may_be_used_for_training"
        : undefined;
      const retention = /\b0 days\b/.test(retentionText)
        ? "zero"
        : /\b30 days\b/.test(retentionText)
        ? "thirty_days"
        : /not zdr/.test(retentionText)
        ? "not_zero"
        : undefined;
      const model = result.get(id);
      if (model && (trainingUse || retention)) {
        model.privacy = {
          ...(trainingUse ? { trainingUse } : {}),
          ...(retention ? { retention } : {}),
          sourceUrl: OPENCODE_GO_DOCS_URL,
        };
      }
    }
  }
  return result;
}

export async function fetchOpenCodeCatalog(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OpenCodeCatalog> {
  const models = new Map<string, OpenCodeModelInfo>();
  const catalogs = [
    {
      prefix: "opencode",
      endpoint: OPENCODE_ZEN_MODELS_URL,
      docsUrl: OPENCODE_ZEN_DOCS_URL,
      source: "opencode_zen" as const,
    },
    {
      prefix: "opencode-go",
      endpoint: OPENCODE_GO_MODELS_URL,
      docsUrl: OPENCODE_GO_DOCS_URL,
      source: "opencode_go" as const,
    },
  ];
  for (const catalog of catalogs) {
    const [modelsResponse, docsResponse] = await Promise.all([
      fetcher(catalog.endpoint, { signal }),
      fetcher(catalog.docsUrl, { signal }),
    ]);
    if (!modelsResponse.ok || !docsResponse.ok) {
      throw new Error("OpenCode metadata source unavailable");
    }
    const api = await modelsResponse.json() as {
      data?: Array<{ id?: unknown; owned_by?: unknown }>;
    };
    if (!Array.isArray(api.data)) {
      throw new Error("Invalid OpenCode model catalog");
    }
    const docs = parseDocs(await docsResponse.text(), catalog.source);
    for (const item of api.data) {
      if (typeof item.id !== "string") continue;
      const qualifiedId = `${catalog.prefix}/${item.id}`;
      const detail = docs.get(item.id);
      models.set(qualifiedId, {
        ...(detail ?? { id: item.id }),
        id: qualifiedId,
      });
    }
  }
  for (const [id, counterpartId] of documentedPaidCounterparts) {
    const qualifiedId = `opencode/${id}`;
    const qualifiedCounterpartId = `opencode/${counterpartId}`;
    const model = models.get(qualifiedId);
    const counterpart = models.get(qualifiedCounterpartId);
    if (!model || !counterpart?.pricing) continue;
    model.paidCounterpart = {
      id: qualifiedCounterpartId,
      relation: "exact_paid_counterpart",
      pricing: counterpart.pricing,
      sourceUrl: OPENCODE_ZEN_DOCS_URL,
    };
    const tier = economicTier(counterpart.pricing);
    if (tier) {
      model.underlyingCostTier = {
        value: tier,
        basis: "paid_counterpart",
        confidence: "documented_counterpart",
        sourceUrl: OPENCODE_ZEN_DOCS_URL,
        counterpartId: qualifiedCounterpartId,
      };
    }
  }
  for (const model of models.values()) {
    if (model.underlyingCostTier || model.free) continue;
    const tier = economicTier(model.pricing);
    if (tier) {
      model.underlyingCostTier = {
        value: tier,
        basis: "published_pricing",
        confidence: "direct",
        sourceUrl: model.provenance?.source === "opencode_go"
          ? OPENCODE_GO_DOCS_URL
          : OPENCODE_ZEN_DOCS_URL,
      };
    }
  }
  return { models };
}

export function enrichAdvertisedModels(
  models: DiscoveredModel[],
  catalog: OpenCodeCatalog,
): DiscoveredModel[] {
  return models.map((model) => {
    if (
      !model.id.startsWith("opencode/") &&
      !model.id.startsWith("opencode-go/")
    ) return model;
    const metadata = catalog.models.get(model.id);
    if (!metadata) return model;
    const modelMetadata = {
      ...(metadata.name ? { name: metadata.name } : {}),
      ...(metadata.free === undefined ? {} : { free: metadata.free }),
      ...(metadata.pricing ? { pricing: metadata.pricing } : {}),
      ...(metadata.pricingStatus
        ? { pricingStatus: metadata.pricingStatus }
        : {}),
      ...(metadata.subscriptionRequired
        ? { subscriptionRequired: metadata.subscriptionRequired }
        : {}),
      ...(metadata.paidCounterpart
        ? { paidCounterpart: metadata.paidCounterpart }
        : {}),
      ...(metadata.underlyingCostTier
        ? { underlyingCostTier: metadata.underlyingCostTier }
        : {}),
      ...(metadata.privacy ? { privacy: metadata.privacy } : {}),
      ...(metadata.provenance ? { provenance: metadata.provenance } : {}),
    };
    if (!Object.keys(modelMetadata).length) return model;
    const displayName = model.name.replace(/^opencode\//, "");
    return {
      ...model,
      metadata: modelMetadata,
      name: metadata.name || displayName,
    };
  });
}
