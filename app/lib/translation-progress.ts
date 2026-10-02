/** Shared translation completeness helpers (Lingotuner / Magento-style). */

export type ProgressContentType = "product" | "category" | "attribute" | "attribute_value";

export type AppliedByLocale = Record<string, string[]>;

export type ItemTranslationStateRow = {
  contentType: string;
  itemId: string;
  appliedByLocale: AppliedByLocale;
};

export type TranslationStatus = "translated" | "partial" | "not";

export type ItemCompleteness = {
  status: TranslationStatus;
  requiredFields: string[];
  appliedFields: string[];
  missingFields: string[];
  /** True when item was applied historically without field-level keys. */
  isLegacyPartial: boolean;
};

export type TranslationProgressStats = {
  total: number;
  translated: number;
  partial: number;
  notTranslated: number;
};

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  name: "Name",
  description: "Description",
  // short_description: "Short Description",
  meta_title: "Meta Title",
  meta_description: "Meta Description",
  body_html: "Description",
};

export function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  if (key.startsWith("mf__")) return key.replace(/^mf__/, "Metafield ");
  if (key.startsWith("prod_attr_name_")) return key.replace("prod_attr_name_", "Attribute ");
  if (key.startsWith("prod_attr_value_")) return key.replace("prod_attr_value_", "Option value ");
  return key;
}

