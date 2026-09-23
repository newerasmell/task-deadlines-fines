// English translations for strings used in SourcesSection.tsx, Accordion.tsx
// and CostsImport.tsx. Spread into src/i18n/en.ts.
export const sources: Record<string, string> = {
  // CostsImport.tsx
  "CSV с две колони: SKU или EAN, след което цена (заглавен ред не е задължителен). Използва се за защитата на минималния марж — за продукти без въведена себестойност се прилага процент от текущата цена.":
    "CSV with two columns: SKU or EAN, then cost (a header row is optional). Used for the margin floor guard — products without a cost on file fall back to a percentage of the current price instead.",
  "Импортирани {count} реда.": "Imported {count} rows.",
  "{count} ред(а) пропуснати: {errors}": "{count} row(s) skipped: {errors}",

  // SourcesSection.tsx — tabs
  "Редактиране": "Edit",
  "Импортиране": "Import",
  "Резултати": "Results",
  "Опашка за преглед": "Review queue",

  // SourcesSection.tsx — refresh status
  "Стартирано — извличането от източници може да отнеме няколко минути…": "Started — scrape sources can take several minutes…",
  "Грешка": "Error",
  "Вече се обновява — проверете отново скоро.": "Already refreshing — check back shortly.",
  "✓ {count} извлечени цени": "✓ {count} prices fetched",
  "Все още работи — проверете по-късно.": "Still running — check back later.",
  "Изтриване на този източник? Събраните цени на конкуренти ще бъдат изтрити заедно с него.":
    "Delete this source? Its collected competitor prices go with it.",

  // SourcesSection.tsx — source list
  "влошено": "degraded",
  "неактивно": "inactive",
  "само ръчно": "manual only",
  "Обновяване…": "Refreshing…",
  "Обнови сега": "Refresh now",
  "Изтрий": "Delete",
  "Последно обновено": "Last refreshed",
  "никога": "never",
  "от": "by",
  "цени": "prices",
  "Все още няма източници.": "No sources yet.",
  "+ Добави източник": "+ Add source",
  "Максимум {max} източника на магазин.": "Maximum of {max} sources per store.",

  // ManualImportPanel
  "1. Изтеглете шаблона за проучване (всеки продукт, плюс предложен URL за търсене). 2. Търсете {baseUrl} за всеки продукт и попълнете":
    "1. Download the research template (every product, plus a suggested search URL). 2. Search {baseUrl} for each one and fill in",
  " (или отбележете": " (or mark",
  ") в същия файл. 3. Качете го обратно тук — редовете се съпоставят по": ") on the same file. 3. Upload it back here — rows are matched by",
  ", така че нищо тук не разчита заглавията да съвпадат точно.": ", so nothing here relies on titles lining up exactly.",
  "Подготовка…": "Preparing…",
  "Изтегли шаблон": "Download template",
  "Импортирани {matched} цена/и, {notFound} отбелязани като ненамерени.": "Imported {matched} price(s), {notFound} marked not-found.",
  "Ако при проучването сте открили кандидати, в които не сте сигурни, качете отделния файл за преглед (напр.":
    "If your research turned up candidates you weren't sure about, upload that separate review file (e.g.",
  ') тук — те ще се появят в раздел "Опашка за преглед" вместо да се налага да бъдат разрешавани ръчно в таблицата.':
    ' here — they\'ll show up under the "Review queue" tab instead of needing to be resolved by hand in the spreadsheet.',
  "{count} продукт(и) добавени в опашката за преглед.": "{count} product(s) added to the review queue.",

  // ScrapeAttemptsPanel
  "Зареждане…": "Loading…",
  'Все още няма импортирани резултати — превключете към раздел "Импортиране", изтеглете шаблона, попълнете го и го качете.':
    "No results imported yet — switch to the Import tab, download the template, fill it in, and upload it.",
  'Все още няма търсени продукти — първо натиснете "Обнови сега".': 'No products searched yet — click "Refresh now" first.',
  "{found} от {total} {kind} продукта в момента имат цена от този източник.": "{found} of {total} {kind} products currently have a price from this source.",
  "проучени": "researched",
  "търсени": "searched",
  " Запазва се само последният опит за всеки продукт — не всеки продукт се търси при всяко изпълнение (вижте бележката за приоритет/ротация по-горе).":
    " Only the most recent attempt per product is kept — not every product is searched every run (see the priority/rotation note above).",
  "Продукт": "Product",
  "Резултат": "Result",
  "Цена": "Price",
  "Кога": "When",
  "✓ намерено": "✓ found",
  "не е намерено": "not found",

  // AmbiguousMatchesPanel
  "Няма нищо за преглед — всяко съпоставяне от последното сканиране е било или сигурно, или ненамерено.":
    "Nothing to review — every match from the last crawl was either confident or not found.",
  "{count} продукт(и) с повече от едно вероятно обявление. Изберете правилното или отхвърлете, ако нито едно от тях не е реално съвпадение — отхвърлянето му пречи да се появи отново, освен ако сканирането не намери различни кандидати следващия път.":
    "{count} product(s) with more than one plausible listing. Pick the right one, or dismiss if none of them are actually a match — dismissing keeps it from reappearing unless the crawl finds different candidates next time.",
  "нашата цена": "our price",
  "Няма цена в това обявление — не може да бъде потвърдено": "No price on this listing — can't confirm it",
  "Използвай това": "Use this",
  "няма цена": "no price",
  "Заглавието на това обявление не показва размер — цената по-горе може да е за различен вариант от нашия. Отворете връзката и проверете преди да я използвате.":
    "This listing's title didn't show a size — the price above may be for a different variant than ours. Open the link and check before using it.",
  "⚠ размерът не е потвърден — проверете страницата преди да използвате": "⚠ size not confirmed — check page before using",
  "Нито едно от тях — отхвърли": "None of these — dismiss",

  // SourceForm
  'Промяната на URL/типа на този източник заменя самоличността му, не добавя нов. Използвайте "+ Добави източник", ако искате да следите друг сайт.':
    'Changing this source\'s URL/type replaces its identity, not adds a new one. Use "+ Add source" instead if you meant to track another site.',
  "Име": "Name",
  "Тип": "Type",
  "Shopify JSON (конкурентът използва Shopify)": "Shopify JSON (competitor runs Shopify)",
  "Сканиране (търсене + анализ)": "Scrape (search + parse)",
  "Ръчно импортиране (проучване чрез Cowork → CSV)": "Manual import (Cowork research → CSV)",
  "jeftinije.hr (масово сканиране на брандове)": "jeftinije.hr (bulk brand-listing crawl)",
  "notino.hr (сканиране по бранд — тест)": "notino.hr (per-brand listing crawl — test)",
  "Базов URL": "Base URL",
  "Шаблон за URL за търсене": "Search URL template",
  "(незадължително — отправна точка за проучващия)": "(optional — a starting point for whoever's researching)",
  "Сканира филтрираните по бранд страници на jeftinije.hr веднъж на изпълнение (без търсене по продукт) и съпоставя стриктно по бранд + мл + концентрация; всичко, което не е сигурно, отива в опашката за преглед вместо да се гадае.":
    "Crawls jeftinije.hr's brand-filtered listing pages once per run (no per-product search) and matches strictly against brand + ml + concentration; anything less than certain goes to the review queue instead of being guessed.",
  "Тестов източник: сканира страницата с обяви на един бранд в notino.hr (в момента само DIOR — вижте BRAND_SLUGS в notinoScraper.ts за добавяне на още) и съпоставя по същия начин като jeftinije.hr.":
    "Test source: crawls a single brand's listing page on notino.hr (currently just DIOR — see BRAND_SLUGS in notinoScraper.ts to add more) and matches the same way as jeftinije.hr.",
  "Активен": "Active",
  'Автоматично обновяване на всеки 24ч (без отметка = само при натискане на "Обнови сега")':
    'Auto-refresh every 24h (unchecked = only when someone clicks "Refresh now")',
  "Запазване…": "Saving…",
  "Запази промените": "Save changes",
  "Добави източник": "Add source",
  "Отказ": "Cancel",
};
