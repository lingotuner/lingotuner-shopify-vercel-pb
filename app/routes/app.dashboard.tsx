import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  parseLocaleMappings,
  resolveShopifyLocaleForApiLanguage,
  resolveShopifyLocaleForApiLanguages,
  type LocaleMappings,
} from "../lib/locale-mappings";
import { insertTranslationLog, resolveTranslationEngine } from "../lib/translation-log.server";
import {
  computeItemCompleteness,
  computeProgressStats,
  matchesStatusFilter,
  progressPercent,
  requiredAttributeFields,
  requiredCategoryFields,
  requiredOptionValueFields,
  requiredProductFields,
  statusBadgeColors,
  statusBadgeLabel,
  statusTooltip,
  type AppliedByLocale,
  type ItemCompleteness,
  type ItemTranslationStateRow,
  type ProgressContentType,
} from "../lib/translation-progress";
import {
  getItemTranslationStatesByShop,
  mergeItemAppliedFields,
} from "../lib/translation-progress.server";

type LanguageOption = { code: string; name: string };
type ProductRow = {
  id: string;
  numericId: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  options: string[];
  optionValues: Array<{ optionName: string; optionKey: string; valueId: string; valueName: string; valueIndex: number }>;
  metafieldKeys: string[];
};
type CategoryRow = {
  id: string;
  numericId: string;
  title: string;
  handle: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  metafieldKeys: string[];
};
type ProductOptionValueRow = { id: string; name: string };
type ProductOptionRow = { id: string; name: string; optionValues?: ProductOptionValueRow[] };
type AttributePickerOption = { value: string; label: string };
type RequestRow = {
  requestUid: string;
  languages: string;
  storeLocale: string | null;
  contentType: string;
  itemId: string | null;
  itemTitle: string | null;
  status: string;
  isTranslated: boolean;
  createdAt: string;
};
type RequestDbRow = Omit<RequestRow, "createdAt"> & { createdAt: Date };
type RequestLookupRow = {
  requestUid: string;
  languages: string;
  storeLocale: string | null;
  contentType: string;
  itemId: string | null;
  itemTitle: string | null;
};
type ContentBlock = { key: string; name: string; value: string };
type SettingsRow = { fetchedLanguages: string | null };
type TranslatorApiSettingsRow = {
  apiKey: string;
  apiBaseUrl: string;
  translationEngine: string;
  enabled: boolean;
};
type StoreLocaleRow = {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
};
type AttributeIndexSnapshot = {
  generatedAt: string;
  totalProductsScanned: number;
  attributes: AttributePickerOption[];
};
type ActionData = {
  ok: boolean;
  intent: string;
  message: string;
  requests?: RequestRow[];
  translationStates?: ItemTranslationStateRow[];
};

function parseCachedLanguages(payload: string | null | undefined): LanguageOption[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as LanguageOption[];
    return Array.isArray(parsed) ? parsed.filter((x) => x?.code && x?.name) : [];
  } catch {
    return [];
  }
}

function parseAttributeIndexSnapshot(payload: string | null | undefined): AttributeIndexSnapshot | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<AttributeIndexSnapshot>;
    if (!parsed || !Array.isArray(parsed.attributes)) return null;
    const attributes = parsed.attributes
      .filter((entry) => entry && typeof entry.value === "string" && typeof entry.label === "string")
      .map((entry) => ({ value: entry.value.trim(), label: entry.label.trim() }))
      .filter((entry) => entry.value && entry.label);
    if (!attributes.length) return null;
    return {
      generatedAt: String(parsed.generatedAt ?? ""),
      totalProductsScanned: Number(parsed.totalProductsScanned ?? 0),
      attributes,
    };
  } catch {
    return null;
  }
}

async function getLatestAttributeIndexByShop(shop: string): Promise<AttributeIndexSnapshot | null> {
  const row = await prisma.translationLog.findFirst({
    where: { shop, action: "attribute_index_snapshot" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  return parseAttributeIndexSnapshot(row?.metadata);
}

async function getCachedLanguagesByShop(shop: string): Promise<LanguageOption[]> {
  const row = await prisma.translatorSettings.findUnique({
    where: { shop },
    select: { fetchedLanguages: true },
  });
  return parseCachedLanguages(row?.fetchedLanguages);
}

async function getLocaleMappingsByShop(shop: string): Promise<LocaleMappings> {
  const row = await prisma.translatorSettings.findUnique({
    where: { shop },
    select: { localeMappings: true },
  });
  return parseLocaleMappings(row?.localeMappings);
}

async function getApiSettingsByShop(shop: string): Promise<TranslatorApiSettingsRow | null> {
  const row = await prisma.translatorSettings.findUnique({
    where: { shop },
    select: {
      apiKey: true,
      apiBaseUrl: true,
      translationEngine: true,
      enabled: true,
    },
  });
  return row ?? null;
}

async function getLocalRequestsByShop(shop: string): Promise<RequestRow[]> {
  const rows: RequestDbRow[] = await prisma.translationRequest.findMany({
    where: { shop },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
    select: {
      requestUid: true,
      languages: true,
      storeLocale: true,
      contentType: true,
      itemId: true,
      itemTitle: true,
      status: true,
      isTranslated: true,
      createdAt: true,
    },
  });
  return rows.map((row: RequestDbRow) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function getLocalRequestByUid(shop: string, requestUid: string): Promise<RequestLookupRow | null> {
  const row = await prisma.translationRequest.findUnique({
    where: {
      shop_requestUid: { shop, requestUid },
    },
    select: {
      requestUid: true,
      languages: true,
      storeLocale: true,
      contentType: true,
      itemId: true,
      itemTitle: true,
    },
  });
  return row ?? null;
}

async function upsertLocalRequest(
  shop: string,
  request: Omit<RequestRow, "createdAt">,
) {
  await prisma.translationRequest.upsert({
    where: {
      shop_requestUid: { shop, requestUid: request.requestUid },
    },
    update: {
      languages: request.languages,
      contentType: request.contentType,
      status: request.status,
      isTranslated: request.isTranslated,
      ...(request.storeLocale !== null ? { storeLocale: request.storeLocale } : {}),
      ...(request.itemId !== null ? { itemId: request.itemId } : {}),
      ...(request.itemTitle !== null ? { itemTitle: request.itemTitle } : {}),
    },
    create: {
      shop,
      requestUid: request.requestUid,
      languages: request.languages,
      storeLocale: request.storeLocale,
      contentType: request.contentType,
      itemId: request.itemId,
      itemTitle: request.itemTitle,
      status: request.status,
      isTranslated: request.isTranslated,
    },
  });
}

async function markTranslated(shop: string, requestUid: string) {
  await prisma.translationRequest.updateMany({
    where: { shop, requestUid },
    data: { isTranslated: true },
  });
}

async function recordAppliedFieldsSafe(args: {
  shop: string;
  contentType: string;
  itemId: string | null | undefined;
  storeLocale: string;
  fields: string[];
}) {
  if (!args.itemId || !args.storeLocale || !args.fields.length) return;
  try {
    await mergeItemAppliedFields({
      shop: args.shop,
      contentType: args.contentType,
      itemId: String(args.itemId),
      storeLocale: args.storeLocale,
      fields: args.fields,
    });
  } catch {
    // Progress tracking must not block apply success.
  }
}

async function withTranslationStates(
  shop: string,
  payload: ActionData,
): Promise<ActionData> {
  try {
    return {
      ...payload,
      translationStates: await loadTranslationStatesPayload(shop),
    };
  } catch {
    return payload;
  }
}

async function deleteLocalRequest(shop: string, requestUid: string) {
  await prisma.translationRequest.deleteMany({
    where: { shop, requestUid },
  });
}

async function updateLocalRequestStatus(shop: string, requestUid: string, status: string) {
  await prisma.translationRequest.updateMany({
    where: { shop, requestUid },
    data: { status },
  });
}

function normalizeBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function toFieldKey(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function loadTranslationStatesPayload(shop: string): Promise<ItemTranslationStateRow[]> {
  return getItemTranslationStatesByShop(shop);
}

const TEXT_METAFIELD_TYPES = new Set([
  "single_line_text_field",
  "multi_line_text_field",
  "rich_text_field",
  "list.single_line_text_field",
  "list.multi_line_text_field",
]);

function metafieldSelectValue(namespace: string, key: string) {
  return `mf__${toFieldKey(namespace)}__${toFieldKey(key)}`;
}

function blockValueToString(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw == null) return "";
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return String(raw).trim();
}

/** Shopify rejects plain text for rich_text / list metafield translations. */
function normalizeMetafieldTranslationValue(type: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  if (type === "rich_text_field") {
    try {
      const parsed = JSON.parse(trimmed) as { type?: string };
      if (parsed && typeof parsed === "object" && parsed.type === "root") {
        return trimmed;
      }
    } catch {
      // Plain text / HTML from translator — wrap as Shopify rich text JSON.
    }
    const plain = trimmed
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();
    const paragraphs = (plain || trimmed).split(/\n+/).filter(Boolean);
    return JSON.stringify({
      type: "root",
      children: (paragraphs.length ? paragraphs : [trimmed]).map((paragraph) => ({
        type: "paragraph",
        children: [{ type: "text", value: paragraph }],
      })),
    });
  }

  if (type === "list.single_line_text_field" || type === "list.multi_line_text_field") {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map((item) => String(item)));
    } catch {
      // Single translated string — store as one-item list.
    }
    return JSON.stringify([trimmed]);
  }

  return trimmed;
}

function parseMetafieldSelectKey(selectKey: string): { namespace: string; key: string } | null {
  const parts = selectKey.trim().toLowerCase().split("__").filter(Boolean);
  if (parts[0] !== "mf" || parts.length < 3) return null;
  return { namespace: parts[1], key: parts.slice(2).join("__") };
}

type MetafieldKeyNode = {
  namespace?: string | null;
  key?: string | null;
  type?: string | null;
};

function collectTextMetafieldKeys(
  edges: Array<{ node?: MetafieldKeyNode | null } | null> | null | undefined,
) {
  return Array.from(
    new Set(
      (edges ?? [])
        .map((edge) => edge?.node)
        .filter(
          (node): node is { namespace: string; key: string; type: string } =>
            Boolean(
              node?.namespace &&
                node.key &&
                TEXT_METAFIELD_TYPES.has(String(node.type ?? "")),
            ),
        )
        .map((node) => metafieldSelectValue(String(node.namespace), String(node.key))),
    ),
  );
}

function mapMetafieldDefinitionOptions(
  edges: Array<{
    node?: {
      name?: string | null;
      namespace?: string | null;
      key?: string | null;
      type?: { name?: string | null } | null;
    } | null;
  } | null> | null | undefined,
) {
  const options: AttributePickerOption[] = [];
  const seen = new Set<string>();
  (edges ?? []).forEach((edge) => {
    const node = edge?.node;
    const namespace = String(node?.namespace ?? "").trim();
    const key = String(node?.key ?? "").trim();
    const name = String(node?.name ?? "").trim();
    const typeName = String(node?.type?.name ?? "").trim();
    if (!namespace || !key || !TEXT_METAFIELD_TYPES.has(typeName)) return;
    const value = metafieldSelectValue(namespace, key);
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: `${name || key} (Metafield ${namespace}.${key})` });
  });
  return options;
}

function isDefaultNonAttributeOption(input: string) {
  const key = toFieldKey(input);
  return key === "title";
}

function attributeFieldLabel(fieldKey: string) {
  const key = fieldKey.trim().toLowerCase();
  if (key.startsWith("prod_attr_name_")) {
    return key
      .replace("prod_attr_name_", "")
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  if (key.startsWith("mf__")) {
    const parts = key.split("__");
    const namespace = parts[1] ?? "";
    const metafieldKey = parts.slice(2).join("__");
    return `Metafield ${namespace}.${metafieldKey}`;
  }
  return fieldKey;
}

function joinApiUrl(baseUrl: string, suffix: string) {
  const base = normalizeBaseUrl(baseUrl);
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  return new URL(suffix, withSlash).toString();
}

function parseJsonSafe(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function extractRequestUid(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const direct = obj.requestId ?? obj.requestID ?? obj.id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (obj.data && typeof obj.data === "object") {
    const dataObj = obj.data as Record<string, unknown>;
    const nested = dataObj.requestId ?? dataObj.requestID ?? dataObj.id;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

function parseTranslatedBlocks(
  payload: unknown,
  preferredLocale?: string | string[],
): ContentBlock[] {
  const preferredLocales = (
    Array.isArray(preferredLocale) ? preferredLocale : [preferredLocale]
  )
    .map((code) => String(code ?? "").trim().toLowerCase())
    .filter(Boolean);

  const mapContentItems = (content: unknown[]): ContentBlock[] =>
    content
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const key = String(row.key ?? "").trim();
        const value = blockValueToString(row.value);
        if (!key || !value) return null;
        return { key, name: String(row.name ?? key), value };
      })
      .filter((x): x is ContentBlock => Boolean(x));

  const fromArrayLanguagePayload = () => {
    if (!Array.isArray(payload) || !payload.length) return [] as ContentBlock[];
    const selected =
      payload.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const row = entry as Record<string, unknown>;
        const locale = String(row.locale ?? row.language ?? row.lang ?? "")
          .trim()
          .toLowerCase();
        return preferredLocales.includes(locale);
      }) ?? payload[0];
    if (!selected || typeof selected !== "object") return [] as ContentBlock[];
    const content = (selected as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [] as ContentBlock[];
    return mapContentItems(content);
  };

  const fromObjectPayload = () => {
    if (!payload || typeof payload !== "object") return [] as ContentBlock[];
    const obj = payload as Record<string, unknown>;
    const candidate =
      (Array.isArray(obj.content) ? obj.content : null) ??
      (obj.data && typeof obj.data === "object" && Array.isArray((obj.data as Record<string, unknown>).content)
        ? ((obj.data as Record<string, unknown>).content as unknown[])
        : null);
    if (!candidate) return [] as ContentBlock[];
    return mapContentItems(candidate);
  };

  return fromArrayLanguagePayload().length
    ? fromArrayLanguagePayload()
    : fromObjectPayload();
}

function parseRemoteRequests(payload: unknown): RequestRow[] {
  const objectPayload = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const items =
    (Array.isArray(objectPayload.items) ? objectPayload.items : null) ??
    (objectPayload.data &&
    typeof objectPayload.data === "object" &&
    Array.isArray((objectPayload.data as Record<string, unknown>).items)
      ? ((objectPayload.data as Record<string, unknown>).items as unknown[])
      : null) ??
    [];

  const parsedRows: RequestRow[] = [];
  items.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const requestUid = String(row.requestId ?? row.requestID ?? "").trim();
    if (!requestUid) return;

    const languages = Array.isArray(row.languages) ? row.languages.map(String).join(",") : "";
    const contentType = String(row.type ?? row.contentType ?? "product") || "product";
    const itemIdRaw =
      row.identifier ??
      (row.data && typeof row.data === "object"
        ? (row.data as Record<string, unknown>).identifier
        : null);
    const itemId = itemIdRaw === null || itemIdRaw === undefined ? null : String(itemIdRaw);
    const createdAt = String(
      row.createdAt ?? row.createdDate ?? row.dateCreated ?? row.created_at ?? new Date().toISOString(),
    );

    parsedRows.push({
      requestUid,
      languages,
      storeLocale: null,
      contentType,
      itemId,
      itemTitle: null,
      status: String(row.status ?? "Pending").trim(),
      isTranslated: false,
      createdAt,
    });
  });

  return parsedRows;
}

