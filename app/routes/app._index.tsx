import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  parseLocaleMappings,
  serializeLocaleMappings,
  type LocaleMappings,
} from "../lib/locale-mappings";
import { insertTranslationLog, resolveTranslationEngine } from "../lib/translation-log.server";

type LanguageOption = {
  code: string;
  name: string;
};

type StoreLocaleRow = {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
};

type ActionData = {
  ok: boolean;
  intent: "save-settings" | "fetch-languages" | "save-locale-mappings";
  message?: string;
  error?: string;
  settings?: {
    apiBaseUrl: string;
    translationEngine: string;
    enabled: boolean;
    hasApiKey: boolean;
    maskedApiKey: string;
    cachedLanguages: LanguageOption[];
    localeMappings: LocaleMappings;
  };
  languages?: LanguageOption[];
  localeMappings?: LocaleMappings;
};

function maskApiKey(key: string) {
  if (!key) return "";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
}

function normalizeBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function toShopifyLanguagesUrl(baseUrl: string, engine?: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  const url = new URL("languages", withSlash);
  if (engine) {
    url.searchParams.set("engine", engine);
    url.searchParams.set("provider", engine);
    url.searchParams.set("translationEngine", engine);
    url.searchParams.set("engineProvider", engine);
  }
  return url.toString();
}

function parseLanguages(payload: unknown): LanguageOption[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
        if (typeof item === "string") {
          return { code: item, name: item };
        }
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const code = String(obj.code ?? obj.languageCode ?? obj.value ?? "");
          const name = String(obj.name ?? obj.languageName ?? obj.label ?? code);
          if (!code) return null;
          return { code, name };
        }
        return null;
      })
      .filter((item): item is LanguageOption => Boolean(item));
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.languages)) return parseLanguages(obj.languages);
    if (Array.isArray(obj.data)) return parseLanguages(obj.data);
    if (Array.isArray(obj.items)) return parseLanguages(obj.items);
  }

  return [];
}

type TranslatorSettingsRow = {
  apiKey: string;
  apiBaseUrl: string;
  translationEngine: string;
  fetchedLanguages: string | null;
  localeMappings: string | null;
  enabled: boolean;
};

async function getSettingsByShop(shop: string): Promise<TranslatorSettingsRow | null> {
  const row = await prisma.translatorSettings.findUnique({
    where: { shop },
    select: {
      apiKey: true,
      apiBaseUrl: true,
      translationEngine: true,
      fetchedLanguages: true,
      localeMappings: true,
      enabled: true,
    },
  });
  return row ?? null;
}

async function saveLocaleMappingsByShop(shop: string, mappings: LocaleMappings) {
  await prisma.translatorSettings.updateMany({
    where: { shop },
    data: {
      localeMappings: serializeLocaleMappings(mappings),
    },
  });
}

function parseLocaleMappingsFromForm(formData: FormData): LocaleMappings {
  const mappings: LocaleMappings = {};
  for (const [key, value] of formData.entries()) {
    if (!String(key).startsWith("localeMap[")) continue;
    const match = String(key).match(/^localeMap\[(.+)\]$/);
    if (!match?.[1]) continue;
    const shopifyLocale = match[1].trim();
    const apiCode = String(value ?? "").trim();
    if (shopifyLocale && apiCode) mappings[shopifyLocale] = apiCode;
  }
  return mappings;
}

async function upsertSettingsByShop(input: {
  shop: string;
  apiKey: string;
  apiBaseUrl: string;
  translationEngine: string;
  enabled: boolean;
}) {
  await prisma.translatorSettings.upsert({
    where: { shop: input.shop },
    update: {
      apiKey: input.apiKey,
      apiBaseUrl: input.apiBaseUrl,
      translationEngine: input.translationEngine,
      enabled: input.enabled,
    },
    create: {
      shop: input.shop,
      apiKey: input.apiKey,
      apiBaseUrl: input.apiBaseUrl,
      translationEngine: input.translationEngine,
      enabled: input.enabled,
    },
  });
}

async function saveFetchedLanguagesByShop(shop: string, languages: LanguageOption[]) {
  await prisma.translatorSettings.updateMany({
    where: { shop },
    data: {
      fetchedLanguages: JSON.stringify(languages),
    },
  });
}

function parseCachedLanguages(payload: string | null | undefined): LanguageOption[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as LanguageOption[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.code === "string" && typeof item.name === "string",
    );
  } catch {
    return [];
  }
}

