# Фаза 1: отчет

Генерирано от `python scripts/phase1_report.py` върху `tests/fixtures`. Не се редактира на ръка.

## PremierParfums (1-GR): профил срещу seed-а

846 продукта. 63 от 72 проверки съвпадат с `config/groups/group-1`.

### Разминавания

| Елемент | В конфигурацията | В експорта | Покритие | Бележка |
|---|---|---|---|---|
| description.length | [200, 450] | [130, 490] | 91% | медиана 277 знака; p5–p95 134–487 |
| description.html | single <p> | 2 × <p> | 46% |  |
| description.tester_sentence | задължително за тестери (description.md) | Η έκδοση TESTER περιέχει την ίδια αρωματική σύνθεση και προορίζεται κ… | 2% |  |
| rules.compare_at_ratio | [1.3, 2.0] | [1.25, 2.4] | 92% | медиана 1.673 |
| vocab.gender: Ανδρικό άρωμα | Men's Perfume | null | — | превод без английска връзка в данните |
| vocab.gender: Unisex άρωμα | Unisex Perfume | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Ανθινος | Floral | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Ανατολική | Oriental | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: нови канонични | — | ["Amber Floral", "Amber Spicy", "Amber Vanilla", "Amber Woody", "Aromatic Aquatic", "Aromatic Fougere", "Aromatic Green", "Aromatic Water", "Floral Aquatic", "Floral Chypre", "Floral Fresh", "Floral Spicy", "Floral Woody Musk", "Leather Oriental", "Musky Floral", "Oriental Fougere", "Oriental Fruity", "Oriental Gourmand", "Oriental Vanilla", "Woody Aromatic", "Woody Floral", "Woody Oriental", "Woody Spicy"] | — | стойности с ≥ 3 продукта, които ги няма във vocab.yaml |

<details><summary>Съвпадения</summary>