async function fetchRemoteRequestsFromApi(settings: TranslatorApiSettingsRow) {
  const statuses = ["Pending", "Started", "Completed", "pending", "started", "completed"];
  const merged: RequestRow[] = [];
  const seen = new Set<string>();
  const pageSize = 100;
  const maxPages = 20;

  const fetchByMode = async (mode: "all" | "status", statusValue?: string) => {
    for (let page = 1; page <= maxPages; page += 1) {
      const offset = (page - 1) * pageSize;
      const endpoint = new URL(joinApiUrl(settings.apiBaseUrl, "search-resource"));
      if (mode === "status" && statusValue) {
        endpoint.searchParams.set("status", statusValue);
      }
      endpoint.searchParams.set("pageSize", String(pageSize));
      endpoint.searchParams.set("pageNumber", String(page));
      endpoint.searchParams.set("offset", String(offset));
      endpoint.searchParams.set("skip", String(offset));
      endpoint.searchParams.set("limit", String(pageSize));
      endpoint.searchParams.set("take", String(pageSize));

      const response = await fetch(endpoint.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "api-key": settings.apiKey,
          Authorization: `Bearer ${settings.apiKey}`,
        },
      });

      if (!response.ok) break;

      const responseText = await response.text();
      const parsed = parseJsonSafe(responseText);
      const rows = parseRemoteRequests(parsed);
      if (!rows.length) break;

      rows.forEach((row) => {
        if (seen.has(row.requestUid)) return;
        seen.add(row.requestUid);
        merged.push(row);
      });

      if (rows.length < pageSize) break;
    }
  };

  // WooCommerce backends may ignore/handle status filters differently.
  // So first fetch all requests without status filter.
  await fetchByMode("all");

  // Fallback: if API needs status explicitly, fetch each status variant.
  if (!merged.length) {
    for (const status of statuses) {
      await fetchByMode("status", status);
    }
  }

  return merged;
}

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type ResolvedMetafield = {
  id: string;
  namespace: string;
  key: string;
  type: string;
};

async function resolveOwnerMetafield(
  admin: AdminGraphqlClient,
  ownerGid: string,
  selectKey: string,
  existing: ResolvedMetafield[],
): Promise<ResolvedMetafield | null> {
  const matched = existing.find(
    (metafield) => metafieldSelectValue(metafield.namespace, metafield.key) === selectKey,
  );
  if (matched) return matched;

  const parsed = parseMetafieldSelectKey(selectKey);
  if (!parsed) return null;

  try {
    const response = await admin.graphql(
      `#graphql
      query OwnerMetafieldByNamespaceKey($ownerId: ID!, $namespace: String!, $key: String!) {
        node(id: $ownerId) {
          ... on Product {
            metafield(namespace: $namespace, key: $key) {
              id
              namespace
              key
              type
            }
          }
          ... on Collection {
            metafield(namespace: $namespace, key: $key) {
              id
              namespace
              key
              type
            }
          }
        }
      }`,
      {
        variables: {
          ownerId: ownerGid,
          namespace: parsed.namespace,
          key: parsed.key,
        },
      },
    );
    const json = (await response.json()) as {
      data?: {
        node?: {
          metafield?: {
            id?: string | null;
            namespace?: string | null;
            key?: string | null;
            type?: string | null;
          } | null;
        } | null;
      };
    };
    const node = json.data?.node?.metafield;
    if (!node?.id || !node.namespace || !node.key) return null;
    return {
      id: String(node.id),
      namespace: String(node.namespace),
      key: String(node.key),
      type: String(node.type ?? ""),
    };
  } catch {
    return null;
  }
}

const DASHBOARD_PAGE_SIZE = 250;
const DASHBOARD_MAX_PAGES = 600;