async function fetchShopifyApiData(input: {
  apiBaseUrl: string;
  apiKey: string;
  engine?: string;
}) {
  const endpoint = toShopifyLanguagesUrl(input.apiBaseUrl, input.engine);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "api-key": input.apiKey,
      Authorization: `Bearer ${input.apiKey}`,
    },
  });
  const body = (await response.json()) as unknown;
  return { response, body };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettingsByShop(session.shop);
  const cachedLanguages = parseCachedLanguages(settings?.fetchedLanguages);
  const localeMappings = parseLocaleMappings(settings?.localeMappings);

  let storeLocales: StoreLocaleRow[] = [];
  let localeAccessLimited = false;
  try {
    const localesResponse = await admin.graphql(
      `#graphql
      query SettingsShopLocales {
        shopLocales {
          locale
          name
          primary
          published
        }
      }`,
    );
    const localesJson = (await localesResponse.json()) as {
      data?: { shopLocales?: StoreLocaleRow[] };
    };
    storeLocales = localesJson.data?.shopLocales ?? [];
  } catch {
    localeAccessLimited = true;
  }

  return {
    settings: {
      apiBaseUrl: settings?.apiBaseUrl ?? "",
      translationEngine: resolveTranslationEngine(settings?.translationEngine),
      enabled: settings?.enabled ?? true,
      hasApiKey: Boolean(settings?.apiKey),
      maskedApiKey: settings?.apiKey ? maskApiKey(settings.apiKey) : "",
      cachedLanguages,
      localeMappings,
    },
    storeLocales,
    localeAccessLimited,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save-settings") {
    const apiKeyInput = String(formData.get("apiKey") ?? "").trim();
    const apiBaseUrl = normalizeBaseUrl(String(formData.get("apiBaseUrl") ?? ""));
    const enabled = String(formData.get("enabled") ?? "on") === "on";

    const existing = await getSettingsByShop(session.shop);
    const apiKey = apiKeyInput || existing?.apiKey || "";
    const translationEngine = resolveTranslationEngine(
      String(formData.get("translationEngine") ?? "") || existing?.translationEngine,
    );

    if (!apiKey || !apiBaseUrl) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "configuration",
        action: "save_settings",
        message: "API key and API base URL are required.",
      });
      return {
        ok: false,
        intent: "save-settings",
        error: "API key and API base URL are required.",
      } satisfies ActionData;
    }

    await upsertSettingsByShop({
      shop: session.shop,
      apiKey,
      apiBaseUrl,
      translationEngine,
      enabled,
    });
    const localeMappings = parseLocaleMappingsFromForm(formData);
    if (Object.keys(localeMappings).length || formData.has("localeMappingsPresent")) {
      await saveLocaleMappingsByShop(session.shop, localeMappings);
    }
    await insertTranslationLog({
      shop: session.shop,
      level: "success",
      contentType: "configuration",
      action: "save_settings",
      message: "Translator settings saved.",
      metadata: { translationEngine, enabled, apiBaseUrl, localeMappings },
    });

    return {
      ok: true,
      intent: "save-settings",
      message: "Translator settings saved.",
      settings: {
        apiBaseUrl,
        translationEngine,
        enabled,
        hasApiKey: true,
        maskedApiKey: maskApiKey(apiKey),
        cachedLanguages: parseCachedLanguages(existing?.fetchedLanguages),
        localeMappings,
      },
      localeMappings,
    } satisfies ActionData;
  }

  if (intent === "save-locale-mappings") {
    const existing = await getSettingsByShop(session.shop);
    if (!existing) {
      return {
        ok: false,
        intent: "save-locale-mappings",
        error: "Save API settings first, then configure locale mappings.",
      } satisfies ActionData;
    }

    const localeMappings = parseLocaleMappingsFromForm(formData);
    await saveLocaleMappingsByShop(session.shop, localeMappings);
    await insertTranslationLog({
      shop: session.shop,
      level: "success",
      contentType: "configuration",
      action: "save_locale_mappings",
      message: `Saved ${Object.keys(localeMappings).length} locale mapping(s).`,
      metadata: { localeMappings },
    });

    return {
      ok: true,
      intent: "save-locale-mappings",
      message: "Shopify store locale mappings saved.",
      localeMappings,
      settings: {
        apiBaseUrl: existing.apiBaseUrl,
        translationEngine: resolveTranslationEngine(existing.translationEngine),
        enabled: existing.enabled,
        hasApiKey: Boolean(existing.apiKey),
        maskedApiKey: existing.apiKey ? maskApiKey(existing.apiKey) : "",
        cachedLanguages: parseCachedLanguages(existing.fetchedLanguages),
        localeMappings,
      },
    } satisfies ActionData;
  }

  if (intent === "fetch-languages") {
    const settings = await getSettingsByShop(session.shop);
    const apiKeyInput = String(formData.get("apiKey") ?? "").trim();
    const apiBaseUrlInput = normalizeBaseUrl(String(formData.get("apiBaseUrl") ?? ""));
    const apiKey = apiKeyInput || settings?.apiKey || "";
    const apiBaseUrl = apiBaseUrlInput || settings?.apiBaseUrl || "";
    const selectedEngine = resolveTranslationEngine(
      String(formData.get("translationEngine") ?? "") || settings?.translationEngine,
    );

    if (!apiKey || !apiBaseUrl) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "configuration",
        action: "fetch_languages",
        message: "Provide API key and base URL (or save settings first).",
      });
      return {
        ok: false,
        intent: "fetch-languages",
        error: "Provide API key and base URL (or save settings first).",
      } satisfies ActionData;
    }

    try {
      const { response, body } = await fetchShopifyApiData({
        apiBaseUrl,
        apiKey,
        engine: selectedEngine || undefined,
      });
      const languages = parseLanguages(body);

      if (!response.ok) {
        await insertTranslationLog({
          shop: session.shop,
          level: "error",
          contentType: "configuration",
          action: "fetch_languages",
          message: `Language API failed with status ${response.status}.`,
          statusCode: response.status,
          requestBody: JSON.stringify({ engine: selectedEngine || null }),
          responseBody: JSON.stringify(body),
        });
        return {
          ok: false,
          intent: "fetch-languages",
          error: `Language API failed with status ${response.status}.`,
        } satisfies ActionData;
      }

      if (!languages.length) {
        await insertTranslationLog({
          shop: session.shop,
          level: "error",
          contentType: "configuration",
          action: "fetch_languages",
          message: "Languages fetched but no language list was found in response.",
          statusCode: response.status,
          requestBody: JSON.stringify({ engine: selectedEngine || null }),
          responseBody: JSON.stringify(body),
        });
        return {
          ok: false,
          intent: "fetch-languages",
          error: "Languages fetched but no language list was found in response.",
        } satisfies ActionData;
      }

      await saveFetchedLanguagesByShop(session.shop, languages);
      await insertTranslationLog({
        shop: session.shop,
        level: "success",
        contentType: "configuration",
        action: "fetch_languages",
        message: `Fetched ${languages.length} languages.`,
        statusCode: response.status,
        requestBody: JSON.stringify({ engine: selectedEngine || null }),
        responseBody: JSON.stringify(body),
      });

      return {
        ok: true,
        intent: "fetch-languages",
        message: `Fetched ${languages.length} languages.`,
        languages,
      } satisfies ActionData;
    } catch (error) {
      await insertTranslationLog({
        shop: session.shop,
        level: "error",
        contentType: "configuration",
        action: "fetch_languages",
        message: "Could not reach translation API. Please verify URL and API key.",
        metadata: { error: String(error) },
      });
      return {
        ok: false,
        intent: "fetch-languages",
        error: "Could not reach translation API. Please verify URL and API key.",
      } satisfies ActionData;
    }
  }

  return {
    ok: false,
    intent: "save-settings",
    error: "Unknown action.",
  } satisfies ActionData;
};

