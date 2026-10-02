import prisma from "../db.server";
import {
  normalizeAppliedFieldKey,
  parseAppliedByLocale,
  serializeAppliedByLocale,
  type AppliedByLocale,
  type ItemTranslationStateRow,
} from "./translation-progress";

export async function getItemTranslationStatesByShop(
  shop: string,
  contentType?: string,
): Promise<ItemTranslationStateRow[]> {
  const rows = await prisma.itemTranslationState.findMany({
    where: {
      shop,
      ...(contentType ? { contentType } : {}),
    },
    select: {
      contentType: true,
      itemId: true,
      appliedByLocale: true,
    },
  });
  return rows.map((row) => ({
    contentType: row.contentType,
    itemId: row.itemId,
    appliedByLocale: parseAppliedByLocale(row.appliedByLocale),
  }));
}

/**
 * Merge newly applied field keys for an item + store locale.
 * Keys are normalized (body_html → description, etc.).
 */
export async function mergeItemAppliedFields(args: {
  shop: string;
  contentType: string;
  itemId: string;
  storeLocale: string;
  fields: string[];
}): Promise<ItemTranslationStateRow | null> {
  const itemId = String(args.itemId ?? "").trim();
  const contentType = String(args.contentType ?? "").trim().toLowerCase();
  const storeLocale = String(args.storeLocale ?? "").trim().toLowerCase();
  const fields = [
    ...new Set(args.fields.map(normalizeAppliedFieldKey).filter(Boolean)),
  ];
  if (!itemId || !contentType || !storeLocale || !fields.length) return null;

  const existing = await prisma.itemTranslationState.findUnique({
    where: {
      shop_contentType_itemId: {
        shop: args.shop,
        contentType,
        itemId,
      },
    },
    select: { appliedByLocale: true },
  });

  const map: AppliedByLocale = parseAppliedByLocale(existing?.appliedByLocale);
  const prev = new Set(map[storeLocale] ?? []);
  fields.forEach((field) => prev.add(field));
  map[storeLocale] = [...prev];

  const row = await prisma.itemTranslationState.upsert({
    where: {
      shop_contentType_itemId: {
        shop: args.shop,
        contentType,
        itemId,
      },
    },
    create: {
      shop: args.shop,
      contentType,
      itemId,
      appliedByLocale: serializeAppliedByLocale(map),
    },
    update: {
      appliedByLocale: serializeAppliedByLocale(map),
    },
    select: {
      contentType: true,
      itemId: true,
      appliedByLocale: true,
    },
  });

  return {
    contentType: row.contentType,
    itemId: row.itemId,
    appliedByLocale: parseAppliedByLocale(row.appliedByLocale),
  };
}