async function fetchAllDashboardProducts(admin: AdminGraphqlClient): Promise<ProductRow[]> {
  const products: ProductRow[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage && pageCount < DASHBOARD_MAX_PAGES) {
    const response = await admin.graphql(
      `#graphql
      query DashboardProducts($after: String) {
        products(first: ${DASHBOARD_PAGE_SIZE}, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              descriptionHtml
              options {
                name
                optionValues {
                  id
                  name
                }
              }
              metafields(first: 50) {
                edges {
                  node {
                    namespace
                    key
                    type
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { after: cursor } },
    );
    const json = (await response.json()) as {
      data?: {
        products?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          edges?: Array<{
            node: {
              id: string;
              title: string;
              handle: string;
              descriptionHtml?: string | null;
              options?: Array<{
                name: string;
                optionValues?: Array<{ id: string; name: string }>;
              }>;
              metafields?: {
                edges?: Array<{
                  node?: {
                    namespace?: string | null;
                    key?: string | null;
                    type?: string | null;
                  } | null;
                }>;
              } | null;
            };
          }>;
        };
      };
    };
    const page = json.data?.products;
    const edges = page?.edges ?? [];
    for (const edge of edges) {
      const metafieldKeys = collectTextMetafieldKeys(edge.node.metafields?.edges);
      const optionValues: ProductRow["optionValues"] = [];
      for (const option of edge.node.options ?? []) {
        const optionKey = toFieldKey(option.name);
        (option.optionValues ?? []).forEach((value, index) => {
          optionValues.push({
            optionName: option.name,
            optionKey,
            valueId: value.id,
            valueName: value.name,
            valueIndex: index + 1,
          });
        });
      }
      products.push({
        id: edge.node.id,
        numericId: edge.node.id.split("/").pop() ?? edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        descriptionHtml: edge.node.descriptionHtml ?? "",
        options: (edge.node.options ?? []).map((option) => option.name),
        optionValues,
        metafieldKeys,
      });
    }
    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor ?? null;
    pageCount += 1;
  }

  return products;
}

async function fetchAllDashboardCategories(admin: AdminGraphqlClient): Promise<CategoryRow[]> {
  const categories: CategoryRow[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage && pageCount < DASHBOARD_MAX_PAGES) {
    const response = await admin.graphql(
      `#graphql
      query DashboardCategories($after: String) {
        collections(first: ${DASHBOARD_PAGE_SIZE}, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              descriptionHtml
              seo {
                title
                description
              }
              metafields(first: 50) {
                edges {
                  node {
                    namespace
                    key
                    type
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { after: cursor } },
    );
    const json = (await response.json()) as {
      data?: {
        collections?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          edges?: Array<{
            node: {
              id: string;
              title: string;
              handle: string;
              descriptionHtml?: string | null;
              seo?: { title?: string | null; description?: string | null } | null;
              metafields?: {
                edges?: Array<{
                  node?: MetafieldKeyNode | null;
                }>;
              } | null;
            };
          }>;
        };
      };
    };
    const page = json.data?.collections;
    const edges = page?.edges ?? [];
    for (const edge of edges) {
      categories.push({
        id: edge.node.id,
        numericId: edge.node.id.split("/").pop() ?? edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        description: String(edge.node.descriptionHtml ?? ""),
        seoTitle: String(edge.node.seo?.title ?? ""),
        seoDescription: String(edge.node.seo?.description ?? ""),
        metafieldKeys: collectTextMetafieldKeys(edge.node.metafields?.edges),
      });
    }
    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor ?? null;
    pageCount += 1;
  }

  return categories;
}

async function fetchAllProductIds(admin: AdminGraphqlClient): Promise<string[]> {
  const ids: string[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage && pageCount < DASHBOARD_MAX_PAGES) {
    const response = await admin.graphql(
      `#graphql
      query AttributeModeProducts($after: String) {
        products(first: ${DASHBOARD_PAGE_SIZE}, after: $after, sortKey: UPDATED_AT, reverse: true) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
            }
          }
        }
      }`,
      { variables: { after: cursor } },
    );
    const json = (await response.json()) as {
      data?: {
        products?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          edges?: Array<{ node?: { id?: string | null } | null }>;
        };
      };
    };
    const page = json.data?.products;
    const edges = page?.edges ?? [];
    for (const edge of edges) {
      const id = String(edge?.node?.id ?? "").trim();
      if (id) ids.push(id);
    }
    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor ?? null;
    pageCount += 1;
  }

  return ids;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [
    productResult,
    categoryResult,
    metafieldDefinitionsResult,
    collectionMetafieldDefinitionsResult,
    requestsResult,
    cachedLanguagesResult,
    attributeIndexResult,
    localeMappingsResult,
    translationStatesResult,
  ] = await Promise.allSettled([
    fetchAllDashboardProducts(admin),
    fetchAllDashboardCategories(admin),
    admin.graphql(
      `#graphql
      query DashboardProductMetafieldDefinitions {
        metafieldDefinitions(first: 250, ownerType: PRODUCT) {
          edges {
            node {
              name
              namespace
              key
              type {
                name
              }
            }
          }
        }
      }`,
    ),
    admin.graphql(
      `#graphql
      query DashboardCollectionMetafieldDefinitions {
        metafieldDefinitions(first: 250, ownerType: COLLECTION) {
          edges {
            node {
              name
              namespace
              key
              type {
                name
              }
            }
          }
        }
      }`,
    ),
    getLocalRequestsByShop(session.shop),
    getCachedLanguagesByShop(session.shop),
    getLatestAttributeIndexByShop(session.shop),
    getLocaleMappingsByShop(session.shop),
    getItemTranslationStatesByShop(session.shop),
  ]);

  if (
    productResult.status === "rejected" ||
    categoryResult.status === "rejected" ||
    metafieldDefinitionsResult.status === "rejected" ||
    collectionMetafieldDefinitionsResult.status === "rejected"
  ) {
    await insertTranslationLog({
      shop: session.shop,
      level: "error",
      contentType: "configuration",
      action: "dashboard_loader_graphql_failed",
      message: "Failed to fetch one or more Shopify dashboard GraphQL resources.",
      metadata: {
        productError:
          productResult.status === "rejected" ? String(productResult.reason) : null,
        categoryError:
          categoryResult.status === "rejected" ? String(categoryResult.reason) : null,
        metafieldDefinitionsError:
          metafieldDefinitionsResult.status === "rejected"
            ? String(metafieldDefinitionsResult.reason)
            : null,
        collectionMetafieldDefinitionsError:
          collectionMetafieldDefinitionsResult.status === "rejected"
            ? String(collectionMetafieldDefinitionsResult.reason)
            : null,
      },
    });
  }

  const requests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const cachedLanguages =
    cachedLanguagesResult.status === "fulfilled" ? cachedLanguagesResult.value : [];
  const attributeIndex =
    attributeIndexResult.status === "fulfilled" ? attributeIndexResult.value : null;
  const localeMappings =
    localeMappingsResult.status === "fulfilled" ? localeMappingsResult.value : {};
  const translationStates =
    translationStatesResult.status === "fulfilled" ? translationStatesResult.value : [];

  const products: ProductRow[] =
    productResult.status === "fulfilled" ? productResult.value : [];

  const categories: CategoryRow[] =
    categoryResult.status === "fulfilled" ? categoryResult.value : [];

  const metafieldDefinitionsJson = (
    metafieldDefinitionsResult.status === "fulfilled"
      ? await metafieldDefinitionsResult.value.json()
      : { data: { metafieldDefinitions: { edges: [] } } }
  ) as {
    data?: {
      metafieldDefinitions?: {
        edges?: Array<{
          node?: {
            name?: string | null;
            namespace?: string | null;
            key?: string | null;
            type?: { name?: string | null } | null;
          } | null;
        }>;
      };
    };
  };
  const collectionMetafieldDefinitionsJson = (
    collectionMetafieldDefinitionsResult.status === "fulfilled"
      ? await collectionMetafieldDefinitionsResult.value.json()
      : { data: { metafieldDefinitions: { edges: [] } } }
  ) as {
    data?: {
      metafieldDefinitions?: {
        edges?: Array<{
          node?: {
            name?: string | null;
            namespace?: string | null;
            key?: string | null;
            type?: { name?: string | null } | null;
          } | null;
        }>;
      };
    };
  };

  const discoveredAttributeFields: AttributePickerOption[] = [];
  const seenAttributeValues = new Set<string>();
  const pushAttribute = (value: string, label: string) => {
    if (!value || seenAttributeValues.has(value)) return;
    seenAttributeValues.add(value);
    discoveredAttributeFields.push({ value, label });
  };

  const sampledOptionNames = Array.from(
    new Set(
      products.flatMap((product) =>
        (product.options ?? []).map((optionName) => String(optionName ?? "").trim()).filter(Boolean),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b));
  sampledOptionNames.forEach((optionName) => {
    if (isDefaultNonAttributeOption(optionName)) return;
    pushAttribute(`prod_attr_name_${toFieldKey(optionName)}`, `${optionName} (Attribute Name)`);
  });

  mapMetafieldDefinitionOptions(metafieldDefinitionsJson.data?.metafieldDefinitions?.edges).forEach(
    (entry) => pushAttribute(entry.value, entry.label),
  );

  const discoveredCategoryMetafieldFields = mapMetafieldDefinitionOptions(
    collectionMetafieldDefinitionsJson.data?.metafieldDefinitions?.edges,
  );

  let localeAccessLimited = false;
  let storeLocales: StoreLocaleRow[] = [];

  try {
    const localesResponse = await admin.graphql(
      `#graphql
      query DashboardLocales {
        shopLocales {
          locale
          name
          primary
          published
        }
      }`,
    );
    const localesJson = (await localesResponse.json()) as {
      data?: {
        shopLocales?: StoreLocaleRow[];
      };
    };
    storeLocales = localesJson.data?.shopLocales ?? [];
  } catch {
    localeAccessLimited = true;
  }

  // Prefer live Shopify discovery, then merge any extra fields from the cached attribute index.
  if (attributeIndex?.attributes?.length) {
    attributeIndex.attributes.forEach((entry) => {
      pushAttribute(entry.value, entry.label);
    });
  }

  const attributeFields = discoveredAttributeFields;

  return {
    products,
    categories,
    apiLanguages: cachedLanguages,
    localeMappings,
    storeLocales,
    localeAccessLimited,
    requests,
    translationStates,
    discoveredAttributeFields: attributeFields,
    discoveredCategoryMetafieldFields,
    attributeIndexMeta: attributeIndex
      ? {
          generatedAt: attributeIndex.generatedAt,
          totalProductsScanned: attributeIndex.totalProductsScanned,
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "start_translation");

  if (intent === "refresh_requests") {
    const settings = await getApiSettingsByShop(session.shop);
    if (!settings?.enabled) {
      return { ok: false, intent, message: "Save and enable settings first." } satisfies ActionData;
    }
    const parsedRows = await fetchRemoteRequestsFromApi(settings);
    for (const row of parsedRows) {
      await upsertLocalRequest(session.shop, {
        requestUid: row.requestUid,
        languages: row.languages,
        storeLocale: row.storeLocale,
        contentType: row.contentType,
        itemId: row.itemId,
        itemTitle: row.itemTitle,
        status: row.status,
        isTranslated: row.isTranslated,
      });
    }

    // WooCommerce API can return only a partial/stale request list from search-resource.
    // Fallback: probe pending/started local requests directly via get-content-translated.
    const currentLocal = await getLocalRequestsByShop(session.shop);
    const probeCandidates = currentLocal.filter((row) => {
      const status = row.status.toLowerCase();
      return status === "pending" || status === "started";
    });

    let fallbackCompleted = 0;
    for (const row of probeCandidates) {
      const probeEndpoint = joinApiUrl(
        settings.apiBaseUrl,
        `${encodeURIComponent(row.requestUid)}/get-content-translated`,
      );
      try {
        const probe = await fetch(probeEndpoint, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": settings.apiKey,
            "api-key": settings.apiKey,
            Authorization: `Bearer ${settings.apiKey}`,
          },
        });
        if (probe.ok) {
          await updateLocalRequestStatus(session.shop, row.requestUid, "Completed");
          fallbackCompleted += 1;
        }
      } catch {
        // Ignore probe failures for individual requests.
      }
    }

    await insertTranslationLog({
      shop: session.shop,
      level: "success",
      contentType: "others",
      action: "refresh_requests",
      message:
        fallbackCompleted > 0
          ? `Requests refreshed (${parsedRows.length} rows), fallback completed ${fallbackCompleted}.`
          : `Requests refreshed (${parsedRows.length} rows).`,
    });
    return withTranslationStates(session.shop, {
      ok: true,
      intent,
      message: "Statuses refreshed from API.",
      requests: await getLocalRequestsByShop(session.shop),
    });
  }

  if (intent === "sync_attribute_index") {
    const optionNameSet = new Set<string>();
    let hasNextPage = true;
    let cursor: string | null = null;
    let scannedProducts = 0;
    let pageCount = 0;
    const maxPages = 600;

    while (hasNextPage && pageCount < maxPages) {
      const response = await admin.graphql(
        `#graphql
        query SyncAttributeIndexProducts($after: String) {
          products(first: 250, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                options {
                  name
                }
              }
            }
          }
        }`,
        { variables: { after: cursor } },
      );
      const json = (await response.json()) as {
        data?: {
          products?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            edges?: Array<{ node?: { options?: Array<{ name?: string | null } | null> } | null }>;
          };
        };
      };
      const page = json.data?.products;
      const edges = page?.edges ?? [];
      scannedProducts += edges.length;
      edges.forEach((edge) => {
        const options = edge?.node?.options ?? [];
        options.forEach((option) => {
          const name = String(option?.name ?? "").trim();
          if (name) optionNameSet.add(name);
        });
      });
      hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
      cursor = page?.pageInfo?.endCursor ?? null;
      pageCount += 1;
    }

    const metafieldResponse = await admin.graphql(
      `#graphql
      query SyncAttributeIndexMetafields {
        metafieldDefinitions(first: 250, ownerType: PRODUCT) {
          edges {
            node {
              name
              namespace
              key
              type {
                name
              }
            }
          }
        }
      }`,
    );
    const metafieldJson = (await metafieldResponse.json()) as {
      data?: {
        metafieldDefinitions?: {
          edges?: Array<{
            node?: {
              name?: string | null;
              namespace?: string | null;
              key?: string | null;
              type?: { name?: string | null } | null;
            } | null;
          }>;
        };
      };
    };

    const attributes: AttributePickerOption[] = Array.from(optionNameSet)
      .filter((name) => !isDefaultNonAttributeOption(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        value: `prod_attr_name_${toFieldKey(name)}`,
        label: `${name} (Attribute Name)`,
      }));

    const seenValues = new Set(attributes.map((entry) => entry.value));
    (metafieldJson.data?.metafieldDefinitions?.edges ?? []).forEach((edge) => {
      const node = edge.node;
      const namespace = String(node?.namespace ?? "").trim();
      const key = String(node?.key ?? "").trim();
      const name = String(node?.name ?? "").trim();
      const typeName = String(node?.type?.name ?? "").trim();
      if (!namespace || !key || !TEXT_METAFIELD_TYPES.has(typeName)) return;
      const value = metafieldSelectValue(namespace, key);
      if (seenValues.has(value)) return;
      seenValues.add(value);
      attributes.push({ value, label: `${name || key} (Metafield ${namespace}.${key})` });
    });

    const snapshot: AttributeIndexSnapshot = {
      generatedAt: new Date().toISOString(),
      totalProductsScanned: scannedProducts,
      attributes,
    };

    await insertTranslationLog({
      shop: session.shop,
      level: "success",
      contentType: "others",
      action: "attribute_index_snapshot",
      message: `Attribute index synced with ${attributes.length} fields from ${scannedProducts} products.`,
      metadata: JSON.stringify(snapshot),
    });

    return {
      ok: true,
      intent,
      message: `Attribute index synced (${attributes.length} fields, ${scannedProducts} products scanned).`,
      requests: await getLocalRequestsByShop(session.shop),
    } satisfies ActionData;
  }

  if (intent === "delete_request") {
    const requestUid = String(formData.get("requestUid") ?? "").trim();
    const settings = await getApiSettingsByShop(session.shop);
    if (!requestUid) {
      return { ok: false, intent, message: "Missing request ID.", requests: await getLocalRequestsByShop(session.shop) } satisfies ActionData;
    }

    let responseText = "";
    let statusCode: number | null = null;
    let remoteOk = true;
    if (settings?.enabled) {
      const endpoint = joinApiUrl(settings.apiBaseUrl, encodeURIComponent(requestUid));
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "api-key": settings.apiKey,
          Authorization: `Bearer ${settings.apiKey}`,
        },
      });
      responseText = await response.text();
      statusCode = response.status;
      remoteOk = response.ok;
    }

    await deleteLocalRequest(session.shop, requestUid);
    await insertTranslationLog({
      shop: session.shop,
      level: remoteOk ? "success" : "error",
      contentType: "others",
      action: "delete_request",
      message: remoteOk ? "Translation request deleted." : "Translation request deleted locally, remote delete failed.",
      requestUid,
      statusCode,
      responseBody: responseText || null,
    });

    return {
      ok: true,
      intent,
      message: remoteOk ? "Request deleted." : "Deleted locally. Remote API delete failed.",
      requests: await getLocalRequestsByShop(session.shop),
    } satisfies ActionData;
  }

  if (intent === "fetch_content") {
    const requestUid = String(formData.get("requestUid") ?? "").trim();
    const selectedShopifyLocale = String(formData.get("shopifyLocale") ?? "").trim();
    const settings = await getApiSettingsByShop(session.shop);
    if (!requestUid || !settings?.enabled) {
      return { ok: false, intent, message: "Missing request ID or settings.", requests: await getLocalRequestsByShop(session.shop) } satisfies ActionData;
    }

    const requestRow = await getLocalRequestByUid(session.shop, requestUid);
    const localeMappings = await getLocaleMappingsByShop(session.shop);
    const mappedFromRequestLanguages = resolveShopifyLocaleForApiLanguages(
      localeMappings,
      (requestRow?.languages ?? "")
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean),
    );
    const translationLocale =
      selectedShopifyLocale ||
      requestRow?.storeLocale ||
      mappedFromRequestLanguages ||
      "";
    if (!translationLocale) {
      return {
        ok: false,
        intent,
        message: "No Shopify locale mapping found. Configure mappings on Settings page first.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    const endpoint = joinApiUrl(
      settings.apiBaseUrl,
      `${encodeURIComponent(requestUid)}/get-content-translated`,
    );
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "api-key": settings.apiKey,
        Authorization: `Bearer ${settings.apiKey}`,
      },
    });
    const responseText = await response.text();
    const parsedPayload = parseJsonSafe(responseText);

    if (!response.ok) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "product",
        action: "fetch_content",
        message: "Failed to fetch translated content.",
        requestUid,
        statusCode: response.status,
        responseBody: responseText,
      });
      return {
        ok: false,
        intent,
        message: "Fetch content failed.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    if (!requestRow?.itemId) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "product",
        action: "fetch_content",
        message: "Item ID missing for request; cannot apply translation.",
        requestUid,
      });
      return {
        ok: false,
        intent,
        message: "Item mapping missing for this request.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }
    const requestApiLanguages = (requestRow.languages ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);
    const blocks = parseTranslatedBlocks(parsedPayload, [
      translationLocale,
      ...requestApiLanguages,
    ]);
    if (!blocks.length) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: requestRow.contentType.toLowerCase() === "category" ? "categories" : "product",
        action: "fetch_content",
        message: "No translated content blocks found in API response.",
        requestUid,
        statusCode: response.status,
        responseBody: responseText,
      });
      return {
        ok: false,
        intent,
        message: "No translated content found in API response.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    let isPrimaryLocale = false;
    try {
      const localesResponse = await admin.graphql(
        `#graphql
        query PrimaryLocaleCheck {
          shopLocales {
            locale
            primary
          }
        }`,
      );
      const localesJson = (await localesResponse.json()) as {
        data?: { shopLocales?: Array<{ locale: string; primary: boolean }> };
      };
      const primaryLocale = (localesJson.data?.shopLocales ?? []).find((locale) => locale.primary)?.locale ?? "";
      isPrimaryLocale = primaryLocale.toLowerCase() === translationLocale.toLowerCase();
    } catch {
      // Ignore locale-check failures and continue.
    }

    if (requestRow.contentType.toLowerCase() === "category") {
      const translated = {
        title: "",
        description: "",
      };
      blocks.forEach((block) => {
        const key = block.key.trim().toLowerCase();
        if (key === "name" || key === "title") translated.title = block.value;
        if (key === "description") translated.description = block.value;
      });

      const categoryLookupResponse = await admin.graphql(
        `#graphql
        query CategoryByLegacyId($query: String!) {
          collections(first: 1, query: $query) {
            edges {
              node {
                id
                title
                metafields(first: 250) {
                  edges {
                    node {
                      id
                      namespace
                      key
                      type
                    }
                  }
                }
              }
            }
          }
        }`,
        {
          variables: { query: `id:${requestRow.itemId}` },
        },
      );
      const categoryLookupJson = (await categoryLookupResponse.json()) as {
        data?: {
          collections?: {
            edges?: Array<{
              node: {
                id: string;
                title: string;
                metafields?: {
                  edges?: Array<{
                    node?: {
                      id?: string | null;
                      namespace?: string | null;
                      key?: string | null;
                      type?: string | null;
                    } | null;
                  }>;
                } | null;
              };
            }>;
          };
        };
      };
      const collectionNode = categoryLookupJson.data?.collections?.edges?.[0]?.node;
      const collectionGid = collectionNode?.id;
      const collectionMetafields = (collectionNode?.metafields?.edges ?? [])
        .map((edge) => edge?.node)
        .filter(
          (
            node,
          ): node is { id: string; namespace: string; key: string; type: string } =>
            Boolean(node?.id && node.namespace && node.key),
        )
        .map((node) => ({
          id: String(node.id),
          namespace: String(node.namespace),
          key: String(node.key),
          type: String(node.type ?? ""),
        }));
      if (!collectionGid) {
        return {
          ok: false,
          intent,
          message: "Category not found in Shopify for this request.",
          requests: await getLocalRequestsByShop(session.shop),
        } satisfies ActionData;
      }

      const unmatchedCategoryMetafieldKeys: string[] = [];
      const metafieldTranslations: Array<{
        id: string;
        namespace: string;
        key: string;
        type: string;
        value: string;
      }> = [];
      for (const block of blocks) {
        const key = block.key.trim().toLowerCase();
        if (!key.startsWith("mf__")) continue;
        const matchedMetafield = await resolveOwnerMetafield(
          admin,
          collectionGid,
          key,
          collectionMetafields,
        );
        if (!matchedMetafield) {
          unmatchedCategoryMetafieldKeys.push(key);
          continue;
        }
        const value = normalizeMetafieldTranslationValue(
          matchedMetafield.type,
          block.value.trim(),
        );
        if (!value) continue;
        metafieldTranslations.push({
          id: matchedMetafield.id,
          namespace: matchedMetafield.namespace,
          key: matchedMetafield.key,
          type: matchedMetafield.type,
          value,
        });
      }

      let appliedCategoryCore = 0;
      let appliedCategoryMetafields = 0;
      const categoryMetafieldErrors: string[] = [];

      if (isPrimaryLocale) {
        const input: Record<string, unknown> = { id: collectionGid };
        if (translated.title.trim()) input.title = translated.title.trim();
        if (translated.description.trim()) input.descriptionHtml = translated.description.trim();
        if (Object.keys(input).length > 1) {
          const updateResponse = await admin.graphql(
            `#graphql
            mutation CollectionUpdateFromTranslation($input: CollectionInput!) {
              collectionUpdate(input: $input) {
                userErrors {
                  field
                  message
                }
              }
            }`,
            { variables: { input } },
          );
          const updateJson = (await updateResponse.json()) as {
            data?: {
              collectionUpdate?: {
                userErrors?: Array<{ field?: string[]; message: string }>;
              };
            };
          };
          const userErrors = updateJson.data?.collectionUpdate?.userErrors ?? [];
          if (userErrors.length) {
            return {
              ok: false,
              intent,
              message: userErrors[0]?.message || "Failed to apply translated category content.",
              requests: await getLocalRequestsByShop(session.shop),
            } satisfies ActionData;
          }
          appliedCategoryCore = 1;
        }

        if (metafieldTranslations.length) {
          const metafieldSetResponse = await admin.graphql(
            `#graphql
            mutation CategoryMetafieldsSetFromTranslation($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors {
                  field
                  message
                }
              }
            }`,
            {
              variables: {
                metafields: metafieldTranslations.map((entry) => ({
                  ownerId: collectionGid,
                  namespace: entry.namespace,
                  key: entry.key,
                  type: entry.type || "single_line_text_field",
                  value: entry.value,
                })),
              },
            },
          );
          const metafieldSetJson = (await metafieldSetResponse.json()) as {
            data?: {
              metafieldsSet?: {
                userErrors?: Array<{ field?: string[]; message: string }>;
              };
            };
          };
          const metafieldErrors = metafieldSetJson.data?.metafieldsSet?.userErrors ?? [];
          if (!metafieldErrors.length) {
            appliedCategoryMetafields = metafieldTranslations.length;
          } else {
            categoryMetafieldErrors.push(
              ...metafieldErrors.map((error) => error.message || "metafieldsSet failed"),
            );
          }
        }

        if (unmatchedCategoryMetafieldKeys.length || categoryMetafieldErrors.length) {
          await insertTranslationLog({
            shop: session.shop,
            level: "error",
            contentType: "categories",
            action: "fetch_content",
            message: "Some category metafield translations were not applied on default locale.",
            requestUid,
            itemId: requestRow.itemId,
            responseBody: JSON.stringify({
              unmatchedKeys: unmatchedCategoryMetafieldKeys,
              errors: categoryMetafieldErrors,
            }),
          });
        }

        if (!appliedCategoryCore && !appliedCategoryMetafields) {
          return {
            ok: false,
            intent,
            message: "No translated category content available to apply on default language.",
            requests: await getLocalRequestsByShop(session.shop),
          } satisfies ActionData;
        }
      } else {
        const translatableResponse = await admin.graphql(
          `#graphql
          query CollectionTranslatableContent($resourceId: ID!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                digest
              }
            }
          }`,
          { variables: { resourceId: collectionGid } },
        );
        const translatableJson = (await translatableResponse.json()) as {
          data?: {
            translatableResource?: {
              translatableContent?: Array<{ key: string; digest: string }>;
            } | null;
          };
        };
        const digestByKey = new Map(
          (translatableJson.data?.translatableResource?.translatableContent ?? []).map((entry) => [
            entry.key,
            entry.digest,
          ]),
        );
        const translationInputs: Array<{
          key: string;
          value: string;
          locale: string;
          translatableContentDigest: string;
        }> = [];
        const pushTranslation = (key: string, value: string) => {
          const clean = value.trim();
          const digest = digestByKey.get(key);
          if (!clean || !digest) return;
          translationInputs.push({
            key,
            value: clean,
            locale: translationLocale,
            translatableContentDigest: digest,
          });
        };
        pushTranslation("title", translated.title);
        pushTranslation("body_html", translated.description);

        if (translationInputs.length) {
          const updateResponse = await admin.graphql(
            `#graphql
            mutation RegisterCategoryTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
              translationsRegister(resourceId: $resourceId, translations: $translations) {
                userErrors {
                  field
                  message
                }
              }
            }`,
            { variables: { resourceId: collectionGid, translations: translationInputs } },
          );
          const updateJson = (await updateResponse.json()) as {
            data?: {
              translationsRegister?: {
                userErrors?: Array<{ field?: string[]; message: string }>;
              };
            };
          };
          const userErrors = updateJson.data?.translationsRegister?.userErrors ?? [];
          if (userErrors.length) {
            return {
              ok: false,
              intent,
              message: userErrors[0]?.message || "Failed to apply translated category content.",
              requests: await getLocalRequestsByShop(session.shop),
            } satisfies ActionData;
          }
          appliedCategoryCore = translationInputs.length;
        }

        for (const metafieldTranslation of metafieldTranslations) {
          try {
            const metafieldTranslatableResponse = await admin.graphql(
              `#graphql
              query CategoryMetafieldTranslatableContent($resourceId: ID!) {
                translatableResource(resourceId: $resourceId) {
                  translatableContent {
                    key
                    digest
                  }
                }
              }`,
              { variables: { resourceId: metafieldTranslation.id } },
            );
            const metafieldTranslatableJson = (await metafieldTranslatableResponse.json()) as {
              data?: {
                translatableResource?: {
                  translatableContent?: Array<{ key: string; digest: string }>;
                } | null;
              };
            };
            const valueDigest =
              (metafieldTranslatableJson.data?.translatableResource?.translatableContent ?? []).find(
                (entry) => entry.key === "value",
              )?.digest ?? "";
            if (!valueDigest) {
              categoryMetafieldErrors.push(
                `${metafieldTranslation.namespace}.${metafieldTranslation.key}: missing translatable digest`,
              );
              continue;
            }

            const metafieldUpdateResponse = await admin.graphql(
              `#graphql
              mutation RegisterCategoryMetafieldTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                  userErrors {
                    field
                    message
                  }
                }
              }`,
              {
                variables: {
                  resourceId: metafieldTranslation.id,
                  translations: [
                    {
                      key: "value",
                      value: metafieldTranslation.value,
                      locale: translationLocale,
                      translatableContentDigest: valueDigest,
                    },
                  ],
                },
              },
            );
            const metafieldUpdateJson = (await metafieldUpdateResponse.json()) as {
              data?: {
                translationsRegister?: {
                  userErrors?: Array<{ field?: string[]; message: string }>;
                };
              };
            };
            const metafieldUserErrors =
              metafieldUpdateJson.data?.translationsRegister?.userErrors ?? [];
            if (!metafieldUserErrors.length) {
              appliedCategoryMetafields += 1;
            } else {
              categoryMetafieldErrors.push(
                `${metafieldTranslation.namespace}.${metafieldTranslation.key}: ${metafieldUserErrors[0]?.message || "register failed"}`,
              );
            }
          } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            categoryMetafieldErrors.push(
              `${metafieldTranslation.namespace}.${metafieldTranslation.key}: ${details}`,
            );
          }
        }

        if (unmatchedCategoryMetafieldKeys.length || categoryMetafieldErrors.length) {
          await insertTranslationLog({
            shop: session.shop,
            level: "error",
            contentType: "categories",
            action: "fetch_content",
            message: "Some category metafield translations were not applied.",
            requestUid,
            itemId: requestRow.itemId,
            responseBody: JSON.stringify({
              unmatchedKeys: unmatchedCategoryMetafieldKeys,
              errors: categoryMetafieldErrors,
              availableMetafields: collectionMetafields.map(
                (metafield) => `${metafield.namespace}.${metafield.key}`,
              ),
            }),
          });
        }

        if (!appliedCategoryCore && !appliedCategoryMetafields) {
          return {
            ok: false,
            intent,
            message:
              categoryMetafieldErrors[0] ||
              (unmatchedCategoryMetafieldKeys.length
                ? `Category metafields not found on Shopify: ${unmatchedCategoryMetafieldKeys.join(", ")}`
                : "No valid category fields available to register for selected locale."),
            requests: await getLocalRequestsByShop(session.shop),
          } satisfies ActionData;
        }
      }

      const categoryMfExpected =
        blocks.filter((block) => block.key.trim().toLowerCase().startsWith("mf__")).length;
      const categoryPartialMetafields =
        categoryMfExpected > 0 && appliedCategoryMetafields < categoryMfExpected;
      const categoryAppliedFields: string[] = [];
      if (translated.title.trim()) categoryAppliedFields.push("title");
      if (translated.description.trim()) categoryAppliedFields.push("description");
      for (const metafield of metafieldTranslations) {
        categoryAppliedFields.push(metafieldSelectValue(metafield.namespace, metafield.key));
      }
      if (categoryAppliedFields.length) {
        await recordAppliedFieldsSafe({
          shop: session.shop,
          contentType: "category",
          itemId: requestRow.itemId,
          storeLocale: translationLocale,
          fields: categoryAppliedFields,
        });
      }
      if (!categoryPartialMetafields) {
        await markTranslated(session.shop, requestUid);
      }
      await insertTranslationLog({
        shop: session.shop,
        level: categoryPartialMetafields ? "error" : "success",
        contentType: "categories",
        action: "fetch_content",
        message:
          appliedCategoryMetafields > 0
            ? `Translated category content applied for locale ${translationLocale}, including ${appliedCategoryMetafields}/${categoryMfExpected} metafield(s).`
            : `Translated category content applied for locale ${translationLocale}.`,
        requestUid,
        itemId: requestRow.itemId,
        statusCode: response.status,
        responseBody: responseText,
      });
      return withTranslationStates(session.shop, {
        ok: !categoryPartialMetafields,
        intent,
        message:
          categoryPartialMetafields
            ? `Category core fields applied for ${translationLocale}, but only ${appliedCategoryMetafields}/${categoryMfExpected} metafield(s) synced. Check Logs and re-apply.`
            : appliedCategoryMetafields > 0
            ? `Category translation applied for locale ${translationLocale} with ${appliedCategoryMetafields} metafield(s).`
            : `Category translation applied for locale ${translationLocale}.`,
        requests: await getLocalRequestsByShop(session.shop),
      });
    }

    const productLookupResponse = await admin.graphql(
      `#graphql
      query ProductByLegacyId($query: String!) {
        products(first: 1, query: $query) {
          edges {
            node {
              id
              title
              options {
                id
                name
                optionValues {
                  id
                  name
                }
              }
              metafields(first: 250) {
                edges {
                  node {
                    id
                    namespace
                    key
                    type
                  }
                }
              }
            }
          }
        }
      }`,
      {
        variables: { query: `id:${requestRow.itemId}` },
      },
    );
    const productLookupJson = (await productLookupResponse.json()) as {
      data?: {
        products?: {
          edges?: Array<{
            node: {
              id: string;
              title: string;
              options?: ProductOptionRow[];
              metafields?: {
                edges?: Array<{
                  node?: {
                    id?: string | null;
                    namespace?: string | null;
                    key?: string | null;
                    type?: string | null;
                  } | null;
                }>;
              } | null;
            };
          }>;
        };
      };
    };
    const productGid = productLookupJson.data?.products?.edges?.[0]?.node?.id;
    const productOptions = productLookupJson.data?.products?.edges?.[0]?.node?.options ?? [];
    const productMetafields = (productLookupJson.data?.products?.edges?.[0]?.node?.metafields?.edges ?? [])
      .map((edge) => edge?.node)
      .filter(
        (
          node,
        ): node is { id: string; namespace: string; key: string; type: string } =>
          Boolean(node?.id && node.namespace && node.key),
      )
      .map((node) => ({
        id: String(node.id),
        namespace: String(node.namespace),
        key: String(node.key),
        type: String(node.type ?? ""),
      }));
    if (!productGid) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "product",
        action: "fetch_content",
        message: "Could not resolve Shopify product for translated request.",
        requestUid,
        itemId: requestRow.itemId,
      });
      return {
        ok: false,
        intent,
        message: "Product not found in Shopify for this request.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    const translated = {
      title: "",
      description: "",
      metaTitle: "",
      metaDescription: "",
    };
    blocks.forEach((block) => {
      const key = block.key.trim().toLowerCase();
      if (key === "name" || key === "title") translated.title = block.value;
      if (key === "description") translated.description = block.value;
      if (key === "meta_title" || key === "seo_title") translated.metaTitle = block.value;
      if (key === "meta_description" || key === "seo_description") translated.metaDescription = block.value;
    });
    const optionNameTranslations = blocks
      .map((block) => {
        const match = /^prod_attr_name_custom_(.+)$/.exec(block.key.trim().toLowerCase());
        if (!match) return null;
        return {
          optionKey: match[1],
          value: block.value.trim(),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          optionKey: string;
          value: string;
        } => Boolean(entry?.optionKey && entry.value),
      );
    const optionValueTranslations = blocks
      .map((block) => {
        const match = /^prod_attr_custom_(.+)_(\d+)$/.exec(block.key.trim().toLowerCase());
        if (!match) return null;
        return {
          optionKey: match[1],
          index: Number(match[2]),
          value: block.value.trim(),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          optionKey: string;
          index: number;
          value: string;
        } => Boolean(entry?.optionKey && entry.index > 0 && entry.value),
      );
    const unmatchedProductMetafieldKeys: string[] = [];
    const metafieldTranslations: Array<{
      id: string;
      namespace: string;
      key: string;
      type: string;
      value: string;
    }> = [];
    for (const block of blocks) {
      const key = block.key.trim().toLowerCase();
      if (!key.startsWith("mf__")) continue;
      const matchedMetafield = await resolveOwnerMetafield(
        admin,
        productGid,
        key,
        productMetafields,
      );
      if (!matchedMetafield) {
        unmatchedProductMetafieldKeys.push(key);
        continue;
      }
      const value = normalizeMetafieldTranslationValue(
        matchedMetafield.type,
        block.value.trim(),
      );
      if (!value) continue;
      metafieldTranslations.push({
        id: matchedMetafield.id,
        namespace: matchedMetafield.namespace,
        key: matchedMetafield.key,
        type: matchedMetafield.type,
        value,
      });
    }

    let appliedProductTranslations = 0;
    const productMetafieldErrors: string[] = [];
    const productMfExpected = blocks.filter((block) =>
      block.key.trim().toLowerCase().startsWith("mf__"),
    ).length;

    if (isPrimaryLocale) {
      const productInput: Record<string, unknown> = { id: productGid };
      if (translated.title.trim()) productInput.title = translated.title.trim();
      if (translated.description.trim()) productInput.descriptionHtml = translated.description.trim();
      if (translated.metaTitle.trim() || translated.metaDescription.trim()) {
        productInput.seo = {
          ...(translated.metaTitle.trim() ? { title: translated.metaTitle.trim() } : {}),
          ...(translated.metaDescription.trim() ? { description: translated.metaDescription.trim() } : {}),
        };
      }
      let appliedDefaultProductChanges = 0;
      let appliedDefaultOptionNameChanges = 0;
      let appliedDefaultMetafieldChanges = 0;

      if (Object.keys(productInput).length > 1) {
        const updateResponse = await admin.graphql(
          `#graphql
          mutation ProductUpdateFromTranslation($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
              userErrors {
                field
                message
              }
            }
          }`,
          { variables: { product: productInput } },
        );
        const updateJson = (await updateResponse.json()) as {
          data?: {
            productUpdate?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const userErrors = updateJson.data?.productUpdate?.userErrors ?? [];
        if (userErrors.length) {
          await insertTranslationLog({
            shop: session.shop,
            level: "error",
            contentType: "product",
            action: "fetch_content",
            message: "Failed to apply translated content to default product language.",
            requestUid,
            itemId: requestRow.itemId,
            responseBody: JSON.stringify(updateJson),
          });
          return {
            ok: false,
            intent,
            message: userErrors[0]?.message || "Failed to apply translated content to default language.",
            requests: await getLocalRequestsByShop(session.shop),
          } satisfies ActionData;
        }
        appliedDefaultProductChanges += 1;
      }

      for (const optionTranslation of optionNameTranslations) {
        const matchedOption = productOptions.find((option) => toFieldKey(option.name) === optionTranslation.optionKey);
        if (!matchedOption?.id || !optionTranslation.value) continue;
        const updateResponse = await admin.graphql(
          `#graphql
          mutation ProductOptionNameUpdate($productId: ID!, $option: OptionUpdateInput!) {
            productOptionUpdate(productId: $productId, option: $option) {
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              productId: productGid,
              option: {
                id: matchedOption.id,
                name: optionTranslation.value,
              },
            },
          },
        );
        const updateJson = (await updateResponse.json()) as {
          data?: {
            productOptionUpdate?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const userErrors = updateJson.data?.productOptionUpdate?.userErrors ?? [];
        if (!userErrors.length) {
          appliedDefaultOptionNameChanges += 1;
        }
      }

      if (metafieldTranslations.length) {
        const metafieldSetResponse = await admin.graphql(
          `#graphql
          mutation ProductMetafieldsSetFromTranslation($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              metafields: metafieldTranslations.map((entry) => ({
                ownerId: productGid,
                namespace: entry.namespace,
                key: entry.key,
                type: entry.type || "single_line_text_field",
                value: entry.value,
              })),
            },
          },
        );
        const metafieldSetJson = (await metafieldSetResponse.json()) as {
          data?: {
            metafieldsSet?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const metafieldErrors = metafieldSetJson.data?.metafieldsSet?.userErrors ?? [];
        if (!metafieldErrors.length) {
          appliedDefaultMetafieldChanges = metafieldTranslations.length;
        } else {
          productMetafieldErrors.push(
            ...metafieldErrors.map((error) => error.message || "metafieldsSet failed"),
          );
        }
      }

      if (unmatchedProductMetafieldKeys.length || productMetafieldErrors.length) {
        await insertTranslationLog({
          shop: session.shop,
          level: "error",
          contentType: "product",
          action: "fetch_content",
          message: "Some product metafield translations were not applied on default locale.",
          requestUid,
          itemId: requestRow.itemId,
          responseBody: JSON.stringify({
            unmatchedKeys: unmatchedProductMetafieldKeys,
            errors: productMetafieldErrors,
            availableMetafields: productMetafields.map(
              (metafield) => `${metafield.namespace}.${metafield.key}`,
            ),
          }),
        });
      }

      if (!appliedDefaultProductChanges && !appliedDefaultOptionNameChanges && !appliedDefaultMetafieldChanges) {
        return {
          ok: false,
          intent,
          message: "No translated content available to apply on default language.",
          requests: await getLocalRequestsByShop(session.shop),
        } satisfies ActionData;
      }

      const defaultPartialMetafields =
        productMfExpected > 0 && appliedDefaultMetafieldChanges < productMfExpected;
      const productAppliedFields: string[] = [];
      if (translated.title.trim()) productAppliedFields.push("title");
      if (translated.description.trim()) productAppliedFields.push("description");
      if (translated.metaTitle.trim()) productAppliedFields.push("meta_title");
      if (translated.metaDescription.trim()) productAppliedFields.push("meta_description");
      for (const metafield of metafieldTranslations) {
        productAppliedFields.push(metafieldSelectValue(metafield.namespace, metafield.key));
      }
      if (productAppliedFields.length) {
        await recordAppliedFieldsSafe({
          shop: session.shop,
          contentType: "product",
          itemId: requestRow.itemId,
          storeLocale: translationLocale,
          fields: productAppliedFields,
        });
      }
      for (const optionTranslation of optionNameTranslations) {
        if (!optionTranslation.optionKey || !optionTranslation.value) continue;
        await recordAppliedFieldsSafe({
          shop: session.shop,
          contentType: "attribute",
          itemId: optionTranslation.optionKey,
          storeLocale: translationLocale,
          fields: ["name"],
        });
      }
      if (!defaultPartialMetafields) {
        await markTranslated(session.shop, requestUid);
      }
      await insertTranslationLog({
        shop: session.shop,
        level: defaultPartialMetafields ? "error" : "success",
        contentType: "product",
        action: "fetch_content",
        message:
          appliedDefaultMetafieldChanges > 0
            ? `Translated content applied to default locale ${translationLocale}, including ${appliedDefaultMetafieldChanges}/${productMfExpected} metafield(s).`
            : appliedDefaultOptionNameChanges > 0
            ? `Translated content applied to default locale ${translationLocale}, including ${appliedDefaultOptionNameChanges} attribute name(s).`
            : `Translated content applied to default locale ${translationLocale} via product update.`,
        requestUid,
        itemId: requestRow.itemId,
        statusCode: response.status,
        responseBody: responseText,
      });
      return withTranslationStates(session.shop, {
        ok: !defaultPartialMetafields,
        intent,
        message:
          defaultPartialMetafields
            ? `Default locale updated for ${translationLocale}, but only ${appliedDefaultMetafieldChanges}/${productMfExpected} metafield(s) synced. Check Logs and re-apply.`
            : appliedDefaultMetafieldChanges > 0
            ? `Translated content applied on default locale ${translationLocale} with ${appliedDefaultMetafieldChanges} metafield(s).`
            : appliedDefaultOptionNameChanges > 0
            ? `Translated content applied on default locale ${translationLocale} with ${appliedDefaultOptionNameChanges} attribute name(s).`
            : `Translated content applied on default locale ${translationLocale}.`,
        requests: await getLocalRequestsByShop(session.shop),
      });
    }

    try {
      const translatableResponse = await admin.graphql(
        `#graphql
        query ProductTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            translatableContent {
              key
              digest
            }
          }
        }`,
        { variables: { resourceId: productGid } },
      );
      const translatableJson = (await translatableResponse.json()) as {
        data?: {
          translatableResource?: {
            translatableContent?: Array<{ key: string; digest: string }>;
          } | null;
        };
      };
      const digestByKey = new Map(
        (translatableJson.data?.translatableResource?.translatableContent ?? []).map((entry) => [
          entry.key,
          entry.digest,
        ]),
      );

      const translationInputs: Array<{
        key: string;
        value: string;
        locale: string;
        translatableContentDigest: string;
      }> = [];

      const pushTranslation = (key: string, value: string) => {
        const clean = value.trim();
        const digest = digestByKey.get(key);
        if (!clean || !digest) return;
        translationInputs.push({
          key,
          value: clean,
          locale: translationLocale,
          translatableContentDigest: digest,
        });
      };

      pushTranslation("title", translated.title);
      pushTranslation("body_html", translated.description);
      pushTranslation("meta_title", translated.metaTitle);
      pushTranslation("meta_description", translated.metaDescription);

      if (translationInputs.length) {
        const updateResponse = await admin.graphql(
          `#graphql
          mutation RegisterProductTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
            translationsRegister(resourceId: $resourceId, translations: $translations) {
              userErrors {
                field
                message
              }
            }
          }`,
          { variables: { resourceId: productGid, translations: translationInputs } },
        );
        const updateJson = (await updateResponse.json()) as {
          data?: {
            translationsRegister?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const userErrors = updateJson.data?.translationsRegister?.userErrors ?? [];
        if (userErrors.length) {
          await insertTranslationLog({
            shop: session.shop,
            level: "error",
            contentType: "product",
            action: "fetch_content",
            message: "Failed to apply translated content to Shopify product.",
            requestUid,
            itemId: requestRow.itemId,
            responseBody: JSON.stringify(updateJson),
          });
          return {
            ok: false,
            intent,
            message: userErrors[0]?.message || "Failed to apply translated content.",
            requests: await getLocalRequestsByShop(session.shop),
          } satisfies ActionData;
        }
        appliedProductTranslations = translationInputs.length;
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "product",
        action: "fetch_content",
        message: "Missing translation scopes for Shopify translation APIs.",
        requestUid,
        itemId: requestRow.itemId,
        responseBody: details,
      });
      return {
        ok: false,
        intent,
        message: "Missing Shopify scopes: add read_translations + write_translations and reinstall app.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    let appliedOptionNameCount = 0;
    let appliedOptionValueCount = 0;
    for (const optionTranslation of optionNameTranslations) {
      const matchedOption = productOptions.find((option) => toFieldKey(option.name) === optionTranslation.optionKey);
      if (!matchedOption?.id || !optionTranslation.value) continue;

      try {
        const translatableResponse = await admin.graphql(
          `#graphql
          query OptionNameTranslatableContent($resourceId: ID!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                digest
              }
            }
          }`,
          { variables: { resourceId: matchedOption.id } },
        );
        const translatableJson = (await translatableResponse.json()) as {
          data?: {
            translatableResource?: {
              translatableContent?: Array<{ key: string; digest: string }>;
            } | null;
          };
        };
        const nameDigest =
          (translatableJson.data?.translatableResource?.translatableContent ?? []).find(
            (entry) => entry.key === "name",
          )?.digest ?? "";
        if (!nameDigest) continue;

        const updateResponse = await admin.graphql(
          `#graphql
          mutation RegisterOptionNameTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
            translationsRegister(resourceId: $resourceId, translations: $translations) {
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              resourceId: matchedOption.id,
              translations: [
                {
                  key: "name",
                  value: optionTranslation.value,
                  locale: translationLocale,
                  translatableContentDigest: nameDigest,
                },
              ],
            },
          },
        );
        const updateJson = (await updateResponse.json()) as {
          data?: {
            translationsRegister?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const userErrors = updateJson.data?.translationsRegister?.userErrors ?? [];
        if (!userErrors.length) {
          appliedOptionNameCount += 1;
        }
      } catch {
        // Ignore individual option name translation failures and continue.
      }
    }

    for (const optionTranslation of optionValueTranslations) {
      const matchedOption = productOptions.find((option) => toFieldKey(option.name) === optionTranslation.optionKey);
      const matchedValue = matchedOption?.optionValues?.[optionTranslation.index - 1];
      if (!matchedValue?.id || !optionTranslation.value) continue;

      try {
        const translatableResponse = await admin.graphql(
          `#graphql
          query OptionValueTranslatableContent($resourceId: ID!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                digest
              }
            }
          }`,
          { variables: { resourceId: matchedValue.id } },
        );
        const translatableJson = (await translatableResponse.json()) as {
          data?: {
            translatableResource?: {
              translatableContent?: Array<{ key: string; digest: string }>;
            } | null;
          };
        };
        const nameDigest =
          (translatableJson.data?.translatableResource?.translatableContent ?? []).find(
            (entry) => entry.key === "name",
          )?.digest ?? "";
        if (!nameDigest) continue;

        const updateResponse = await admin.graphql(
          `#graphql
          mutation RegisterOptionValueTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
            translationsRegister(resourceId: $resourceId, translations: $translations) {
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              resourceId: matchedValue.id,
              translations: [
                {
                  key: "name",
                  value: optionTranslation.value,
                  locale: translationLocale,
                  translatableContentDigest: nameDigest,
                },
              ],
            },
          },
        );
        const updateJson = (await updateResponse.json()) as {
          data?: {
            translationsRegister?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const userErrors = updateJson.data?.translationsRegister?.userErrors ?? [];
        if (!userErrors.length) {
          appliedOptionValueCount += 1;
        }
      } catch {
        // Ignore individual option value translation failures and continue.
      }
    }

    let appliedMetafieldCount = 0;
    for (const metafieldTranslation of metafieldTranslations) {
      try {
        const translatableResponse = await admin.graphql(
          `#graphql
          query MetafieldTranslatableContent($resourceId: ID!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                digest
              }
            }
          }`,
          { variables: { resourceId: metafieldTranslation.id } },
        );
        const translatableJson = (await translatableResponse.json()) as {
          data?: {
            translatableResource?: {
              translatableContent?: Array<{ key: string; digest: string }>;
            } | null;
          };
        };
        const valueDigest =
          (translatableJson.data?.translatableResource?.translatableContent ?? []).find(
            (entry) => entry.key === "value",
          )?.digest ?? "";
        if (!valueDigest) {
          productMetafieldErrors.push(
            `${metafieldTranslation.namespace}.${metafieldTranslation.key}: missing translatable digest`,
          );
          continue;
        }

        const updateResponse = await admin.graphql(
          `#graphql
          mutation RegisterMetafieldTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
            translationsRegister(resourceId: $resourceId, translations: $translations) {
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              resourceId: metafieldTranslation.id,
              translations: [
                {
                  key: "value",
                  value: metafieldTranslation.value,
                  locale: translationLocale,
                  translatableContentDigest: valueDigest,
                },
              ],
            },
          },
        );
        const updateJson = (await updateResponse.json()) as {
          data?: {
            translationsRegister?: {
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const userErrors = updateJson.data?.translationsRegister?.userErrors ?? [];
        if (!userErrors.length) {
          appliedMetafieldCount += 1;
        } else {
          productMetafieldErrors.push(
            `${metafieldTranslation.namespace}.${metafieldTranslation.key}: ${userErrors[0]?.message || "register failed"}`,
          );
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        productMetafieldErrors.push(
          `${metafieldTranslation.namespace}.${metafieldTranslation.key}: ${details}`,
        );
      }
    }

    if (unmatchedProductMetafieldKeys.length || productMetafieldErrors.length) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "product",
        action: "fetch_content",
        message: "Some product metafield translations were not applied.",
        requestUid,
        itemId: requestRow.itemId,
        responseBody: JSON.stringify({
          unmatchedKeys: unmatchedProductMetafieldKeys,
          errors: productMetafieldErrors,
          availableMetafields: productMetafields.map(
            (metafield) => `${metafield.namespace}.${metafield.key}`,
          ),
        }),
      });
    }

    if (!appliedProductTranslations && !appliedOptionNameCount && !appliedOptionValueCount && !appliedMetafieldCount) {
      return {
        ok: false,
        intent,
        message:
          productMetafieldErrors[0] ||
          (unmatchedProductMetafieldKeys.length
            ? `Product metafields not found on Shopify: ${unmatchedProductMetafieldKeys.join(", ")}`
            : "No valid translated fields or attribute names were available to apply for selected locale."),
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    const productPartialMetafields =
      productMfExpected > 0 && appliedMetafieldCount < productMfExpected;
    const productAppliedFields: string[] = [];
    if (translated.title.trim()) productAppliedFields.push("title");
    if (translated.description.trim()) productAppliedFields.push("description");
    if (translated.metaTitle.trim()) productAppliedFields.push("meta_title");
    if (translated.metaDescription.trim()) productAppliedFields.push("meta_description");
    for (const metafield of metafieldTranslations) {
      productAppliedFields.push(metafieldSelectValue(metafield.namespace, metafield.key));
    }
    if (productAppliedFields.length) {
      await recordAppliedFieldsSafe({
        shop: session.shop,
        contentType: "product",
        itemId: requestRow.itemId,
        storeLocale: translationLocale,
        fields: productAppliedFields,
      });
    }
    for (const optionTranslation of optionNameTranslations) {
      if (!optionTranslation.optionKey || !optionTranslation.value) continue;
      await recordAppliedFieldsSafe({
        shop: session.shop,
        contentType: "attribute",
        itemId: optionTranslation.optionKey,
        storeLocale: translationLocale,
        fields: ["name"],
      });
    }
    for (const optionTranslation of optionValueTranslations) {
      if (!optionTranslation.optionKey || !optionTranslation.value) continue;
      await recordAppliedFieldsSafe({
        shop: session.shop,
        contentType: "attribute_value",
        itemId: `${optionTranslation.optionKey}__${optionTranslation.index}`,
        storeLocale: translationLocale,
        fields: ["name"],
      });
    }
    if (!productPartialMetafields) {
      await markTranslated(session.shop, requestUid);
    }
    await insertTranslationLog({
      shop: session.shop,
      level: productPartialMetafields ? "error" : "success",
      contentType: "product",
      action: "fetch_content",
      message:
        appliedMetafieldCount > 0
          ? `Translated content fetched and applied to locale ${translationLocale}, including ${appliedMetafieldCount}/${productMfExpected} metafield(s).`
          : appliedOptionNameCount > 0
          ? `Translated content fetched and applied to locale ${translationLocale}, including ${appliedOptionNameCount} attribute name(s).`
          : appliedOptionValueCount > 0
            ? `Translated content fetched and applied to locale ${translationLocale}, including ${appliedOptionValueCount} attribute value(s).`
          : `Translated content fetched and applied to locale ${translationLocale}.`,
      requestUid,
      itemId: requestRow.itemId,
      statusCode: response.status,
      responseBody: responseText,
    });
    return withTranslationStates(session.shop, {
      ok: !productPartialMetafields,
      intent,
      message:
        productPartialMetafields
          ? `Content applied for ${translationLocale}, but only ${appliedMetafieldCount}/${productMfExpected} metafield(s) synced. Check Logs and re-apply.`
          : appliedMetafieldCount > 0
          ? `Translated content applied for locale ${translationLocale} with ${appliedMetafieldCount} metafield(s).`
          : appliedOptionNameCount > 0
          ? `Translated content applied for locale ${translationLocale} with ${appliedOptionNameCount} attribute name(s).`
          : appliedOptionValueCount > 0
            ? `Translated content applied for locale ${translationLocale} with ${appliedOptionValueCount} attribute value(s).`
          : `Translated content applied for locale ${translationLocale}.`,
      requests: await getLocalRequestsByShop(session.shop),
    });
  }

  let selectedItems = formData.getAll("selectedItems").map(String);
  const selectedContentType = String(formData.get("selectedContentType") ?? "product").trim().toLowerCase();
  const targetLanguages = formData.getAll("targetLanguages").map(String);
  const selectedFields = formData.getAll("selectedFields").map(String);
  const isAttributeMode = selectedContentType === "attribute" || selectedContentType === "attribute_value";
  const localeMappings = await getLocaleMappingsByShop(session.shop);
  const unmappedLanguages = targetLanguages.filter(
    (code) => !resolveShopifyLocaleForApiLanguage(localeMappings, code),
  );
  const selectedStoreLocale = resolveShopifyLocaleForApiLanguages(localeMappings, targetLanguages) || "";

  if (!selectedItems.length && !isAttributeMode) {
    return { ok: false, intent, message: "Select at least one item before starting translation." } satisfies ActionData;
  }
  if (!targetLanguages.length) {
    return { ok: false, intent, message: "Select at least one API target language." } satisfies ActionData;
  }
  if (!selectedFields.length) {
    return { ok: false, intent, message: "Select at least one content field." } satisfies ActionData;
  }
  if (unmappedLanguages.length) {
    return {
      ok: false,
      intent,
      message: `Map these API languages on Settings first: ${unmappedLanguages.join(", ")}`,
    } satisfies ActionData;
  }
  if (!selectedStoreLocale) {
    return {
      ok: false,
      intent,
      message: "No Shopify locale mapping found. Configure mappings on Settings page first.",
    } satisfies ActionData;
  }
  if (isAttributeMode && !selectedItems.length) {
    selectedItems = await fetchAllProductIds(admin);
    if (!selectedItems.length) {
      return {
        ok: false,
        intent,
        message: "No products available for attribute translation request generation.",
      } satisfies ActionData;
    }
  }

  const settings = await getApiSettingsByShop(session.shop);
  if (!settings?.enabled) {
    return { ok: false, intent, message: "Translator is disabled or settings are missing. Enable and save settings first." } satisfies ActionData;
  }

  const productsResponse = await admin.graphql(
    `#graphql
    query TranslationProductsById($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          handle
          description
          seo { title description }
          variants(first: 1) { edges { node { sku } } }
          options { name values }
          metafields(first: 100) {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
    }`,
    { variables: { ids: selectedItems } },
  );

  const productsJson = (await productsResponse.json()) as {
    data?: {
      nodes?: Array<{
        id: string;
        title: string;
        handle: string;
        description: string;
        seo?: { title?: string | null; description?: string | null } | null;
        variants?: { edges?: Array<{ node?: { sku?: string | null } | null }> } | null;
        options?: Array<{ name: string; values: string[] }>;
        metafields?: {
          edges?: Array<{
            node?: {
              id?: string | null;
              namespace?: string | null;
              key?: string | null;
              value?: string | null;
              type?: string | null;
            } | null;
          }>;
        } | null;
      } | null>;
    };
  };

  const selectedProducts = (productsJson.data?.nodes ?? []).filter(
    (node): node is NonNullable<typeof node> => Boolean(node),
  );
  const categoriesResponse = await admin.graphql(
    `#graphql
    query TranslationCategoriesById($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Collection {
          id
          title
          handle
          descriptionHtml
          seo { title description }
          metafields(first: 100) {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
    }`,
    { variables: { ids: selectedItems } },
  );
  const categoriesJson = (await categoriesResponse.json()) as {
    data?: {
      nodes?: Array<{
        id: string;
        title: string;
        handle: string;
        descriptionHtml?: string | null;
        seo?: { title?: string | null; description?: string | null } | null;
        metafields?: {
          edges?: Array<{
            node?: {
              id?: string | null;
              namespace?: string | null;
              key?: string | null;
              value?: string | null;
              type?: string | null;
            } | null;
          }>;
        } | null;
      } | null>;
    };
  };
  const selectedCategories = (categoriesJson.data?.nodes ?? []).filter(
    (node): node is NonNullable<typeof node> => Boolean(node),
  );

  if (
    (selectedContentType === "product" ||
      selectedContentType === "attribute" ||
      selectedContentType === "attribute_value") &&
    !selectedProducts.length
  ) {
    return { ok: false, intent, message: "Selected products could not be loaded from Shopify." } satisfies ActionData;
  }
  if (selectedContentType === "category" && !selectedCategories.length) {
    return { ok: false, intent, message: "Selected categories could not be loaded from Shopify." } satisfies ActionData;
  }

  const endpoint = joinApiUrl(settings.apiBaseUrl, "post-resource");
  let successCount = 0;
  let failedCount = 0;
  const rowsForTranslation =
    selectedContentType === "category"
      ? selectedCategories.map((category) => ({
          id: category.id,
          title: category.title,
          description: String(category.descriptionHtml ?? ""),
          seoTitle: String(category.seo?.title ?? ""),
          seoDescription: String(category.seo?.description ?? ""),
          options: [] as Array<{ name: string; values: string[] }>,
          sku: "",
          metafields: (category.metafields?.edges ?? [])
            .map((edge) => edge?.node)
            .filter(
              (
                node,
              ): node is {
                id: string;
                namespace: string;
                key: string;
                value: string;
                type: string;
              } =>
                Boolean(
                  node?.id &&
                    node.namespace &&
                    node.key &&
                    typeof node.value === "string" &&
                    TEXT_METAFIELD_TYPES.has(String(node.type ?? "")),
                ),
            )
            .map((node) => ({
              id: String(node.id),
              namespace: String(node.namespace),
              key: String(node.key),
              value: String(node.value ?? ""),
              type: String(node.type ?? ""),
            })),
          contentType: "category" as const,
        }))
      : selectedProducts.map((product) => ({
          id: product.id,
          title: product.title,
          description: product.description,
          seoTitle: String(product.seo?.title ?? ""),
          seoDescription: String(product.seo?.description ?? ""),
          options: product.options ?? [],
          sku: product.variants?.edges?.[0]?.node?.sku ?? "",
          metafields: (product.metafields?.edges ?? [])
            .map((edge) => edge?.node)
            .filter(
              (
                node,
              ): node is {
                id: string;
                namespace: string;
                key: string;
                value: string;
                type: string;
              } =>
                Boolean(
                  node?.id &&
                    node.namespace &&
                    node.key &&
                    typeof node.value === "string" &&
                    TEXT_METAFIELD_TYPES.has(String(node.type ?? "")),
                ),
            )
            .map((node) => ({
              id: String(node.id),
              namespace: String(node.namespace),
              key: String(node.key),
              value: String(node.value ?? ""),
              type: String(node.type ?? ""),
            })),
          contentType: "product" as const,
        }));
  const rowsToProcess =
    selectedContentType === "attribute" || selectedContentType === "attribute_value"
      ? (() => {
          const selectedOptionFieldKeys = selectedFields
            .map((field) => field.trim().toLowerCase())
            .filter((field) =>
              selectedContentType === "attribute_value"
                ? field.startsWith("prod_attr_value_")
                : field.startsWith("prod_attr_name_"),
            );
          if (!selectedOptionFieldKeys.length) return rowsForTranslation.slice(0, 1);
          const matchesOptionField = (optionName: string) => {
            const key = toFieldKey(optionName);
            return selectedOptionFieldKeys.some((field) => {
              if (selectedContentType === "attribute_value") {
                return (
                  field === `prod_attr_value_${key}` ||
                  field.startsWith(`prod_attr_value_${key}__`)
                );
              }
              return field === `prod_attr_name_${key}`;
            });
          };
          const matchedRow = rowsForTranslation.find((row) =>
            row.options.some((option) => matchesOptionField(option.name)),
          );
          return matchedRow ? [matchedRow] : [];
        })()
      : rowsForTranslation;

  if ((selectedContentType === "attribute" || selectedContentType === "attribute_value") && !rowsToProcess.length) {
    return {
      ok: false,
      intent,
      message: "Selected attribute names were not found in available products. Pick matching attributes and try again.",
      requests: await getLocalRequestsByShop(session.shop),
    } satisfies ActionData;
  }

  for (const row of rowsToProcess) {
    const blocks: ContentBlock[] = [];
    const hasField = (key: string) => selectedFields.includes(key);
    const sku = row.sku ?? "";

    if (hasField("name") && row.title.trim()) blocks.push({ key: "name", name: row.contentType === "category" ? "Category Name" : "Product Name", value: row.title.trim() });
    if (hasField("description") && row.description.trim()) blocks.push({ key: "description", name: "Description", value: row.description.trim() });
    if (selectedContentType !== "category" && hasField("meta_title") && row.seoTitle.trim()) blocks.push({ key: "meta_title", name: "Meta Title", value: row.seoTitle.trim() });
    if (selectedContentType !== "category" && hasField("meta_description") && row.seoDescription.trim()) blocks.push({ key: "meta_description", name: "Meta Description", value: row.seoDescription.trim() });
    if (selectedContentType === "product" && hasField("sku") && sku.trim()) blocks.push({ key: "sku", name: "SKU", value: sku.trim() });

    if (selectedContentType === "product" || selectedContentType === "category") {
      row.metafields.forEach((metafield) => {
        const selectKey = metafieldSelectValue(metafield.namespace, metafield.key);
        if (!hasField(selectKey)) return;
        const cleanValue = String(metafield.value ?? "").trim();
        if (!cleanValue) return;
        blocks.push({
          key: selectKey,
          name: `Metafield ${metafield.namespace}.${metafield.key}`,
          value: cleanValue,
        });
      });
    }

    row.options.forEach((option) => {
      const safeAttr = toFieldKey(option.name);
      if (selectedContentType === "attribute_value") {
        const valueSelectKey = `prod_attr_value_${safeAttr}`;
        const selectedIndexes = new Set(
          selectedFields
            .map((field) => field.trim().toLowerCase())
            .filter((field) => field.startsWith(`${valueSelectKey}__`))
            .map((field) => Number(field.slice(`${valueSelectKey}__`.length)))
            .filter((index) => Number.isFinite(index) && index > 0),
        );
        const includeAllValues = selectedFields.includes(valueSelectKey);
        if (!includeAllValues && !selectedIndexes.size) return;
        (option.values ?? []).forEach((value, index) => {
          const valueIndex = index + 1;
          if (!includeAllValues && !selectedIndexes.has(valueIndex)) return;
          const cleanValue = String(value ?? "").trim();
          if (!cleanValue) return;
          blocks.push({
            key: `prod_attr_custom_${safeAttr}_${valueIndex}`,
            name: "Attribute Value",
            value: cleanValue,
          });
        });
        return;
      }
      const selectKey = `prod_attr_name_${safeAttr}`;
      if (!hasField(selectKey)) return;
      const cleanName = String(option.name ?? "").trim();
      if (!cleanName) return;
      blocks.push({ key: `prod_attr_name_custom_${safeAttr}`, name: "Attribute Name", value: cleanName });
    });
    if (!blocks.length) continue;

    const payload = {
      identifier: Number(row.id.split("/").pop() ?? 0),
      type:
        selectedContentType === "category"
          ? "category"
          : selectedContentType === "attribute"
            ? "attribute"
            : selectedContentType === "attribute_value"
              ? "attribute"
            : "product",
      languages: targetLanguages,
      content: blocks,
      engine: resolveTranslationEngine(settings.translationEngine),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "api-key": settings.apiKey,
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const responseText = await response.text();
    const parsed = parseJsonSafe(responseText);
    const requestUid = extractRequestUid(parsed);

    if (response.ok) {
      successCount += 1;
      if (requestUid) {
        const attributeItemTitle =
          selectedContentType === "attribute" || selectedContentType === "attribute_value"
            ? selectedFields.map(attributeFieldLabel).filter(Boolean).join(", ")
            : null;
        await upsertLocalRequest(session.shop, {
          requestUid,
          languages: targetLanguages.join(","),
          storeLocale: selectedStoreLocale || null,
          contentType:
            selectedContentType === "category"
              ? "category"
              : selectedContentType === "attribute"
                ? "attribute"
                : selectedContentType === "attribute_value"
                  ? "attribute_value"
                : "product",
          itemId: row.id.split("/").pop() ?? row.id,
          itemTitle: attributeItemTitle || row.title,
          status: "Pending",
          isTranslated: false,
        });
      }
      await insertTranslationLog({
        shop: session.shop,
        level: "success",
        contentType: selectedContentType === "category" ? "categories" : "product",
        action: "create_requests",
        message: `Translation request sent for ${selectedContentType} ${row.title}.`,
        requestUid,
        itemId: row.id.split("/").pop() ?? row.id,
        statusCode: response.status,
        requestBody: JSON.stringify(payload),
        responseBody: responseText,
      });
    } else {
      failedCount += 1;
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: selectedContentType === "category" ? "categories" : "product",
        action: "create_requests",
        message: `Translation request failed for ${selectedContentType} ${row.title}.`,
        requestUid,
        itemId: row.id.split("/").pop() ?? row.id,
        statusCode: response.status,
        requestBody: JSON.stringify(payload),
        responseBody: responseText,
      });
    }
  }

  return withTranslationStates(session.shop, {
    ok: successCount > 0,
    intent,
    message:
      successCount === 0
        ? `Translation request failed for all selected ${
            selectedContentType === "category"
              ? "categories"
              : selectedContentType === "attribute" || selectedContentType === "attribute_value"
                ? "attribute products"
                : "products"
          }.`
        : failedCount > 0
          ? `Translation started for ${successCount} ${
              selectedContentType === "category"
                ? "category"
                : selectedContentType === "attribute" || selectedContentType === "attribute_value"
                  ? "attribute product"
                  : "product"
            }(s). ${failedCount} failed.`
          : `Translation started for ${successCount} ${
              selectedContentType === "category"
                ? "category"
                : selectedContentType === "attribute" || selectedContentType === "attribute_value"
                  ? "attribute product"
                  : "product"
            }(s).`,
    requests: await getLocalRequestsByShop(session.shop),
  });
};

export default function DashboardRoute() {
  const {
    products,
    categories,
    apiLanguages,
    localeMappings,
    storeLocales,
    localeAccessLimited,
    requests: initialRequests,
    translationStates: initialTranslationStates,
    discoveredAttributeFields,
    discoveredCategoryMetafieldFields,
  } =
    useLoaderData<typeof loader>();
  const translateFetcher = useFetcher<ActionData>();
  const requestFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const [searchTerm, setSearchTerm] = useState("");
  const [itemStatusFilter, setItemStatusFilter] = useState<
    "all" | "not" | "partial" | "translated"
  >("all");
  const [statsStoreLocale, setStatsStoreLocale] = useState<string>("all");
  const [selectedAttributeOptionKey, setSelectedAttributeOptionKey] = useState<string>("");
  const [selectedContentType, setSelectedContentType] = useState<
    "product" | "category" | "attribute" | "attribute_value"
  >("product");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const [selectedFields, setSelectedFields] = useState<string[]>([
    "name",
    "description",
    "meta_title",
    "meta_description",
  ]);
  const [statusFilter, setStatusFilter] = useState("All");
  const [requests, setRequests] = useState<RequestRow[]>(initialRequests);
  const [translationStates, setTranslationStates] = useState<ItemTranslationStateRow[]>(
    initialTranslationStates ?? [],
  );
  const [requestsPage, setRequestsPage] = useState(1);
  const requestsPerPage = 10;

  const isSubmittingTranslation = ["loading", "submitting"].includes(translateFetcher.state);
  const selectedStoreLocale = useMemo(
    () => resolveShopifyLocaleForApiLanguages(localeMappings, selectedLanguages) || "",
    [localeMappings, selectedLanguages],
  );
  const unmappedSelectedLanguages = useMemo(
    () =>
      selectedLanguages.filter((code) => !resolveShopifyLocaleForApiLanguage(localeMappings, code)),
    [localeMappings, selectedLanguages],
  );
  const mappedStoreLocaleLabel = useMemo(() => {
    if (!selectedStoreLocale) return "";
    const locale = storeLocales.find((row) => row.locale === selectedStoreLocale);
    return locale
      ? `${locale.name} (${locale.locale})`
      : selectedStoreLocale;
  }, [selectedStoreLocale, storeLocales]);

  const mappedStoreOptions = useMemo(() => {
    const locales = Object.keys(localeMappings);
    return locales.map((locale) => {
      const shopLocale = storeLocales.find((row) => row.locale === locale);
      const apiCode = localeMappings[locale];
      const label = shopLocale
        ? `${shopLocale.name} (${locale})`
        : `Store (${locale})`;
      return { locale, label, apiCode };
    });
  }, [localeMappings, storeLocales]);

  const targetLocalesForProgress = useMemo(() => {
    if (mappedStoreOptions.length) return mappedStoreOptions.map((row) => row.locale);
    return storeLocales.filter((locale) => locale.published && !locale.primary).map((l) => l.locale);
  }, [mappedStoreOptions, storeLocales]);

  const statesByKey = useMemo(() => {
    const map = new Map<string, AppliedByLocale>();
    for (const row of translationStates) {
      map.set(`${row.contentType}:${row.itemId}`, row.appliedByLocale);
    }
    return map;
  }, [translationStates]);

  const legacyLocalesByItem = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const request of requests) {
      if (!request.isTranslated || !request.itemId) continue;
      const ct = request.contentType.toLowerCase();
      const normalized =
        ct === "categories" || ct === "category"
          ? "category"
          : ct === "attribute" || ct === "attribute_value"
            ? ct
            : "product";
      const key = `${normalized}:${request.itemId}`;
      const locale = (request.storeLocale ?? "").trim().toLowerCase() || "__any__";
      const list = map.get(key) ?? [];
      list.push(locale);
      map.set(key, list);
    }
    return map;
  }, [requests]);

  const attributeItems = useMemo(() => {
    const byKey = new Map<string, { id: string; title: string; numericId: string }>();
    products.forEach((product) => {
      product.options.forEach((name) => {
        const key = toFieldKey(name);
        // Shopify product title is not an option attribute — skip noise keys.
        if (!key || key === "title" || byKey.has(key)) return;
        byKey.set(key, { id: key, title: name, numericId: key });
      });
    });
    discoveredAttributeFields
      .filter((field) => field.value.startsWith("prod_attr_name_"))
      .filter((field) => field.value !== "prod_attr_name_title")
      .forEach((field) => {
        const key = field.value.replace(/^prod_attr_name_/, "");
        if (!key || key === "title" || byKey.has(key)) return;
        byKey.set(key, {
          id: key,
          title: field.label.replace(/\s*\(Attribute Name\)\s*$/i, "") || key,
          numericId: key,
        });
      });
    return Array.from(byKey.values()).sort((a, b) => a.title.localeCompare(b.title));
  }, [discoveredAttributeFields, products]);

  /** Attribute Options mode: one row per option name (values are translated together). */
  const optionAttributeItems = useMemo(() => attributeItems, [attributeItems]);

  const optionValueItems = useMemo(() => {
    const byKey = new Map<
      string,
      {
        id: string;
        title: string;
        numericId: string;
        optionKey: string;
        optionName: string;
        valueIndex: number;
      }
    >();
    products.forEach((product) => {
      product.optionValues.forEach((value) => {
        const id = `${value.optionKey}__${value.valueIndex}`;
        if (byKey.has(id)) return;
        byKey.set(id, {
          id,
          title: value.valueName,
          numericId: String(value.valueIndex),
          optionKey: value.optionKey,
          optionName: value.optionName,
          valueIndex: value.valueIndex,
        });
      });
    });
    return Array.from(byKey.values()).sort((a, b) => {
      const byOption = a.optionName.localeCompare(b.optionName);
      if (byOption !== 0) return byOption;
      return a.title.localeCompare(b.title);
    });
  }, [products]);

  useEffect(() => {
    if (selectedContentType !== "attribute_value") return;
    if (
      selectedAttributeOptionKey &&
      optionAttributeItems.some((row) => row.id === selectedAttributeOptionKey)
    ) {
      return;
    }
    setSelectedAttributeOptionKey(optionAttributeItems[0]?.id ?? "");
  }, [selectedContentType, optionAttributeItems, selectedAttributeOptionKey]);

  const getCompletenessForItem = (
    contentType: ProgressContentType,
    itemId: string,
    requiredFields: string[],
  ): ItemCompleteness => {
    const applied = statesByKey.get(`${contentType}:${itemId}`) ?? {};
    const legacy = legacyLocalesByItem.get(`${contentType}:${itemId}`) ?? [];
    const hasFieldTracking = Object.values(applied).some((fields) => fields.length > 0);
    return computeItemCompleteness({
      requiredFields,
      appliedByLocale: applied,
      storeLocale: statsStoreLocale === "all" ? "all" : statsStoreLocale,
      targetLocales: targetLocalesForProgress,
      legacyLocales: hasFieldTracking ? [] : legacy,
    });
  };

  const itemRowsWithStatus = useMemo(() => {
    if (selectedContentType === "category") {
      return categories.map((row) => {
        const completeness = getCompletenessForItem(
          "category",
          row.numericId,
          requiredCategoryFields({ title: row.title, description: row.description }),
        );
        return {
          id: row.id,
          numericId: row.numericId,
          title: row.title,
          completeness,
        };
      });
    }
    if (selectedContentType === "attribute") {
      return attributeItems.map((row) => {
        const completeness = getCompletenessForItem(
          "attribute",
          row.id,
          requiredAttributeFields(),
        );
        return { id: row.id, numericId: row.numericId, title: row.title, completeness };
      });
    }
    if (selectedContentType === "attribute_value") {
      return optionValueItems.map((row) => {
        const completeness = getCompletenessForItem(
          "attribute_value",
          row.id,
          requiredOptionValueFields(),
        );
        return {
          id: row.id,
          numericId: row.numericId,
          title: row.title,
          completeness,
          optionKey: row.optionKey,
          optionName: row.optionName,
          valueIndex: row.valueIndex,
        };
      });
    }
    return products.map((row) => {
      const completeness = getCompletenessForItem(
        "product",
        row.numericId,
        requiredProductFields({ title: row.title, descriptionHtml: row.descriptionHtml }),
      );
      return {
        id: row.id,
        numericId: row.numericId,
        title: row.title,
        completeness,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers close over latest maps
  }, [
    attributeItems,
    categories,
    optionValueItems,
    products,
    selectedContentType,
    statesByKey,
    legacyLocalesByItem,
    statsStoreLocale,
    targetLocalesForProgress,
  ]);

  const translationProgress = useMemo(() => {
    if (selectedContentType === "attribute_value" && selectedAttributeOptionKey) {
      const scoped = itemRowsWithStatus.filter(
        (row) => "optionKey" in row && row.optionKey === selectedAttributeOptionKey,
      );
      return computeProgressStats(scoped.map((row) => row.completeness));
    }
    return computeProgressStats(itemRowsWithStatus.map((row) => row.completeness));
  }, [itemRowsWithStatus, selectedAttributeOptionKey, selectedContentType]);

  const progressCards = useMemo(
    () => [
      {
        key: "translated",
        label: "Translated",
        count: translationProgress.translated,
        color: "#22c55e",
      },
      {
        key: "partial",
        label: "Partially Translated",
        count: translationProgress.partial,
        color: "#f59e0b",
      },
      {
        key: "not",
        label: "Not Translated",
        count: translationProgress.notTranslated,
        color: "#38bdf8",
      },
    ],
    [translationProgress],
  );

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return itemRowsWithStatus.filter((row) => {
      if (
        selectedContentType === "attribute_value" &&
        selectedAttributeOptionKey &&
        "optionKey" in row &&
        row.optionKey !== selectedAttributeOptionKey
      ) {
        return false;
      }
      if (!matchesStatusFilter(row.completeness.status, itemStatusFilter)) return false;
      if (!term) return true;
      return `${row.title} ${row.numericId}`.toLowerCase().includes(term);
    });
  }, [
    itemRowsWithStatus,
    itemStatusFilter,
    searchTerm,
    selectedAttributeOptionKey,
    selectedContentType,
  ]);

  const selectedProducts = useMemo(
    () =>
      selectedContentType !== "category"
        ? products.filter((product) => selectedItems.includes(product.id))
        : [],
    [products, selectedItems, selectedContentType],
  );
  const selectedCategories = useMemo(
    () =>
      selectedContentType === "category"
        ? categories.filter((category) => selectedItems.includes(category.id))
        : [],
    [categories, selectedItems, selectedContentType],
  );

  const dynamicAttributes = useMemo(() => {
    const set = new Set<string>();
    selectedProducts.forEach((product) => product.options.forEach((name) => name.trim() && set.add(name.trim())));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [selectedProducts]);

  const selectedProductMetafieldFields = useMemo(() => {
    if (!selectedProducts.length) return [] as AttributePickerOption[];
    const allowedKeys = new Set(
      selectedProducts.flatMap((product) => product.metafieldKeys ?? []),
    );
    if (!allowedKeys.size) return [] as AttributePickerOption[];
    return discoveredAttributeFields.filter(
      (field) => field.value.startsWith("mf__") && allowedKeys.has(field.value),
    );
  }, [discoveredAttributeFields, selectedProducts]);

  const selectedCategoryMetafieldFields = useMemo(() => {
    if (!selectedCategories.length) return [] as AttributePickerOption[];
    const allowedKeys = new Set(
      selectedCategories.flatMap((category) => category.metafieldKeys ?? []),
    );
    if (!allowedKeys.size) return [] as AttributePickerOption[];
    return discoveredCategoryMetafieldFields.filter((field) => allowedKeys.has(field.value));
  }, [discoveredCategoryMetafieldFields, selectedCategories]);

  const discoveredAttributeValueFields = useMemo(
    () =>
      discoveredAttributeFields
        .filter((field) => field.value.startsWith("prod_attr_name_"))
        .filter((field) => field.value !== "prod_attr_name_title")
        .map((field) => ({
          value: field.value.replace("prod_attr_name_", "prod_attr_value_"),
          label: field.label.replace("(Attribute Name)", "(Attribute Value)"),
        })),
    [discoveredAttributeFields],
  );

  const fieldOptions = useMemo(
    () =>
      selectedContentType === "category"
        ? [
            { value: "name", label: "Category Name" },
            { value: "description", label: "Category Description" },
            ...selectedCategoryMetafieldFields,
          ]
        : selectedContentType === "attribute_value"
          ? discoveredAttributeValueFields.length
            ? discoveredAttributeValueFields
            : dynamicAttributes.map((attr) => ({
                value: `prod_attr_value_${toFieldKey(attr)}`,
                label: `${attr} (Attribute Value)`,
              }))
        : selectedContentType === "attribute"
          ? discoveredAttributeFields.filter((field) => field.value !== "prod_attr_name_title")
        : [
            { value: "name", label: "Product Name" },
            { value: "description", label: "Description" },
            { value: "meta_title", label: "Meta Title" },
            { value: "meta_description", label: "Meta Description" },
            { value: "sku", label: "SKU" },
            ...(selectedProducts.length
              ? [
                  ...selectedProductMetafieldFields,
                  ...dynamicAttributes.map((attr) => ({
                    value: `prod_attr_name_${toFieldKey(attr)}`,
                    label: `${attr} (Attribute Name)`,
                  })),
                ]
              : []),
          ],
    [
      discoveredAttributeFields,
      discoveredAttributeValueFields,
      dynamicAttributes,
      selectedCategoryMetafieldFields,
      selectedContentType,
      selectedProductMetafieldFields,
      selectedProducts.length,
    ],
  );

  useEffect(() => {
    if (selectedContentType !== "product" && selectedContentType !== "category") return;
    const allowed = new Set(fieldOptions.map((field) => field.value));
    setSelectedFields((prev) => {
      const next = prev.filter((field) => allowed.has(field));
      return next.length === prev.length && next.every((field, index) => field === prev[index])
        ? prev
        : next;
    });
  }, [fieldOptions, selectedContentType]);

  const visibleRequests = useMemo(
    () => requests.filter((r) => statusFilter === "All" || r.status.toLowerCase() === statusFilter.toLowerCase()),
    [requests, statusFilter],
  );
  const totalRequestPages = Math.max(1, Math.ceil(visibleRequests.length / requestsPerPage));
  const paginatedRequests = useMemo(() => {
    const start = (requestsPage - 1) * requestsPerPage;
    return visibleRequests.slice(start, start + requestsPerPage);
  }, [visibleRequests, requestsPage]);

  useEffect(() => {
    if (!translateFetcher.data?.message) return;
    shopify.toast.show(translateFetcher.data.message, translateFetcher.data.ok ? undefined : { isError: true });
    if (translateFetcher.data.requests) setRequests(translateFetcher.data.requests);
    if (translateFetcher.data.translationStates) {
      setTranslationStates(translateFetcher.data.translationStates);
    }
  }, [translateFetcher.data, shopify]);

  useEffect(() => {
    if (!requestFetcher.data?.message) return;
    shopify.toast.show(requestFetcher.data.message, requestFetcher.data.ok ? undefined : { isError: true });
    if (requestFetcher.data.requests) setRequests(requestFetcher.data.requests);
    if (requestFetcher.data.translationStates) {
      setTranslationStates(requestFetcher.data.translationStates);
    }
  }, [requestFetcher.data, shopify]);

  useEffect(() => {
    setSearchTerm("");
    setItemStatusFilter("all");
    if (selectedContentType !== "attribute_value") {
      setSelectedAttributeOptionKey("");
    }
  }, [selectedContentType]);

  useEffect(() => {
    setRequestsPage(1);
  }, [statusFilter]);

  useEffect(() => {
    if (requestsPage > totalRequestPages) {
      setRequestsPage(totalRequestPages);
    }
  }, [requestsPage, totalRequestPages]);
  useEffect(() => {
    if (selectedContentType === "attribute" || selectedContentType === "attribute_value") return;
    setSelectedItems([]);
  }, [selectedContentType]);
  useEffect(() => {
    setSelectedFields(
      selectedContentType === "category"
        ? ["name", "description"]
        : selectedContentType === "attribute" || selectedContentType === "attribute_value"
          ? []
        : ["name", "description", "meta_title", "meta_description"],
    );
  }, [selectedContentType]);

  const toggleInList = (value: string, list: string[], setter: (next: string[]) => void) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const statusBadgeStyle = (status: string) => {
    const s = status.toLowerCase();
    if (s === "completed") return { background: "#16a34a", color: "#fff" };
    if (s === "started") return { background: "#2563eb", color: "#fff" };
    return { background: "#6b7280", color: "#fff" };
  };

  return (
    <s-page heading="Lingotuner Translator Dashboard" inlineSize="large">
      <translateFetcher.Form method="POST">
        <input type="hidden" name="intent" value="start_translation" />
        <input type="hidden" name="selectedContentType" value={selectedContentType} />
        {selectedItems.map((id) => (
          <input key={`item-${id}`} type="hidden" name="selectedItems" value={id} />
        ))}
        {selectedLanguages.map((code) => (
          <input key={`lang-${code}`} type="hidden" name="targetLanguages" value={code} />
        ))}
        <input type="hidden" name="selectedStoreLocale" value={selectedStoreLocale} />
        {selectedFields.map((field) => (
          <input key={`field-${field}`} type="hidden" name="selectedFields" value={field} />
        ))}

        <s-section heading="Lingotuner Panel" padding="base">
          <div
            className="lingotuner-panel-layout"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(160px, 200px) minmax(0, 1fr)",
              gap: "20px",
              alignItems: "start",
              width: "100%",
              boxSizing: "border-box",
            }}
          >
            <div style={{ paddingTop: "2px" }}>
              <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600, color: "#303030" }}>
                Content Types to Translate
              </h4>
              <div style={{ display: "grid", gap: "10px" }}>
                {(
                  [
                    ["product", "Products"],
                    ["category", "Categories"],
                    ["attribute", "Attribute Names"],
                    ["attribute_value", "Attribute Values"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      cursor: "pointer",
                      color: "#4b5563",
                    }}
                  >
                    <input
                      type="radio"
                      checked={selectedContentType === value}
                      onChange={() => setSelectedContentType(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
              <div>
                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    maxWidth: "320px",
                    marginBottom: "12px",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "#374151" }}>Store</span>
                  <select
                    value={statsStoreLocale}
                    onChange={(event) => setStatsStoreLocale(event.target.value)}
                    style={{
                      height: "36px",
                      padding: "0 10px",
                      border: "1px solid #d1d5db",
                      borderRadius: "6px",
                      background: "#fff",
                    }}
                  >
                    <option value="all">All stores</option>
                    {mappedStoreOptions.map((store) => (
                      <option key={store.locale} value={store.locale}>
                        {store.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!mappedStoreOptions.length ? (
                  <p style={{ margin: "0 0 12px", color: "#b45309", fontSize: "13px" }}>
                    Map stores to languages in Settings to filter stats by store.
                  </p>
                ) : null}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: "12px",
                  }}
                >
                  {progressCards.map((card) => {
                    const total = translationProgress.total;
                    const percent = progressPercent(card.count, total);
                    return (
                      <div
                        key={card.key}
                        style={{
                          background: "#fff",
                          border: "1px solid #e5e7eb",
                          borderRadius: "8px",
                          padding: "14px 16px 12px",
                          boxSizing: "border-box",
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            color: "#6b7280",
                            fontSize: "13px",
                            fontWeight: 500,
                            marginBottom: "10px",
                          }}
                        >
                          {card.label}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: "22px",
                                fontWeight: 700,
                                color: "#111827",
                                lineHeight: 1.2,
                                letterSpacing: "-0.02em",
                              }}
                            >
                              {card.count} / {total}
                            </div>
                            <div
                              style={{
                                marginTop: "8px",
                                width: "36px",
                                height: "4px",
                                borderRadius: "2px",
                                background: card.color,
                              }}
                            />
                          </div>
                          <div
                            style={{
                              color: card.color,
                              fontSize: "18px",
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            {percent}%
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div
                className="lingotuner-panel-grid"
                style={{
                  display: "grid",
                  width: "100%",
                  boxSizing: "border-box",
                  gridTemplateColumns:
                    selectedContentType === "attribute" || selectedContentType === "attribute_value"
                      ? "minmax(0, 1.6fr) minmax(0, 1fr)"
                      : "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)",
                  gap: "16px",
                  alignItems: "start",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <h4 style={{ margin: "0 0 10px", fontSize: "14px", fontWeight: 600, color: "#303030" }}>
                    {selectedContentType === "category"
                      ? "Select Items to Translate"
                      : selectedContentType === "attribute"
                        ? "Attribute Names"
                        : selectedContentType === "attribute_value"
                          ? "Select Attribute Values to Translate"
                          : "Select Items to Translate"}
                  </h4>
                  {selectedContentType === "attribute_value" ? (
                    <p style={{ margin: "0 0 10px", color: "#6b7280", fontSize: "13px" }}>
                      Choose an attribute, then tick only the values you want to translate.
                    </p>
                  ) : null}
                  {selectedContentType === "attribute_value" ? (
                    <label
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        marginBottom: "12px",
                        maxWidth: "100%",
                      }}
                    >
                      <span style={{ fontSize: "12px", color: "#6b7280", fontWeight: 500 }}>Attribute</span>
                      <select
                        value={selectedAttributeOptionKey}
                        onChange={(event) => {
                          setSelectedAttributeOptionKey(event.target.value);
                          setSearchTerm("");
                          setItemStatusFilter("all");
                        }}
                        style={{
                          height: "36px",
                          padding: "0 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: "6px",
                          background: "#fff",
                          width: "100%",
                          boxSizing: "border-box",
                        }}
                      >
                        {!optionAttributeItems.length ? (
                          <option value="">No attributes found</option>
                        ) : null}
                        {optionAttributeItems.map((attr) => (
                          <option key={attr.id} value={attr.id}>
                            {attr.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "10px",
                      alignItems: "flex-end",
                      marginBottom: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        width: "100%",
                        marginBottom: "8px",
                      }}
                    >
                      <select
                        value={itemStatusFilter}
                        onChange={(event) =>
                          setItemStatusFilter(
                            event.target.value as "all" | "not" | "partial" | "translated",
                          )
                        }
                        style={{
                          width: "90px",
                          height: "36px",
                          padding: "0 8px",
                          border: "1px solid #d1d5db",
                          borderRadius: "6px",
                          background: "#fff",
                          fontSize: "13px",
                          boxSizing: "border-box",
                          flexShrink: 0,
                        }}
                      >
                        <option value="all">Status</option>
                        <option value="not">Items without translation</option>
                        <option value="partial">Partially translated</option>
                        <option value="translated">Translated</option>
                      </select>
                      <input
                        type="text"
                        placeholder="search by name"
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        style={{
                          height: "36px",
                          boxSizing: "border-box",
                          width: "100%",
                          padding: "0 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: "6px",
                        }}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      border: "1px solid #d9d9d9",
                      borderRadius: "6px",
                      maxHeight: "340px",
                      overflowY: "auto",
                    }}
                  >
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: "6px", width: "34px" }} />
                          <th style={{ textAlign: "left", padding: "6px" }}>
                            {selectedContentType === "category"
                              ? "Category"
                              : selectedContentType === "attribute"
                                ? "Attribute"
                                : selectedContentType === "attribute_value"
                                  ? "Value"
                                  : "Product"}
                          </th>
                          <th style={{ textAlign: "left", padding: "6px", width: "120px" }}>Status</th>
                          <th style={{ textAlign: "left", padding: "6px", width: "88px" }}>ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredItems.map((row) => {
                          const colors = statusBadgeColors(row.completeness.status);
                          const isProductOrCategory =
                            selectedContentType === "product" || selectedContentType === "category";
                          const attributeFieldKey =
                            selectedContentType === "attribute"
                              ? `prod_attr_name_${row.id}`
                              : selectedContentType === "attribute_value"
                                ? `prod_attr_value_${"optionKey" in row ? row.optionKey : row.id}__${
                                    "valueIndex" in row ? row.valueIndex : row.numericId
                                  }`
                                : "";
                          const isChecked = isProductOrCategory
                            ? selectedItems.includes(row.id)
                            : Boolean(attributeFieldKey) && selectedFields.includes(attributeFieldKey);
                          const onToggle = () => {
                            if (isProductOrCategory) {
                              toggleInList(row.id, selectedItems, setSelectedItems);
                              return;
                            }
                            if (!attributeFieldKey) return;
                            toggleInList(attributeFieldKey, selectedFields, setSelectedFields);
                          };
                          return (
                            <tr
                              key={row.id}
                              style={{
                                borderLeft: `3px solid ${colors.bar}`,
                              }}
                              title={statusTooltip(row.completeness)}
                            >
                              <td style={{ padding: "6px" }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={onToggle}
                                />
                              </td>
                              <td style={{ padding: "6px" }}>{row.title}</td>
                              <td style={{ padding: "6px" }}>
                                <span
                                  title={statusTooltip(row.completeness)}
                                  style={{
                                    display: "inline-block",
                                    borderRadius: "999px",
                                    padding: "2px 10px",
                                    fontSize: "12px",
                                    fontWeight: 600,
                                    background: colors.background,
                                    color: colors.color,
                                    cursor: "help",
                                  }}
                                >
                                  {statusBadgeLabel(row.completeness.status)}
                                </span>
                              </td>
                              <td style={{ padding: "6px", fontSize: "12px", color: "#6b7280" }}>
                                {row.numericId}
                              </td>
                            </tr>
                          );
                        })}
                        {!filteredItems.length ? (
                          <tr>
                            <td colSpan={4} style={{ padding: "6px" }}>
                              No items match the current filters.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                  {selectedContentType === "attribute" || selectedContentType === "attribute_value" ? (
                    <p style={{ marginTop: "8px", color: "#6b7280", fontSize: "13px" }}>
                      {selectedContentType === "attribute"
                        ? "Tick attribute names to translate, then pick a language."
                        : "Tick the term values you want to translate."}
                      {selectedFields.length
                        ? ` Selected: ${selectedFields.length}.`
                        : " Select at least one to enable Start Translation."}
                    </p>
                  ) : null}
                </div>

                <div style={{ minWidth: 0 }}>
                  <h4 style={{ margin: "0 0 10px", fontSize: "14px", fontWeight: 600, color: "#303030" }}>
                    Select Language
                  </h4>
                  {apiLanguages.length ? (
                    <>
                      <select
                        multiple
                        value={selectedLanguages}
                        onChange={(event) =>
                          setSelectedLanguages(
                            Array.from(event.currentTarget.selectedOptions).map((option) => option.value),
                          )
                        }
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          minHeight: "250px",
                          padding: "6px",
                          border: "1px solid #d1d5db",
                          borderRadius: "6px",
                        }}
                      >
                        {apiLanguages.map((language) => (
                          <option key={language.code} value={language.code}>
                            {language.name} ({language.code})
                          </option>
                        ))}
                      </select>
                      <p style={{ marginTop: "8px", color: "#6b7280", fontSize: "13px" }}>
                        These languages are sent to your translation API. Shopify store locale is applied
                        automatically from Settings mappings
                        {mappedStoreLocaleLabel ? `: ${mappedStoreLocaleLabel}` : ""}.
                      </p>
                      {unmappedSelectedLanguages.length ? (
                        <p style={{ marginTop: "6px", color: "#b45309", fontSize: "13px" }}>
                          Unmapped languages: {unmappedSelectedLanguages.join(", ")}. Configure them on
                          Settings.
                        </p>
                      ) : null}
                      {localeAccessLimited ? (
                        <p style={{ marginTop: "6px", color: "#b45309", fontSize: "13px" }}>
                          Store locales scope may be missing. Add read_locales and reinstall if needed.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <s-paragraph>No API languages found. Fetch languages on Settings page first.</s-paragraph>
                  )}
                </div>

                {selectedContentType !== "attribute" && selectedContentType !== "attribute_value" ? (
                  <div style={{ minWidth: 0 }}>
                    <h4 style={{ margin: "0 0 10px", fontSize: "14px", fontWeight: 600, color: "#303030" }}>
                      Content fields to include
                    </h4>
                    <select
                      multiple
                      value={selectedFields}
                      onChange={(event) =>
                        setSelectedFields(Array.from(event.currentTarget.selectedOptions).map((o) => o.value))
                      }
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        minHeight: "250px",
                        padding: "6px",
                        border: "1px solid #d1d5db",
                        borderRadius: "6px",
                      }}
                    >
                      {fieldOptions.map((field) => (
                        <option key={field.value} value={field.value}>
                          {field.label}
                        </option>
                      ))}
                    </select>
                    <p style={{ marginTop: "8px", color: "#6b7280", fontSize: "13px" }}>
                      {selectedContentType === "product"
                        ? selectedProducts.length
                          ? "Select fields to send for translation. Product options and text metafields appear for the selected product(s)."
                          : "Select a product to see its options and text metafields."
                        : selectedCategories.length
                          ? "Select fields to send for category translation. Text metafields appear for the selected category."
                          : "Select a category to see its text metafields."}
                    </p>
                  </div>
                ) : null}
              </div>

              <div>
                <s-button
                  type="submit"
                  variant="primary"
                  disabled={
                    !selectedLanguages.length ||
                    !selectedFields.length ||
                    !selectedStoreLocale ||
                    Boolean(unmappedSelectedLanguages.length)
                  }
                  {...(isSubmittingTranslation ? { loading: true } : {})}
                >
                  Start Translation
                </s-button>
              </div>
            </div>
          </div>
        </s-section>
      </translateFetcher.Form>

      <div style={{ marginTop: "16px" }}>
        <s-section heading="Translation Requests" padding="base">
          <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
            <label>
              Status filter{" "}
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                style={{ minWidth: "120px", padding: "6px" }}
              >
                <option value="All">All</option>
                <option value="Pending">Pending</option>
                <option value="Started">Started</option>
                <option value="Completed">Completed</option>
              </select>
            </label>
            <s-button
              variant="secondary"
              onClick={() => requestFetcher.submit({ intent: "refresh_requests" }, { method: "POST" })}
              {...(["loading", "submitting"].includes(requestFetcher.state) ? { loading: true } : {})}
            >
              Refresh statuses from API
            </s-button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "1000px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "8px" }}>Request ID</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Language(s)</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Store Locale</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Content Type</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Item</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Status</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Created Date</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {paginatedRequests.map((requestRow) => {
                  const completed = requestRow.status.toLowerCase() === "completed";
                  return (
                    <tr key={requestRow.requestUid}>
                      <td style={{ padding: "8px" }}>{requestRow.requestUid}</td>
                      <td style={{ padding: "8px" }}>{requestRow.languages}</td>
                      <td style={{ padding: "8px" }}>{requestRow.storeLocale || "-"}</td>
                      <td style={{ padding: "8px", textTransform: "capitalize" }}>{requestRow.contentType}</td>
                      <td style={{ padding: "8px" }}>
                        {requestRow.itemTitle || (requestRow.itemId ? `Item #${requestRow.itemId}` : "-")}
                      </td>
                      <td style={{ padding: "8px" }}>
                        <span
                          style={{
                            ...statusBadgeStyle(requestRow.status),
                            borderRadius: "14px",
                            padding: "2px 10px",
                            fontSize: "12px",
                            display: "inline-block",
                          }}
                        >
                          {requestRow.status}
                        </span>
                      </td>
                      <td style={{ padding: "8px" }}>{new Date(requestRow.createdAt).toLocaleString()}</td>
                      <td style={{ padding: "8px", display: "flex", gap: "8px" }}>
                        {completed ? (
                          <s-button
                            variant="secondary"
                            onClick={() =>
                              requestFetcher.submit(
                                {
                                  intent: "fetch_content",
                                  requestUid: requestRow.requestUid,
                                  shopifyLocale:
                                    requestRow.storeLocale ||
                                    resolveShopifyLocaleForApiLanguages(
                                      localeMappings,
                                      (requestRow.languages ?? "")
                                        .split(",")
                                        .map((code) => code.trim())
                                        .filter(Boolean),
                                    ) ||
                                    "",
                                },
                                { method: "POST" },
                              )
                            }
                          >
                            {requestRow.isTranslated ? "Re-apply" : "Fetch content"}
                          </s-button>
                        ) : null}
                        {requestRow.isTranslated ? (
                          <span style={{ alignSelf: "center", color: "#059669", fontSize: "12px" }}>
                            Applied
                          </span>
                        ) : null}
                        <s-button
                          variant="secondary"
                          onClick={() =>
                            requestFetcher.submit(
                              { intent: "delete_request", requestUid: requestRow.requestUid },
                              { method: "POST" },
                            )
                          }
                        >
                          Delete
                        </s-button>
                      </td>
                    </tr>
                  );
                })}
                {!paginatedRequests.length ? (
                  <tr>
                    <td colSpan={8} style={{ padding: "8px" }}>
                      No translation requests yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {visibleRequests.length ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: "12px",
                gap: "12px",
              }}
            >
              <div style={{ color: "#6b7280", fontSize: "13px" }}>
                Showing {(requestsPage - 1) * requestsPerPage + 1}-
                {Math.min(requestsPage * requestsPerPage, visibleRequests.length)} of {visibleRequests.length}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <s-button
                  variant="secondary"
                  disabled={requestsPage === 1}
                  onClick={() => setRequestsPage((page) => Math.max(1, page - 1))}
                >
                  Previous
                </s-button>
                <span style={{ minWidth: "88px", textAlign: "center", fontSize: "13px" }}>
                  Page {requestsPage} / {totalRequestPages}
                </span>
                <s-button
                  variant="secondary"
                  disabled={requestsPage === totalRequestPages}
                  onClick={() => setRequestsPage((page) => Math.min(totalRequestPages, page + 1))}
                >
                  Next
                </s-button>
              </div>
            </div>
          ) : null}
        </s-section>
      </div>
    </s-page>
  );
}