export default function Index() {
  const { settings, storeLocales, localeAccessLimited } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [languages, setLanguages] = useState<LanguageOption[]>(settings.cachedLanguages ?? []);
  const [localeMappings, setLocaleMappings] = useState<LocaleMappings>(settings.localeMappings ?? {});
  const formRef = useRef<HTMLFormElement | null>(null);

  const shopify = useAppBridge();
  const isSubmitting = ["loading", "submitting"].includes(fetcher.state);

  const fetchedLanguages = useMemo(() => languages, [languages]);

  useEffect(() => {
    setLanguages(settings.cachedLanguages ?? []);
  }, [settings.cachedLanguages]);

  useEffect(() => {
    setLocaleMappings(settings.localeMappings ?? {});
  }, [settings.localeMappings]);

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
    if (fetcher.data?.intent === "fetch-languages" && fetcher.data?.languages) {
      setLanguages(fetcher.data.languages);
    }
    if (fetcher.data?.localeMappings) {
      setLocaleMappings(fetcher.data.localeMappings);
    }
  }, [
    fetcher.data?.error,
    fetcher.data?.intent,
    fetcher.data?.languages,
    fetcher.data?.localeMappings,
    fetcher.data?.message,
    shopify,
  ]);

  const submitWithIntent = (intent: "save-settings" | "fetch-languages" | "save-locale-mappings") => {
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    formData.set("intent", intent);
    fetcher.submit(formData, { method: "POST" });
  };

  const setMappingForLocale = (shopifyLocale: string, apiCode: string) => {
    setLocaleMappings((prev) => {
      const next = { ...prev };
      if (!apiCode) {
        delete next[shopifyLocale];
      } else {
        next[shopifyLocale] = apiCode;
      }
      return next;
    });
  };

  return (
    <s-page heading="Lingotuner Translator Settings" inlineSize="large">
      <fetcher.Form method="POST" ref={formRef}>
        <input type="hidden" name="localeMappingsPresent" value="1" />
        {Object.entries(localeMappings).map(([shopifyLocale, apiCode]) => (
          <input
            key={`map-hidden-${shopifyLocale}`}
            type="hidden"
            name={`localeMap[${shopifyLocale}]`}
            value={apiCode}
          />
        ))}

        <div style={{ marginBottom: "16px" }}>
          <s-section heading="API Setup">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="API Key"
                name="apiKey"
                placeholder={settings?.maskedApiKey || "Enter API key"}
                required={!settings?.hasApiKey}
              />
              <s-text-field
                label="API Base URL"
                name="apiBaseUrl"
                defaultValue={settings?.apiBaseUrl}
                required
              />
              <input
                type="hidden"
                name="translationEngine"
                value={settings.translationEngine}
              />
              <s-button
                onClick={() => submitWithIntent("fetch-languages")}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Fetch languages
              </s-button>
              <s-checkbox
                label="Translator enabled"
                name="enabled"
                checked={settings?.enabled ?? true}
              />
              <s-button
                onClick={() => submitWithIntent("save-settings")}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Save settings
              </s-button>
            </s-stack>
          </s-section>
        </div>

        <div style={{ marginBottom: "16px" }}>
          <s-section heading="Shopify Store Locale Mapping">
          <s-stack direction="block" gap="small">
            <s-paragraph>
              Map each Shopify store language to an API language once. Home page uses this mapping
              automatically.
            </s-paragraph>

            {localeAccessLimited ? (
              <s-paragraph>
                Store locales scope is missing. Add <s-text>read_locales</s-text> scope and reinstall
                the app.
              </s-paragraph>
            ) : null}

            {!localeAccessLimited && !storeLocales.length ? (
              <s-paragraph>
                No store languages found. Add languages in Shopify settings first.
              </s-paragraph>
            ) : null}

            {!localeAccessLimited && storeLocales.length && !fetchedLanguages.length ? (
              <s-paragraph>Fetch API languages first, then set mappings below.</s-paragraph>
            ) : null}

            {!localeAccessLimited && storeLocales.length && fetchedLanguages.length ? (
              <div style={{ overflowX: "auto", maxWidth: "860px" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    minWidth: "480px",
                    tableLayout: "fixed",
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "6px 8px",
                          borderBottom: "1px solid #e5e7eb",
                          width: "45%",
                        }}
                      >
                        Shopify Store
                      </th>
                      <th
                        style={{
                          textAlign: "left",
                          padding: "6px 8px",
                          borderBottom: "1px solid #e5e7eb",
                          width: "55%",
                        }}
                      >
                        Mapped API Language
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {storeLocales.map((locale) => (
                      <tr key={locale.locale}>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" }}>
                          {locale.name} ({locale.locale})
                          {locale.primary ? " — Default" : ""}
                          {locale.published ? "" : " — Unpublished"}
                        </td>
                        <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" }}>
                          <select
                            value={localeMappings[locale.locale] ?? ""}
                            onChange={(event) => setMappingForLocale(locale.locale, event.target.value)}
                            style={{
                              width: "100%",
                              minHeight: "34px",
                              padding: "4px 8px",
                              boxSizing: "border-box",
                            }}
                          >
                            <option value="">Not mapped</option>
                            {fetchedLanguages.map((language) => (
                              <option key={`${locale.locale}-${language.code}`} value={language.code}>
                                {language.name} ({language.code})
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: "10px" }}>
                  <s-button
                    onClick={() => submitWithIntent("save-locale-mappings")}
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Save locale mappings
                  </s-button>
                </div>
              </div>
            ) : null}
          </s-stack>
          </s-section>
        </div>

        <s-section heading="Supported Languages">
          <s-stack direction="block" gap="small">
            <s-paragraph>
              Save settings first, then click <s-text>Fetch languages</s-text>.
            </s-paragraph>
            {fetchedLanguages.length > 0 ? (
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <ul
                  style={{
                    columnCount: 2,
                    columnGap: "24px",
                    margin: 0,
                    paddingLeft: "20px",
                  }}
                >
                  {fetchedLanguages.map((language) => (
                    <li key={language.code} style={{ breakInside: "avoid", marginBottom: "4px" }}>
                      {language.name} ({language.code})
                    </li>
                  ))}
                </ul>
              </s-box>
            ) : (
              <s-paragraph>No languages loaded yet.</s-paragraph>
            )}
          </s-stack>
        </s-section>
      </fetcher.Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
