import type { DiscoveredModel } from "./discovery.ts";

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_ZEN_DOCS_URL = "https://opencode.ai/docs/zen/";

export interface OpenCodeModelInfo {
  id: string;
  name?: string;
  free?: boolean;
  pricing?: {
    currency: "USD";
    unit: "per_million_tokens";
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface OpenCodeCatalog {
  models: Map<string, OpenCodeModelInfo>;
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

function parseDocs(html: string): Map<string, OpenCodeModelInfo> {
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
      id,
      name: row[0],
      free: input === 0 && output === 0,
      pricing: {
        currency: "USD",
        unit: "per_million_tokens",
        input,
        output,
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
      },
    });
  }
  return result;
}

export async function fetchOpenCodeZenCatalog(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OpenCodeCatalog> {
  const [modelsResponse, docsResponse] = await Promise.all([
    fetcher(OPENCODE_ZEN_MODELS_URL, { signal }),
    fetcher(OPENCODE_ZEN_DOCS_URL, { signal }),
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
  const docs = parseDocs(await docsResponse.text());
  const models = new Map<string, OpenCodeModelInfo>();
  for (const item of api.data) {
    if (typeof item.id !== "string") continue;
    const detail = docs.get(item.id);
    models.set(item.id, detail ?? { id: item.id });
  }
  return { models };
}

export function enrichAdvertisedModels(
  models: DiscoveredModel[],
  catalog: OpenCodeCatalog,
): DiscoveredModel[] {
  return models.map((model) => {
    if (!model.id.startsWith("opencode/")) return model;
    const catalogId = model.id.slice("opencode/".length);
    const metadata = catalog.models.get(catalogId);
    if (!metadata) return model;
    const displayName = model.name.replace(/^opencode\//, "");
    return {
      ...model,
      metadata: {
        ...(metadata.name ? { name: metadata.name } : {}),
        ...(metadata.free === undefined ? {} : { free: metadata.free }),
        ...(metadata.pricing ? { pricing: metadata.pricing } : {}),
      },
      name: model.name || metadata.name || displayName,
    };
  });
}
