// English translations for TransferPrices.tsx. Spread into src/i18n/en.ts.
export const transferPrices: Record<string, string> = {
  "Прехвърляне на цени": "Transfer prices",
  "Прехвърляне на цени между магазини": "Transfer prices between stores",
  "Избери магазин с оправени цени (source) и магазин, в който да ги приложиш (target) — продуктите се съпоставят по SKU (при липса — по баркод), а новата цена се пресмята автоматично във валутата на target магазина.":
    "Pick a store with fixed-up prices (source) and a store to apply them to (target) — products are matched by SKU (barcode as a fallback), and the new price is automatically computed in the target store's currency.",
  "От магазин (source)": "From store (source)",
  "Към магазин (target)": "To store (target)",
  "— избери —": "— choose —",
  "Само с разлика в цената": "Only where the price differs",
  "Не успях да намеря валутен курс {from} → {to} в момента — опитай отново след малко.":
    "Couldn't fetch the {from} → {to} exchange rate right now — try again shortly.",
  "Цените се конвертират от {from} в {to}.": "Prices are converted from {from} to {to}.",
  "{matched} съвпадения ({changed} с различна цена).": "{matched} matches ({changed} with a different price).",
  "{count} продукта от source нямат съвпадение по SKU/баркод в target и не могат да се пренесат.":
    "{count} product(s) from the source store have no SKU/barcode match in the target store and can't be transferred.",
  'Приложи {count} нови цени в "{store}"? Ще се публикуват направо в Shopify.':
    'Apply {count} new price(s) to "{store}"? They\'ll be published straight to Shopify.',
  "Приложи и публикувай ({count})": "Apply and publish ({count})",
  "Съвпадение по SKU": "Matched by SKU",
  "Съвпадение по баркод": "Matched by barcode",
  "баркод": "barcode",
  "Текуща цена (target)": "Current price (target)",
  "Цена в source": "Source price",
  "Нова цена (target)": "New price (target)",
  "Публикувано": "Published",
  "Няма продукти с различна цена.": "No products with a different price.",
  "Няма съвпадения.": "No matches.",
};