export function parseAppliedByLocale(payload: string | null | undefined): AppliedByLocale {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AppliedByLocale = {};
    for (const [locale, fields] of Object.entries(parsed as Record<string, unknown>)) {
      const code = String(locale ?? "").trim().toLowerCase();
      if (!code) continue;
      const list = Array.isArray(fields)
        ? fields.map((f) => String(f).trim()).filter(Boolean)
        : [];
      out[code] = [...new Set(list)];
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeAppliedByLocale(map: AppliedByLocale): string {
  const clean: AppliedByLocale = {};
  for (const [locale, fields] of Object.entries(map)) {
    const code = String(locale ?? "").trim().toLowerCase();
    if (!code) continue;
    clean[code] = [...new Set((fields ?? []).map((f) => String(f).trim()).filter(Boolean))];
  }
  return JSON.stringify(clean);
}

/** Normalize Shopify/API apply keys into stable progress keys. */
export function normalizeAppliedFieldKey(raw: string): string {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key) return "";
  if (key === "body_html" || key === "descriptionhtml") return "description";
  if (key === "title" || key === "name") return key === "name" ? "name" : "title";
  if (key === "seo_title") return "meta_title";
  if (key === "seo_description") return "meta_description";
  return key;
}

export function requiredProductFields(source: {
  title?: string | null;
  description?: string | null;
  descriptionHtml?: string | null;
}): string[] {
  const required: string[] = [];
  if (String(source.title ?? "").trim()) required.push("title");
  const description = String(source.descriptionHtml ?? source.description ?? "").trim();
  // Strip empty HTML shells
  const textOnly = description.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  if (textOnly) required.push("description");
  // short_description is selectable in UI but not applied by Shopify path — skip
  return required;
}

export function requiredCategoryFields(source: {
  title?: string | null;
  description?: string | null;
}): string[] {
  const required: string[] = [];
  if (String(source.title ?? "").trim()) required.push("title");
  const description = String(source.description ?? "").trim();
  const textOnly = description.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  if (textOnly) required.push("description");
  return required;
}

export function requiredAttributeFields(): string[] {
  return ["name"];
}

export function requiredOptionValueFields(): string[] {
  return ["name"];
}

function fieldsForLocale(applied: AppliedByLocale, locale: string | "all"): string[] {
  if (locale === "all" || !locale) {
    const union = new Set<string>();
    for (const list of Object.values(applied)) {
      list.forEach((f) => union.add(f));
    }
    return [...union];
  }
  return applied[locale.toLowerCase()] ?? [];
}

function hasAnyApplied(applied: AppliedByLocale, locale: string | "all"): boolean {
  if (locale === "all" || !locale) {
    return Object.values(applied).some((list) => list.length > 0);
  }
  return (applied[locale.toLowerCase()] ?? []).length > 0;
}

function localesWithAnyFields(applied: AppliedByLocale): string[] {
  return Object.entries(applied)
    .filter(([, fields]) => fields.length > 0)
    .map(([locale]) => locale);
}

/**
 * Completeness for one item.
 * - storeLocale "all": Translated only if every targetLocale is fully translated;
 *   Partial if any locale has progress but not all are complete; else Not.
 * - specific store: compare required vs applied for that language only.
 * - legacy: applied flag without field keys → Partial.
 */
export function computeItemCompleteness(args: {
  requiredFields: string[];
  appliedByLocale: AppliedByLocale;
  storeLocale: string | "all";
  targetLocales: string[];
  legacyLocales?: string[];
}): ItemCompleteness {
  const required = [...new Set(args.requiredFields.map(normalizeAppliedFieldKey).filter(Boolean))];
  const legacySet = new Set(
    (args.legacyLocales ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean),
  );
  const targets = [
    ...new Set(args.targetLocales.map((l) => l.trim().toLowerCase()).filter(Boolean)),
  ];

  const emptyResult = (status: TranslationStatus, applied: string[], missing: string[], legacy: boolean): ItemCompleteness => ({
    status,
    requiredFields: required,
    appliedFields: applied,
    missingFields: missing,
    isLegacyPartial: legacy,
  });

  if (!required.length) {
    return emptyResult("translated", [], [], false);
  }

  const evaluateLocale = (locale: string): ItemCompleteness => {
    const appliedRaw = args.appliedByLocale[locale] ?? [];
    const applied = [...new Set(appliedRaw.map(normalizeAppliedFieldKey).filter(Boolean))];
    const missing = required.filter((f) => !applied.includes(f));
    const isLegacy =
      applied.length === 0 && (legacySet.has(locale) || (legacySet.has("__any__") && !locale));

    if (isLegacy) {
      return emptyResult("partial", [], required, true);
    }
    if (!applied.length) {
      return emptyResult("not", [], required, false);
    }
    if (missing.length === 0) {
      return emptyResult("translated", applied, [], false);
    }
    return emptyResult("partial", applied, missing, false);
  };

  if (args.storeLocale !== "all" && args.storeLocale) {
    return evaluateLocale(args.storeLocale.toLowerCase());
  }

  // All stores: union display fields + aggregate status across target locales
  const localeList = targets.length ? targets : localesWithAnyFields(args.appliedByLocale);
  if (!localeList.length) {
    if (legacySet.size) {
      return emptyResult("partial", [], required, true);
    }
    return emptyResult("not", [], required, false);
  }

  const perLocale = localeList.map(evaluateLocale);
  const appliedUnion = fieldsForLocale(args.appliedByLocale, "all");
  const anyLegacy = perLocale.some((row) => row.isLegacyPartial);
  const allTranslated = perLocale.every((row) => row.status === "translated");
  const anyProgress = perLocale.some(
    (row) => row.status === "translated" || row.status === "partial",
  );

  if (allTranslated) {
    return emptyResult("translated", appliedUnion, [], false);
  }
  if (anyProgress || anyLegacy) {
    const missingUnion = [...new Set(perLocale.flatMap((row) => row.missingFields))];
    return emptyResult("partial", appliedUnion, missingUnion, anyLegacy && appliedUnion.length === 0);
  }
  return emptyResult("not", [], required, false);
}

export function computeProgressStats(
  items: ItemCompleteness[],
): TranslationProgressStats {
  const total = items.length;
  let translated = 0;
  let partial = 0;
  let notTranslated = 0;
  for (const item of items) {
    if (item.status === "translated") translated += 1;
    else if (item.status === "partial") partial += 1;
    else notTranslated += 1;
  }
  return { total, translated, partial, notTranslated };
}

export function progressPercent(count: number, total: number) {
  if (!total) return 0;
  return Math.round((count / total) * 100);
}

export function statusBadgeLabel(status: TranslationStatus): string {
  if (status === "translated") return "Translated";
  if (status === "partial") return "Partial";
  return "Not translated";
}

export function statusBadgeColors(status: TranslationStatus): {
  background: string;
  color: string;
  bar: string;
} {
  if (status === "translated") {
    return { background: "#dcfce7", color: "#15803d", bar: "#22c55e" };
  }
  if (status === "partial") {
    return { background: "#ffedd5", color: "#c2410c", bar: "#f59e0b" };
  }
  return { background: "#e0f2fe", color: "#0369a1", bar: "#38bdf8" };
}

export function statusTooltip(completeness: ItemCompleteness): string {
  if (completeness.isLegacyPartial) {
    return "Previously applied without field-level tracking. Re-fetch / re-apply to refresh field status.";
  }
  if (completeness.status === "translated") {
    const fields = completeness.appliedFields.map(fieldLabel).join(", ") || "—";
    return `Translated fields: ${fields}`;
  }
  if (completeness.status === "partial") {
    const missing = completeness.missingFields.map(fieldLabel).join(", ") || "—";
    return `Not translated yet: ${missing}`;
  }
  const pending = completeness.requiredFields.map(fieldLabel).join(", ") || "—";
  return `Pending fields: ${pending}`;
}

export function matchesStatusFilter(
  status: TranslationStatus,
  filter: "all" | "not" | "partial" | "translated",
): boolean {
  if (filter === "all") return true;
  if (filter === "not") return status === "not";
  if (filter === "partial") return status === "partial";
  return status === "translated";
}

export function hasAnyAppliedForLocale(
  applied: AppliedByLocale,
  locale: string | "all",
): boolean {
  return hasAnyApplied(applied, locale);
}