| Елемент | Стойност | Покритие |
|---|---|---|
| title | {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'} | 89% |
| handle | slug(title) | 70% |
| sku | SK{ean} | 94% |
| ean_location | metafield custom.sklad | 98% |
| concentration_short | {"Eau de Parfum": "EDP", "Eau de Toilette": "EDT", "Eau de Cologne": … | 100% |
| title_language | en | 100% |
| content_language | el | 96% |
| currency | EUR | — |
| metafield_set | ["custom.base_note", "custom.fragrance_family", "custom.gender", "cus… | — |
| metafields_used | ["custom.base_note", "custom.fragrance_family", "custom.gender", "cus… | — |
| fixed: Product Category | Health & Beauty > Personal Care > Cosmetics > Perfumes & Colognes | 96% |
| fixed: Variant Grams | 300 | 97% |
| fixed: Variant Weight Unit | kg | 100% |
| fixed: Variant Inventory Tracker | shopify | 100% |
| fixed: Variant Inventory Policy | deny | 98% |
| fixed: Variant Fulfillment Service | manual | 100% |
| fixed: Variant Requires Shipping | true | 100% |
| fixed: Variant Taxable | false | 65% |
| fixed: Option1 Name | Title | 100% |
| fixed: Option1 Value | Default Title | 100% |
| fixed: Gift Card | false | 100% |
| google.product_category | 479 | 99% |
| google.condition | new | 62% |
| google.gender | {"Women's Perfume": "Women", "Unisex Perfume": "Unisex", "Men's Perfu… | 87% |
| price.rounding | 00 | 93% |
| vocab.gender: Women's Perfume | Women's Perfume | — |
| vocab.gender: Women’s Perfume | Women's Perfume | — |
| vocab.gender: Women's perfume | Women's Perfume | — |
| vocab.gender: Women’s perfume | Women's Perfume | — |
| vocab.gender: Γυναικείο άρωμα | Women's Perfume | — |
| vocab.gender: Men's Perfume | Men's Perfume | — |
| vocab.gender: Men’s Perfume | Men's Perfume | — |
| vocab.gender: Men's perfume | Men's Perfume | — |
| vocab.gender: Men’s perfume | Men's Perfume | — |
| vocab.gender: Unisex Perfume | Unisex Perfume | — |
| vocab.gender: Unisex perfume | Unisex Perfume | — |
| vocab.gender: Unisex Pefume | Unisex Perfume | — |
| vocab.gender: Unsiex | Unisex Perfume | — |
| vocab.gender: Unisex | Unisex Perfume | — |
| vocab.fragrance_family: Floral | Floral | — |
| vocab.fragrance_family: Floral Fruity | Floral Fruity | — |
| vocab.fragrance_family: Fruity Floral | Floral Fruity | — |
| vocab.fragrance_family: Woody | Woody | — |
| vocab.fragrance_family: Wood | Woody | — |
| vocab.fragrance_family: Amber | Amber | — |
| vocab.fragrance_family: Oriental | Oriental | — |
| vocab.fragrance_family: Oriental Floral | Oriental Floral | — |
| vocab.fragrance_family: Oriental-Floral | Oriental Floral | — |
| vocab.fragrance_family: Floral-Oriental | Oriental Floral | — |
| vocab.fragrance_family: Floral Oriental | Oriental Floral | — |
| vocab.fragrance_family: Oriental Spicy | Oriental Spicy | — |
| vocab.fragrance_family: Oriental-Spicy | Oriental Spicy | — |
| vocab.fragrance_family: Fruity | Fruity | — |
| vocab.fragrance_family: Fruit | Fruity | — |
| vocab.fragrance_family: Spicy | Spicy | — |
| vocab.fragrance_family: Aromatic | Aromatic | — |
| vocab.fragrance_family: Citrus | Citrus | — |
| vocab.fragrance_family: Chypre | Chypre | — |
| vocab.fragrance_family: Fougere | null | — |
| vocab.fragrance_family: Gourmand | null | — |
| vocab.fragrance_family: Aquatic | Aquatic | — |
| vocab.fragrance_family: Leather | null | — |
| vocab.fragrance_family: Green | null | — |

</details>

## PremierParfums (1-GR): одит (validate.py --audit)

Продукти по най-лошия статус: 448 блокирани · 394 предупреждения · 1 поправени · 3 ok.

| Правило | Статус | Брой | Пример |
|---|---|---|---|
| `ean_in_other_field` | blocked | 270 | Amouage Ashore EDP 100 ml: Полето за EAN е празно, но 701666400035 (валиден EAN) стои в SKU/баркода. Потвърди го и г… |
| `compare_at_ratio` | blocked | 212 | Tom Ford Orchid Soleil EDP 100 ml: Старата цена е 2.01× цената; групата допуска 1.3–2.0×. |
| `ean_missing` | blocked | 48 | Tom Ford Ombre Leather EDP 15ml: Липсва EAN. Въведи го от опаковката. |
| `sku_missing` | blocked | 13 | Mystery Tester: Липсва SKU. |
| `ean_invalid` | blocked | 9 | Xerjoff Opera New Bottle EDP 100ml TEST…: EAN „7426992790359“ е с грешна контролна цифра. Провери го от опаковката. |
| `sku_duplicate` | blocked | 4 | Louis Vuitton Imagination Monogram EDP …: SKU „SK3701002703452M“ се повтаря 2 пъти. |
| `price_missing` | blocked | 2 | Tom Ford Vanilla Sex EDP 100 ml TESTER: Липсва цена за PremierParfums (1-GR). |
| `image_missing` | blocked | 1 | test item: Продуктът няма снимка. |
| `language_notes` | warning | 1407 | Amouage Ashore EDP 100 ml: Нотите „kardamóm, kurkuma, ružové korenie“ са на латиница, а магазинът е на „el“. Преводъ… |
| `tester_sentence` | warning | 349 | Hermes Eau Des Merveilles Bleue EDT 100…: Тестер без изречение, че е същият аромат в по-проста опаковка (description.md). |
| `description_length` | warning | 322 | Louis Vuitton Rhapsody Extrait de Parfu…: Описанието е 198 знака; групата иска 200–450. |
| `fragrance_family_unknown` | warning | 271 | Yves Saint Laurent Libre Le Parfum 90 m…: „Ανατολίτικη λουλουδάτη“ не е в речника за fragrance_family. Избери от списъка или добави… |
| `title_formula` | warning | 53 | Lancôme Idole EDP 15ml: Заглавието не следва {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'}. |
| `language_body` | warning | 32 | Tom Ford Ombre Leather EDP 15ml: Описанието е на „sk“, а магазинът е на „el“. Регенерирането идва във Фаза 2. |
| `gender_empty` | warning | 31 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `fragrance_family_empty` | warning | 27 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `sku_formula` | warning | 24 | Jo Malone English Pear and Freesia EDC …: SKU „SK1000000034912N“ не следва SK{ean}; очаквано „SK1000000034912“. |
| `ml_mismatch` | warning | 23 | Maison Francis Kurkdjian Ciel de Gum ED…: Обемът в заглавието е 70 ml, а в полето 100 ml. |
| `title_no_ml` | warning | 2 | Mystery Tester: В заглавието няма обем (напр. „100 ml“). Провери дали това е реален продукт. |
| `description_missing` | warning | 1 | test item: Липсва описание. |
| `gender_variant` | fixed | 252 | Yves Saint Laurent Libre Le Parfum 90 m…: „Γυναικείο άρωμα“ е вариант на „Women's Perfume“ (речник). |
| `fragrance_family_variant` | fixed | 181 | Amouage Ashore EDP 100 ml: „Ανατολική“ е вариант на „Oriental“ (речник). |
| `format` | fixed | 176 | Xerjoff Opera New Bottle EDP 100ml TEST…: Форматиране: „Xerjoff Opera New Bottle EDP 100ml TESTER“ → „Xerjoff Opera New Bottle EDP … |
| `tester_marker` | fixed | 1 | Mystery Tester: Маркерът за тестер е „TESTER“: „Mystery Tester“ → „Mystery TESTER“. |

## Parfemija (1-HR): профил срещу seed-а

870 продукта. 61 от 71 проверки съвпадат с `config/groups/group-1`.

### Разминавания

| Елемент | В конфигурацията | В експорта | Покритие | Бележка |
|---|---|---|---|---|
| content_language | hr | en | 84% |  |
| description.length | [200, 450] | [110, 440] | 92% | медиана 254 знака; p5–p95 118–435 |
| description.html | single <p> | 2 × <p> | 48% |  |
| description.tester_sentence | задължително за тестери (description.md) | TESTER varijanta sadrži istu mirisnu kompoziciju i prvenstveno je nam… | 2% |  |
| rules.compare_at_ratio | [1.3, 2.0] | [1.15, 2.3] | 91% | медиана 1.576 |
| vocab.gender: Muški parfem | Men's Perfume | null | — | превод без английска връзка в данните |
| vocab.gender: Unisex parfem | Unisex Perfume | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Kwiatowy | Floral | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Cvjetni | Floral | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: нови канонични | — | ["Amber Floral", "Amber Spicy", "Amber Vanilla", "Amber Woody", "Aromatic Aquatic", "Aromatic Fougere", "Aromatic Green", "Aromatic Water", "Citrus Aromatic", "Floral Aquatic", "Floral Chypre", "Floral Fresh", "Floral Spicy", "Floral Woody Musk", "Leather Oriental", "Musky Floral", "Oriental Fougere", "Oriental Fruity", "Oriental Gourmand", "Oriental Vanilla", "Woody Aromatic", "Woody Floral", "Woody Oriental", "Woody Spicy"] | — | стойности с ≥ 3 продукта, които ги няма във vocab.yaml |

<details><summary>Съвпадения</summary>

| Елемент | Стойност | Покритие |
|---|---|---|
| title | {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'} | 90% |
| handle | slug(title) | 69% |
| sku | SK{ean} | 93% |
| ean_location | metafield custom.sklad | 97% |
| concentration_short | {"Eau de Parfum": "EDP", "Eau de Toilette": "EDT", "Eau de Cologne": … | 100% |
| title_language | en | 100% |
| currency | EUR | — |
| metafield_set | ["custom.base_note", "custom.fragrance_family", "custom.gender", "cus… | — |
| metafields_used | ["custom.base_note", "custom.fragrance_family", "custom.gender", "cus… | — |
| fixed: Product Category | Health & Beauty > Personal Care > Cosmetics > Perfumes & Colognes | 96% |
| fixed: Variant Grams | 300 | 94% |
| fixed: Variant Weight Unit | kg | 100% |
| fixed: Variant Inventory Tracker | shopify | 100% |
| fixed: Variant Inventory Policy | deny | 97% |
| fixed: Variant Fulfillment Service | manual | 100% |
| fixed: Variant Requires Shipping | true | 100% |
| fixed: Variant Taxable | false | 65% |
| fixed: Option1 Name | Title | 100% |
| fixed: Option1 Value | Default Title | 100% |
| fixed: Gift Card | false | 100% |
| google.product_category | 479 | 98% |
| google.condition | new | 62% |
| google.gender | {"Women's Perfume": "Women", "Unisex Perfume": "Unisex", "Men's Perfu… | 87% |
| price.rounding | 00 | 90% |
| vocab.gender: Women's Perfume | Women's Perfume | — |
| vocab.gender: Women’s Perfume | Women's Perfume | — |
| vocab.gender: Women's perfume | Women's Perfume | — |
| vocab.gender: Women’s perfume | Women's Perfume | — |
| vocab.gender: Ženski parfem | Women's Perfume | — |
| vocab.gender: Men's Perfume | Men's Perfume | — |
| vocab.gender: Men’s Perfume | Men's Perfume | — |
| vocab.gender: Men's perfume | Men's Perfume | — |
| vocab.gender: Men’s perfume | Men's Perfume | — |
| vocab.gender: Unisex Perfume | Unisex Perfume | — |
| vocab.gender: Unisex perfume | Unisex Perfume | — |
| vocab.gender: Unisex Pefume | Unisex Perfume | — |
| vocab.gender: Unisex | Unisex Perfume | — |
| vocab.fragrance_family: Floral | Floral | — |
| vocab.fragrance_family: Floral Fruity | Floral Fruity | — |
| vocab.fragrance_family: Fruity Floral | Floral Fruity | — |
| vocab.fragrance_family: Woody | Woody | — |
| vocab.fragrance_family: Wood | Woody | — |
| vocab.fragrance_family: Amber | Amber | — |
| vocab.fragrance_family: Oriental | Oriental | — |
| vocab.fragrance_family: Oriental Floral | Oriental Floral | — |
| vocab.fragrance_family: Oriental-Floral | Oriental Floral | — |
| vocab.fragrance_family: Floral-Oriental | Oriental Floral | — |
| vocab.fragrance_family: Floral Oriental | Oriental Floral | — |
| vocab.fragrance_family: Oriental Spicy | Oriental Spicy | — |
| vocab.fragrance_family: Oriental-Spicy | Oriental Spicy | — |
| vocab.fragrance_family: Fruity | Fruity | — |
| vocab.fragrance_family: Fruit | Fruity | — |
| vocab.fragrance_family: Spicy | Spicy | — |
| vocab.fragrance_family: Aromatic | Aromatic | — |
| vocab.fragrance_family: Citrus | Citrus | — |
| vocab.fragrance_family: Chypre | Chypre | — |
| vocab.fragrance_family: Fougere | null | — |
| vocab.fragrance_family: Gourmand | null | — |
| vocab.fragrance_family: Aquatic | Aquatic | — |
| vocab.fragrance_family: Leather | null | — |
| vocab.fragrance_family: Green | null | — |

</details>

## Parfemija (1-HR): одит (validate.py --audit)

Продукти по най-лошия статус: 542 блокирани · 328 предупреждения.

| Правило | Статус | Брой | Пример |
|---|---|---|---|
| `ean_in_other_field` | blocked | 287 | Amouage Ashore EDP 100 ml: Полето за EAN е празно, но 701666400035 (валиден EAN) стои в SKU/баркода. Потвърди го и г… |
| `compare_at_ratio` | blocked | 251 | Amouage Lineage EDP 100 ml: Старата цена е 2.61× цената; групата допуска 1.3–2.0×. |
| `ean_missing` | blocked | 47 | Tom Ford Ombre Leather EDP 15ml: Липсва EAN. Въведи го от опаковката. |
| `sku_duplicate` | blocked | 33 | Paco Rabanne Lady Million Fabulous Inte…: SKU „SK3349668592371“ се повтаря 2 пъти. |
| `image_missing` | blocked | 20 | Yves Saint Laurent Libre Le Parfum 90 m…: Продуктът няма снимка. |
| `sku_missing` | blocked | 19 | Mystery Tester: Липсва SKU. |
| `ean_invalid` | blocked | 16 | Xerjoff Opera New Bottle EDP 100ml TEST…: EAN „7426992790359“ е с грешна контролна цифра. Провери го от опаковката. |
| `compare_at_not_above` | blocked | 6 | Zadig & Voltaire This Is Him! Undressed…: Старата цена 45.00 не е по-висока от цената 65.00. |
| `price_missing` | blocked | 3 | Tom Ford Vanilla Sex EDP 100 ml TESTER: Липсва цена за Parfemija (1-HR). |
| `language_notes` | warning | 1593 | Xerjoff Accento EDP New Bottle 100 ml T…: Нотите „Zumbul, citrus“ са на английски, а магазинът е на „hr“. Преводът идва във Фаза 2. |
| `language_body` | warning | 793 | Tom Ford Noir Pour Femme EDP 100 ml: Описанието е на „sl“, а магазинът е на „hr“. Регенерирането идва във Фаза 2. |
| `description_length` | warning | 368 | Louis Vuitton Rhapsody Extrait de Parfu…: Описанието е 166 знака; групата иска 200–450. |
| `tester_sentence` | warning | 345 | Hermes Eau Des Merveilles Bleue EDT 100…: Тестер без изречение, че е същият аромат в по-проста опаковка (description.md). |
| `fragrance_family_unknown` | warning | 276 | Yves Saint Laurent Libre Le Parfum 90 m…: „Orijentalno cvjetna“ не е в речника за fragrance_family. Избери от списъка или добави ка… |
| `title_formula` | warning | 49 | Lancôme Idole EDP 15ml: Заглавието не следва {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'}. |
| `gender_empty` | warning | 32 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `fragrance_family_empty` | warning | 27 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `sku_formula` | warning | 24 | Jo Malone English Pear and Freesia EDC …: SKU „SK1000000034912N“ не следва SK{ean}; очаквано „SK1000000034912“. |
| `ml_mismatch` | warning | 23 | Maison Francis Kurkdjian Ciel de Gum ED…: Обемът в заглавието е 70 ml, а в полето 100 ml. |
| `title_no_ml` | warning | 2 | Mystery Tester: В заглавието няма обем (напр. „100 ml“). Провери дали това е реален продукт. |
| `gender_variant` | fixed | 250 | Yves Saint Laurent Libre Le Parfum 90 m…: „Ženski parfem“ е вариант на „Women's Perfume“ (речник). |
| `fragrance_family_variant` | fixed | 188 | Louis Vuitton Spell on You Extrait de P…: „Cvjetna“ е вариант на „Floral“ (речник). |
| `format` | fixed | 178 | Xerjoff Opera New Bottle EDP 100ml TEST…: Форматиране: „Xerjoff Opera New Bottle EDP 100ml TESTER“ → „Xerjoff Opera New Bottle EDP … |
| `tester_marker` | fixed | 1 | Mystery Tester: Маркерът за тестер е „TESTER“: „Mystery Tester“ → „Mystery TESTER“. |
