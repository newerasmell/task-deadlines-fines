// English translations for Stores.tsx, StoreSettings.tsx, Settings.tsx and
// StoreForm.tsx. Bulgarian is the source language (see I18nContext.tsx);
// keys here are the exact Bulgarian strings wrapped in t() in those files.
export const storeConfig: Record<string, string> = {
  // Stores.tsx
  'Изтриване на групата „{name}“? Магазините в нея остават — просто стават без група.':
    'Delete group "{name}"? Its stores stay — they just become ungrouped.',
  "Магазини": "Stores",
  "+ Добави група": "+ Add group",
  "+ Добави магазин": "+ Add store",
  "магазин": "store",
  "магазина": "stores",
  "Преименувай": "Rename",
  "Изтрий": "Delete",
  "Без група": "Ungrouped",
  'Все още няма магазини — натиснете „+ Добави магазин“ по-горе.': 'No stores yet — click "+ Add store" above.',
  "В тази група все още няма магазини.": "No stores in this group yet.",
  '✓ Свързано с „{shopName}“': '✓ Connected to "{shopName}"',
  "✕ {error}": "✕ {error}",
  "Тестване…": "Testing…",
  "Тествай връзката": "Test connection",
  "Отвори →": "Open →",
  "Грешка": "Error",
  "Име на групата": "Group name",
  "напр. Парфюми HR, COD магазини": "e.g. Perfumes HR, COD stores",
  "Добавяне…": "Adding…",
  "Добави група": "Add group",
  "Отказ": "Cancel",
  "Запазване…": "Saving…",
  "Запази": "Save",

  // StoreSettings.tsx
  "✓ Синхронизирани {count} варианта ({method}){removed}": "✓ Synced {count} variants ({method}){removed}",
  " · премахнати {n} остарели": " · removed {n} stale",
  'Изтриване на магазин „{name}“? Това ще премахне и продуктите, източниците и историята му.':
    'Delete store "{name}"? This removes its products, sources, and history too.',
  "Зареждане…": "Loading…",
  "← Магазини": "← Stores",
  "Магазинът не е намерен — може да е бил изтрит.": "Store not found — it may have been deleted.",
  "Синхронизиране…": "Syncing…",
  "Синхронизирай сега": "Sync now",
  "Изтрий магазина": "Delete store",
  "Връзка и правило за ценообразуване": "Connection & pricing rule",
  "Източници": "Sources",
  "Импортирай себестойности": "Import costs",

  // Settings.tsx
  "Настройки": "Settings",
  "Заяви права на върховен администратор": "Claim ultimate admin",
  "Екип": "Team",
  "Моят акаунт": "My account",
  "Все още няма акаунт с права на върховен администратор тук (този акаунт е отпреди въвеждането на тази роля, или последният администратор е бил премахнат). Въведете еднократния ключ":
    "No account here is an ultimate admin yet (this one predates that role, or the last admin was removed). Enter this deploy's",
  "на тази инсталация, за да станете първият — същият еднократен ключ, използван при самата първоначална настройка при вход.":
    "to become the first one — same one-time key the very first login setup used.",
  "Парола за таблото": "Dashboard password",
  "от DASHBOARD_PASSWORD": "from DASHBOARD_PASSWORD",
  "Заявяване…": "Claiming…",
  "{email} — само върховен администратор може да вижда или променя акаунтите на останалите колеги.":
    "{email} — only an ultimate admin can see or change other teammates' accounts.",
  "Име": "Name",
  "Нова парола": "New password",
  "(оставете празно, за да запазите текущата)": "(leave blank to keep the current one)",
  "мин. 8 символа": "min. 8 characters",
  "Запазено.": "Saved.",
  "Запази промените": "Save changes",
  "Само върховни администратори могат да виждат или управляват този списък. Данните за магазините и цените са споделени от всички — това е само управление на акаунти, така че промените се приписват на конкретен човек (виж Одит лог), вместо на една обща парола.":
    "Only ultimate admins can see or manage this list. Store and pricing data is shared by everyone — this is just account management, so changes are attributed to a real person (see Audit log) instead of one shared password.",
  "Премахване на {name}? Записите му в одит лога се запазват.": "Remove {name}? Their past audit-log entries are kept.",
  "върховен администратор": "ultimate admin",
  "деактивиран": "deactivated",
  "вие": "you",
  "Деактивирай": "Deactivate",
  "Активирай": "Reactivate",
  "Все още няма колеги.": "No teammates yet.",
  "+ Добави колега": "+ Add teammate",
  "Паролата трябва да е поне 8 символа.": "Password must be at least 8 characters.",
  "Имейл": "Email",
  "Парола": "Password",
  "Помолете друг върховен администратор да промени вашия администраторски статус.":
    "Ask another ultimate admin to change your own admin status.",
  "Върховен администратор — може да вижда/управлява всички акаунти, не само своя":
    "Ultimate admin — can see/manage every account, not just their own",
  "Добави колега": "Add teammate",

  // StoreForm.tsx
  "Клиентската тайна е задължителна.": "Client secret is required.",
  "myshopify.com домейн": "myshopify.com domain",
  "Клиентски ID": "Client ID",
  "Клиентска тайна": "Client secret",
  "От страницата Dev Dashboard на приложението ви (dev.shopify.com) → Settings → Credentials. Изисква":
    "From your app's Dev Dashboard page (dev.shopify.com) → Settings → Credentials. Requires",
  "и": "and",
  "права, инсталирани в този магазин.": "scopes, installed to this store.",
  "Код на пазара": "Market code",
  "напр. PL, GR, BG": "e.g. PL, GR, BG",
  "Валута": "Currency",
  "напр. EUR": "e.g. EUR",
  "Група": "Group",
  "Ценови профил": "Pricing profile",
  "Проследяване на конкуренти (подбиване/изравняване)": "Competitor tracking (undercut/match)",
  "COD формула (базирана на себестойност + логистика + разходи за реклама)":
    "COD formula (cost + logistics + ad-spend based)",
  "Ценова стратегия": "Pricing strategy",
  "Подбий най-ниската": "Undercut lowest",
  "Изравни с най-ниската": "Match lowest",
  "Подбий средната": "Undercut average",
  "Процент подбиване": "Undercut %",
  "Завършек на цената (незадължително)": "Price ending (optional)",
  "Мин. марж % (долна граница)": "Min margin % (floor guard)",
  "Самата формула (микс от разходи, сценарии за доставка, агентска такса) се конфигурира на страница Ценообразуване, след като магазинът бъде запазен.":
    "The formula itself (cost mix, delivery scenarios, agency fee) is configured on the Pricing page once this store is saved.",
  'Активирай раздел „Продажби“ (продадени бройки за 6 месеца / средна продажна цена / обобщение по категория)':
    'Enable "Sales" tab (6-month units sold / avg sale price / category rollup)',
  "Изисква права": "Requires",
  "предоставени на Shopify приложението на този магазин — добавете ги в dev.shopify.com → your app → Configuration, след което преинсталирайте в магазина.":
    "scope granted to this store's Shopify app — add it under dev.shopify.com → your app → Configuration, then reinstall to the store.",
  "GA4 property (незадължително, за прегледи на страници/конверсия)":
    "GA4 property (optional, for page views/conversion rate)",
  "Добави магазин": "Add store",
};
