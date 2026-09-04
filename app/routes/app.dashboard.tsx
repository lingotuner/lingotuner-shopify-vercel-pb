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

type LanguageOption = { code: string; name: string };
type ProductRow = { id: string; numericId: string; title: string; handle: string; options: string[] };
type CategoryRow = { id: string; numericId: string; title: string; handle: string; description: string; seoTitle: string; seoDescription: string };
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
type ActionData = { ok: boolean; intent: string; message: string; requests?: RequestRow[] };

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
    const [, namespace = "", metafieldKey = ""] = key.split("__");
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

function parseTranslatedBlocks(payload: unknown, preferredLocale?: string): ContentBlock[] {
  const fromArrayLanguagePayload = () => {
    if (!Array.isArray(payload) || !payload.length) return [] as ContentBlock[];
    const normalizedPreferred = (preferredLocale ?? "").trim().toLowerCase();
    const selected =
      payload.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const row = entry as Record<string, unknown>;
        const locale = String(row.locale ?? row.language ?? row.lang ?? "").trim().toLowerCase();
        return Boolean(normalizedPreferred) && locale === normalizedPreferred;
      }) ?? payload[0];
    if (!selected || typeof selected !== "object") return [] as ContentBlock[];
    const content = (selected as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [] as ContentBlock[];
    return content
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const key = String(row.key ?? "").trim();
        const value = String(row.value ?? "").trim();
        if (!key || !value) return null;
        return { key, name: String(row.name ?? key), value };
      })
      .filter((x): x is ContentBlock => Boolean(x));
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
    return candidate
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const key = String(row.key ?? "").trim();
        const value = String(row.value ?? "").trim();
        if (!key || !value) return null;
        return { key, name: String(row.name ?? key), value };
      })
      .filter((x): x is ContentBlock => Boolean(x));
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
              options { name }
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
            node: { id: string; title: string; handle: string; options?: Array<{ name: string }> };
          }>;
        };
      };
    };
    const page = json.data?.products;
    const edges = page?.edges ?? [];
    for (const edge of edges) {
      products.push({
        id: edge.node.id,
        numericId: edge.node.id.split("/").pop() ?? edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        options: (edge.node.options ?? []).map((option) => option.name),
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
  const [productResult, categoryResult, metafieldDefinitionsResult, requestsResult, cachedLanguagesResult, attributeIndexResult, localeMappingsResult] = await Promise.allSettled([
    fetchAllDashboardProducts(admin),
    fetchAllDashboardCategories(admin),
    admin.graphql(
      `#graphql
      query DashboardProductMetafieldDefinitions {
        metafieldDefinitions(first: 100, ownerType: PRODUCT) {
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
  ]);

  if (
    productResult.status === "rejected" ||
    categoryResult.status === "rejected" ||
    metafieldDefinitionsResult.status === "rejected"
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

  const textMetafieldTypes = new Set([
    "single_line_text_field",
    "multi_line_text_field",
    "rich_text_field",
  ]);
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

  const metafieldDefs = metafieldDefinitionsJson.data?.metafieldDefinitions?.edges ?? [];
  metafieldDefs.forEach((edge) => {
    const node = edge.node;
    const namespace = String(node?.namespace ?? "").trim();
    const key = String(node?.key ?? "").trim();
    const name = String(node?.name ?? "").trim();
    const typeName = String(node?.type?.name ?? "").trim();
    if (!namespace || !key || !textMetafieldTypes.has(typeName)) return;
    pushAttribute(`mf__${toFieldKey(namespace)}__${toFieldKey(key)}`, `${name || key} (${namespace}.${key})`);
  });

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
    storeLocales = (localesJson.data?.shopLocales ?? []).filter((locale) => locale.published);
  } catch {
    localeAccessLimited = true;
  }

  const attributeFields =
    attributeIndex?.attributes?.length
      ? attributeIndex.attributes
      : discoveredAttributeFields;

  return {
    products,
    categories,
    apiLanguages: cachedLanguages,
    localeMappings,
    storeLocales,
    localeAccessLimited,
    requests,
    discoveredAttributeFields: attributeFields,
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
    return {
      ok: true,
      intent,
      message: "Statuses refreshed from API.",
      requests: await getLocalRequestsByShop(session.shop),
    } satisfies ActionData;
  }

  if (intent === "sync_attribute_index") {
    const optionNameSet = new Set<string>();
    const textMetafieldTypes = new Set(["single_line_text_field", "multi_line_text_field", "rich_text_field"]);
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
      if (!namespace || !key || !textMetafieldTypes.has(typeName)) return;
      const value = `mf__${toFieldKey(namespace)}__${toFieldKey(key)}`;
      if (seenValues.has(value)) return;
      seenValues.add(value);
      attributes.push({ value, label: `${name || key} (${namespace}.${key})` });
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
    const blocks = parseTranslatedBlocks(parsedPayload, translationLocale || undefined);
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
            edges?: Array<{ node: { id: string; title: string } }>;
          };
        };
      };
      const collectionGid = categoryLookupJson.data?.collections?.edges?.[0]?.node?.id;
      if (!collectionGid) {
        return {
          ok: false,
          intent,
          message: "Category not found in Shopify for this request.",
          requests: await getLocalRequestsByShop(session.shop),
        } satisfies ActionData;
      }

      if (isPrimaryLocale) {
        const input: Record<string, unknown> = { id: collectionGid };
        if (translated.title.trim()) input.title = translated.title.trim();
        if (translated.description.trim()) input.descriptionHtml = translated.description.trim();
        if (Object.keys(input).length <= 1) {
          return {
            ok: false,
            intent,
            message: "No translated category content available to apply on default language.",
            requests: await getLocalRequestsByShop(session.shop),
          } satisfies ActionData;
        }

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

        if (!translationInputs.length) {
          return {
            ok: false,
            intent,
            message: "No valid category fields available to register for selected locale.",
            requests: await getLocalRequestsByShop(session.shop),
          } satisfies ActionData;
        }

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
      }

      await markTranslated(session.shop, requestUid);
      await insertTranslationLog({
        shop: session.shop,
        level: "success",
        contentType: "categories",
        action: "fetch_content",
        message: `Translated category content applied for locale ${translationLocale}.`,
        requestUid,
        itemId: requestRow.itemId,
        statusCode: response.status,
        responseBody: responseText,
      });
      return {
        ok: true,
        intent,
        message: `Category translation applied for locale ${translationLocale}.`,
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
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
          edges?: Array<{ node: { id: string; title: string; options?: ProductOptionRow[] } }>;
        };
      };
    };
    const productGid = productLookupJson.data?.products?.edges?.[0]?.node?.id;
    const productOptions = productLookupJson.data?.products?.edges?.[0]?.node?.options ?? [];
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

    let appliedProductTranslations = 0;

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

      if (!appliedDefaultProductChanges && !appliedDefaultOptionNameChanges) {
        return {
          ok: false,
          intent,
          message: "No translated content available to apply on default language.",
          requests: await getLocalRequestsByShop(session.shop),
        } satisfies ActionData;
      }

      await markTranslated(session.shop, requestUid);
      await insertTranslationLog({
        shop: session.shop,
        level: "success",
        contentType: "product",
        action: "fetch_content",
        message:
          appliedDefaultOptionNameChanges > 0
            ? `Translated content applied to default locale ${translationLocale}, including ${appliedDefaultOptionNameChanges} attribute name(s).`
            : `Translated content applied to default locale ${translationLocale} via product update.`,
        requestUid,
        itemId: requestRow.itemId,
        statusCode: response.status,
        responseBody: responseText,
      });
      return {
        ok: true,
        intent,
        message:
          appliedDefaultOptionNameChanges > 0
            ? `Translated content applied on default locale ${translationLocale} with ${appliedDefaultOptionNameChanges} attribute name(s).`
            : `Translated content applied on default locale ${translationLocale}.`,
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
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

    if (!appliedProductTranslations && !appliedOptionNameCount && !appliedOptionValueCount) {
      return {
        ok: false,
        intent,
        message: "No valid translated fields or attribute names were available to apply for selected locale.",
        requests: await getLocalRequestsByShop(session.shop),
      } satisfies ActionData;
    }

    await markTranslated(session.shop, requestUid);
    await insertTranslationLog({
      shop: session.shop,
      level: "success",
      contentType: "product",
      action: "fetch_content",
      message:
        appliedOptionNameCount > 0
          ? `Translated content fetched and applied to locale ${translationLocale}, including ${appliedOptionNameCount} attribute name(s).`
          : appliedOptionValueCount > 0
            ? `Translated content fetched and applied to locale ${translationLocale}, including ${appliedOptionValueCount} attribute value(s).`
          : `Translated content fetched and applied to locale ${translationLocale}.`,
      requestUid,
      itemId: requestRow.itemId,
      statusCode: response.status,
      responseBody: responseText,
    });
    return {
      ok: true,
      intent,
      message:
        appliedOptionNameCount > 0
          ? `Translated content applied for locale ${translationLocale} with ${appliedOptionNameCount} attribute name(s).`
          : appliedOptionValueCount > 0
            ? `Translated content applied for locale ${translationLocale} with ${appliedOptionValueCount} attribute value(s).`
          : `Translated content applied for locale ${translationLocale}.`,
      requests: await getLocalRequestsByShop(session.shop),
    } satisfies ActionData;
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
          contentType: "product" as const,
        }));
  const rowsToProcess =
    selectedContentType === "attribute" || selectedContentType === "attribute_value"
      ? (() => {
          const selectedOptionFieldKeys = new Set(
            selectedFields
              .map((field) => field.trim().toLowerCase())
              .filter((field) =>
                selectedContentType === "attribute_value"
                  ? field.startsWith("prod_attr_value_")
                  : field.startsWith("prod_attr_name_"),
              ),
          );
          if (!selectedOptionFieldKeys.size) return rowsForTranslation.slice(0, 1);
          const matchedRow = rowsForTranslation.find((row) =>
            row.options.some((option) =>
              selectedOptionFieldKeys.has(
                `${
                  selectedContentType === "attribute_value" ? "prod_attr_value_" : "prod_attr_name_"
                }${toFieldKey(option.name)}`,
              ),
            ),
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
    if (hasField("short_description") && row.description.trim()) blocks.push({ key: "short_description", name: "Short Description", value: row.description.trim().slice(0, 280) });
    if (selectedContentType !== "category" && hasField("meta_title") && row.seoTitle.trim()) blocks.push({ key: "meta_title", name: "Meta Title", value: row.seoTitle.trim() });
    if (selectedContentType !== "category" && hasField("meta_description") && row.seoDescription.trim()) blocks.push({ key: "meta_description", name: "Meta Description", value: row.seoDescription.trim() });
    if (selectedContentType === "product" && hasField("sku") && sku.trim()) blocks.push({ key: "sku", name: "SKU", value: sku.trim() });

    row.options.forEach((option) => {
      const safeAttr = toFieldKey(option.name);
      if (selectedContentType === "attribute_value") {
        const valueSelectKey = `prod_attr_value_${safeAttr}`;
        if (!hasField(valueSelectKey)) return;
        (option.values ?? []).forEach((value, index) => {
          const cleanValue = String(value ?? "").trim();
          if (!cleanValue) return;
          blocks.push({ key: `prod_attr_custom_${safeAttr}_${index + 1}`, name: "Attribute Value", value: cleanValue });
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

  return {
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
  } satisfies ActionData;
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
    discoveredAttributeFields,
    attributeIndexMeta,
  } =
    useLoaderData<typeof loader>();
  const translateFetcher = useFetcher<ActionData>();
  const requestFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const [searchTerm, setSearchTerm] = useState("");
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

  const filteredProducts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return products;
    return products.filter((product) =>
      `${product.title} ${product.handle} ${product.numericId}`.toLowerCase().includes(term),
    );
  }, [products, searchTerm]);
  const filteredCategories = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return categories;
    return categories.filter((category) =>
      `${category.title} ${category.handle} ${category.numericId}`.toLowerCase().includes(term),
    );
  }, [categories, searchTerm]);
  const filteredItems = selectedContentType === "category" ? filteredCategories : filteredProducts;

  const selectedProducts = useMemo(
    () =>
      selectedContentType !== "category"
        ? products.filter((product) => selectedItems.includes(product.id))
        : [],
    [products, selectedItems, selectedContentType],
  );

  const dynamicAttributes = useMemo(() => {
    const set = new Set<string>();
    selectedProducts.forEach((product) => product.options.forEach((name) => name.trim() && set.add(name.trim())));
    return Array.from(set);
  }, [selectedProducts]);

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
            { value: "short_description", label: "Short Description" },
            { value: "meta_title", label: "Meta Title" },
            { value: "meta_description", label: "Meta Description" },
            { value: "sku", label: "SKU" },
            ...dynamicAttributes.map((attr) => ({ value: `prod_attr_name_${toFieldKey(attr)}`, label: `${attr} (Attribute Name)` })),
          ],
    [discoveredAttributeFields, discoveredAttributeValueFields, dynamicAttributes, selectedContentType],
  );

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
  }, [translateFetcher.data, shopify]);

  useEffect(() => {
    if (!requestFetcher.data?.message) return;
    shopify.toast.show(requestFetcher.data.message, requestFetcher.data.ok ? undefined : { isError: true });
    if (requestFetcher.data.requests) setRequests(requestFetcher.data.requests);
  }, [requestFetcher.data, shopify]);

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
            className="lingotuner-panel-grid"
            style={{
              display: "grid",
              width: "100%",
              boxSizing: "border-box",
              gridTemplateColumns:
                selectedContentType === "attribute" || selectedContentType === "attribute_value"
                  ? "minmax(180px, 0.8fr) minmax(180px, 1fr) minmax(380px, 2.2fr)"
                  : "minmax(180px, 0.8fr) minmax(250px, 1.4fr) minmax(180px, 1fr) minmax(180px, 1fr)",
              gap: "var(--p-space-400, 16px)",
              alignItems: "start",
            }}
          >
            <div>
              <h4 style={{ margin: "0 0 10px" }}>Content Types to Translate</h4>
              <div style={{ display: "grid", gap: "8px" }}>
                <label>
                  <input
                    type="radio"
                    checked={selectedContentType === "product"}
                    onChange={() => setSelectedContentType("product")}
                  />{" "}
                  Products
                </label>
                <label>
                  <input
                    type="radio"
                    checked={selectedContentType === "category"}
                    onChange={() => setSelectedContentType("category")}
                  />{" "}
                  Categories
                </label>
                <label>
                  <input
                    type="radio"
                    checked={selectedContentType === "attribute"}
                    onChange={() => setSelectedContentType("attribute")}
                  />{" "}
                  Attribute Names
                </label>
                <label>
                  <input
                    type="radio"
                    checked={selectedContentType === "attribute_value"}
                    onChange={() => setSelectedContentType("attribute_value")}
                  />{" "}
                  Attribute Values
                </label>
              </div>
            </div>

            {selectedContentType !== "attribute" && selectedContentType !== "attribute_value" ? (
              <div>
                <h4 style={{ margin: "0 0 10px" }}>Select Items to Translate</h4>
                <input
                  type="text"
                  placeholder={selectedContentType === "category" ? "Search categories..." : "Search products..."}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  style={{ width: "100%", padding: "8px 0", marginBottom: "8px" }}
                />
                <div style={{ border: "1px solid #d9d9d9", maxHeight: "340px", overflowY: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "6px", width: "34px" }} />
                        <th style={{ textAlign: "left", padding: "6px" }}>
                          {selectedContentType === "category" ? "Category" : "Product"}
                        </th>
                        <th style={{ textAlign: "left", padding: "6px", width: "72px" }}>ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((row) => (
                        <tr key={row.id}>
                          <td style={{ padding: "6px" }}>
                            <input
                              type="checkbox"
                              checked={selectedItems.includes(row.id)}
                              onChange={() => toggleInList(row.id, selectedItems, setSelectedItems)}
                            />
                          </td>
                          <td style={{ padding: "6px" }}>{row.title}</td>
                          <td style={{ padding: "6px" }}>{row.numericId}</td>
                        </tr>
                      ))}
                      {!filteredItems.length ? (
                        <tr>
                          <td colSpan={3} style={{ padding: "6px" }}>
                            {selectedContentType === "category" ? "No categories found." : "No products found."}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div>
              <h4 style={{ margin: "0 0 10px" }}>Select Language</h4>
              {apiLanguages.length ? (
                <>
                  <select
                    multiple
                    value={selectedLanguages}
                    onChange={(event) =>
                      setSelectedLanguages(Array.from(event.currentTarget.selectedOptions).map((option) => option.value))
                    }
                    style={{ width: "100%", minHeight: "250px", padding: "6px" }}
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

            <div
              style={
                selectedContentType === "attribute" || selectedContentType === "attribute_value"
                  ? { gridColumn: "3 / span 1" }
                  : undefined
              }
            >
              <h4 style={{ margin: "0 0 10px" }}>Content fields to include</h4>
              <select
                multiple
                value={selectedFields}
                onChange={(event) =>
                  setSelectedFields(Array.from(event.currentTarget.selectedOptions).map((o) => o.value))
                }
                style={{ width: "100%", minHeight: "250px", padding: "6px" }}
              >
                {fieldOptions.map((field) => (
                  <option key={field.value} value={field.value}>
                    {field.label}
                  </option>
                ))}
              </select>
              <p style={{ marginTop: "8px", color: "#6b7280", fontSize: "13px" }}>
                {selectedContentType === "product"
                  ? "Select fields to send for translation. Product options appear when a single product is selected."
                  : selectedContentType === "attribute"
                    ? "Select attribute fields to send for translation."
                    : selectedContentType === "attribute_value"
                      ? "Select attribute value fields to send for translation."
                  : "Select fields to send for category translation."}
              </p>
            </div>
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
                        {completed && !requestRow.isTranslated ? (
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
                            Fetch content
                          </s-button>
                        ) : null}
                        {requestRow.isTranslated ? (
                          <s-button variant="secondary" disabled>
                            Applied
                          </s-button>
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
