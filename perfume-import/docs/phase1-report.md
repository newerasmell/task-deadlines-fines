# Фаза 1: отчет

Генерирано от `python scripts/phase1_report.py` върху `tests/fixtures`. Не се редактира на ръка. Оставащите разминавания са разгледани и решени в `docs/decisions.md`.

## PremierParfums (1-GR): профил срещу seed-а

846 продукта. 91 от 99 проверки съвпадат с `config/groups/group-1`.

### Разминавания

| Елемент | В конфигурацията | В експорта | Покритие | Бележка |
|---|---|---|---|---|
| description.length | [300, 600] | [130, 490] | 91% | медиана 277 знака; p5–p95 134–487 |
| description.tester_sentence | задължително за тестери (description.md) | Η έκδοση TESTER περιέχει την ίδια αρωματική σύνθεση και προορίζεται κ… | 2% |  |
| rules.compare_at_ratio | [1.2, 2.5] | [1.25, 2.4] | 92% | медиана 1.673 |
| vocab.gender: Ανδρικό άρωμα | Men's Perfume | null | — | превод без английска връзка в данните |
| vocab.gender: Unisex άρωμα | Unisex Perfume | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Ανθινος | Floral | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Ανατολική | Oriental | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: нови канонични | — | ["Amber Spicy", "Amber Vanilla", "Aromatic Aquatic", "Aromatic Green", "Aromatic Water", "Floral Aquatic", "Floral Chypre", "Floral Fresh", "Floral Spicy", "Leather Oriental", "Musky Floral", "Oriental Fougere", "Oriental Fruity", "Oriental Gourmand", "Oriental Vanilla"] | — | стойности с ≥ 3 продукта, които ги няма във vocab.yaml |

<details><summary>Съвпадения</summary>

| Елемент | Стойност | Покритие |
|---|---|---|
| title | {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'} | 89% |
| handle | slug(title) | 70% |
| sku | SK{ean} | 94% |
| ean_location | Variant SKU | 93% |
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
| description.html | 1 × <p> | 78% |
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
| vocab.fragrance_family: Woody Oriental | Woody Oriental | — |
| vocab.fragrance_family: Oriental Woody | Woody Oriental | — |
| vocab.fragrance_family: Oriental-Woody | Woody Oriental | — |
| vocab.fragrance_family: Woody-Oriental | Woody Oriental | — |
| vocab.fragrance_family: Woody Spicy | Woody Spicy | — |
| vocab.fragrance_family: Woody-Spicy | Woody Spicy | — |
| vocab.fragrance_family: Spicy Woody | Woody Spicy | — |
| vocab.fragrance_family: Woody and Spicy | Woody Spicy | — |
| vocab.fragrance_family: Woody Aromatic | Woody Aromatic | — |
| vocab.fragrance_family: Aromatic-Woody | Woody Aromatic | — |
| vocab.fragrance_family: Aromatic-woody | Woody Aromatic | — |
| vocab.fragrance_family: Woody-Aromatic | Woody Aromatic | — |
| vocab.fragrance_family: Aromatic Woody | Woody Aromatic | — |
| vocab.fragrance_family: Woody Floral | Woody Floral | — |
| vocab.fragrance_family: Floral Woody | Woody Floral | — |
| vocab.fragrance_family: Woody-Floral | Woody Floral | — |
| vocab.fragrance_family: Floral-Woody | Woody Floral | — |
| vocab.fragrance_family: Amber Woody | Amber Woody | — |
| vocab.fragrance_family: Woody Amber | Amber Woody | — |
| vocab.fragrance_family: Amber Floral | Amber Floral | — |
| vocab.fragrance_family: Floral Amber | Amber Floral | — |
| vocab.fragrance_family: Aromatic Fougere | Aromatic Fougere | — |
| vocab.fragrance_family: Aromatic-Fougere | Aromatic Fougere | — |
| vocab.fragrance_family: Aromatic Fougère | Aromatic Fougere | — |
| vocab.fragrance_family: Floral Woody Mu… | Floral Woody Musk | — |
| vocab.fragrance_family: Woody Floral Mu… | Floral Woody Musk | — |
| vocab.fragrance_family: Floral-Woody-Mu… | Floral Woody Musk | — |

</details>

## PremierParfums (1-GR): одит (validate.py --audit)

Продукти по най-лошия статус: 144 блокирани · 702 предупреждения.

| Правило | Статус | Брой | Пример |
|---|---|---|---|
| `ean_invalid` | blocked | 52 | Xerjoff Opera New Bottle EDP 100ml TEST…: EAN „7426992790359“ е с грешна контролна цифра. Провери го от опаковката. (от SKU „SK7426… |
| `compare_at_ratio` | blocked | 43 | Louis Vuitton Rhapsody Extrait de Parfu…: Старата цена е 2.59× цената; групата допуска 1.2–2.5×. |
| `sku_formula` | blocked | 37 | Tom Ford Ombre Leather EDP 15ml: SKU „'5901234000013“ не следва SK{ean}, затова EAN не може да се прочете от него. |
| `sku_missing` | blocked | 13 | Mystery Tester: Липсва SKU, затова няма и EAN. |
| `sku_duplicate` | blocked | 4 | Louis Vuitton Imagination Monogram EDP …: SKU „SK3701002703452M“ се повтаря 2 пъти. |
| `price_missing` | blocked | 2 | Tom Ford Vanilla Sex EDP 100 ml TESTER: Липсва цена за PremierParfums (1-GR). |
| `image_missing` | blocked | 1 | test item: Продуктът няма снимка. |
| `language_notes` | warning | 1407 | Amouage Ashore EDP 100 ml: Нотите „kardamóm, kurkuma, ružové korenie“ са на латиница, а магазинът е на „el“. Преводъ… |
| `description_length` | warning | 543 | Tom Ford Orchid Soleil EDP 100 ml: Описанието е 234 знака; групата иска 300–600. |
| `tester_sentence` | warning | 372 | Hermes Eau Des Merveilles Bleue EDT 100…: Тестер без фиксираното изречение: „Η έκδοση TESTER περιέχει την ίδια αρωματική σύνθεση κα… |
| `fragrance_family_unknown` | warning | 172 | Yves Saint Laurent Libre Le Parfum 90 m…: „Ανατολίτικη λουλουδάτη“ не е в речника за fragrance_family. Избери от списъка или добави… |
| `title_formula` | warning | 53 | Lancôme Idole EDP 15ml: Заглавието не следва {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'}. |
| `language_body` | warning | 32 | Tom Ford Ombre Leather EDP 15ml: Описанието е на „sk“, а магазинът е на „el“. Регенерирането идва във Фаза 2. |
| `gender_empty` | warning | 31 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `fragrance_family_empty` | warning | 27 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `ml_mismatch` | warning | 23 | Maison Francis Kurkdjian Ciel de Gum ED…: Обемът в заглавието е 70 ml, а в полето 100 ml. |
| `title_no_ml` | warning | 2 | Mystery Tester: В заглавието няма обем (напр. „100 ml“). Провери дали това е реален продукт. |
| `description_missing` | warning | 1 | test item: Липсва описание. |
| `empty_paragraph` | fixed | 399 | Amouage Ashore EDP 100 ml: Премахнат празен параграф <p></p>. |
| `gender_variant` | fixed | 252 | Yves Saint Laurent Libre Le Parfum 90 m…: „Γυναικείο άρωμα“ е вариант на „Women's Perfume“ (речник). |
| `fragrance_family_variant` | fixed | 235 | Amouage Ashore EDP 100 ml: „Ανατολική“ е вариант на „Oriental“ (речник). |
| `format` | fixed | 176 | Xerjoff Opera New Bottle EDP 100ml TEST…: Форматиране: „Xerjoff Opera New Bottle EDP 100ml TESTER“ → „Xerjoff Opera New Bottle EDP … |
| `tester_marker` | fixed | 1 | Mystery Tester: Маркерът за тестер е „TESTER“: „Mystery Tester“ → „Mystery TESTER“. |

## Parfemija (1-HR): профил срещу seed-а

870 продукта. 89 от 98 проверки съвпадат с `config/groups/group-1`.

### Разминавания

| Елемент | В конфигурацията | В експорта | Покритие | Бележка |
|---|---|---|---|---|
| content_language | hr | en | 84% |  |
| description.length | [300, 600] | [110, 440] | 92% | медиана 254 знака; p5–p95 118–435 |
| description.tester_sentence | задължително за тестери (description.md) | TESTER varijanta sadrži istu mirisnu kompoziciju i prvenstveno je nam… | 2% |  |
| rules.compare_at_ratio | [1.2, 2.5] | [1.15, 2.3] | 91% | медиана 1.576 |
| vocab.gender: Muški parfem | Men's Perfume | null | — | превод без английска връзка в данните |
| vocab.gender: Unisex parfem | Unisex Perfume | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Kwiatowy | Floral | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: Cvjetni | Floral | null | — | превод без английска връзка в данните |
| vocab.fragrance_family: нови канонични | — | ["Amber Spicy", "Amber Vanilla", "Aromatic Aquatic", "Aromatic Green", "Aromatic Water", "Citrus Aromatic", "Floral Aquatic", "Floral Chypre", "Floral Fresh", "Floral Spicy", "Leather Oriental", "Musky Floral", "Oriental Fougere", "Oriental Fruity", "Oriental Gourmand", "Oriental Vanilla"] | — | стойности с ≥ 3 продукта, които ги няма във vocab.yaml |

<details><summary>Съвпадения</summary>

| Елемент | Стойност | Покритие |
|---|---|---|
| title | {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'} | 90% |
| handle | slug(title) | 69% |
| sku | SK{ean} | 94% |
| ean_location | Variant SKU | 93% |
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
| description.html | 1 × <p> | 82% |
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
| vocab.fragrance_family: Woody Oriental | Woody Oriental | — |
| vocab.fragrance_family: Oriental Woody | Woody Oriental | — |
| vocab.fragrance_family: Oriental-Woody | Woody Oriental | — |
| vocab.fragrance_family: Woody-Oriental | Woody Oriental | — |
| vocab.fragrance_family: Woody Spicy | Woody Spicy | — |
| vocab.fragrance_family: Woody-Spicy | Woody Spicy | — |
| vocab.fragrance_family: Spicy Woody | Woody Spicy | — |
| vocab.fragrance_family: Woody and Spicy | Woody Spicy | — |
| vocab.fragrance_family: Woody Aromatic | Woody Aromatic | — |
| vocab.fragrance_family: Aromatic-Woody | Woody Aromatic | — |
| vocab.fragrance_family: Aromatic-woody | Woody Aromatic | — |
| vocab.fragrance_family: Woody-Aromatic | Woody Aromatic | — |
| vocab.fragrance_family: Aromatic Woody | Woody Aromatic | — |
| vocab.fragrance_family: Woody Floral | Woody Floral | — |
| vocab.fragrance_family: Floral Woody | Woody Floral | — |
| vocab.fragrance_family: Woody-Floral | Woody Floral | — |
| vocab.fragrance_family: Floral-Woody | Woody Floral | — |
| vocab.fragrance_family: Amber Woody | Amber Woody | — |
| vocab.fragrance_family: Woody Amber | Amber Woody | — |
| vocab.fragrance_family: Amber Floral | Amber Floral | — |
| vocab.fragrance_family: Floral Amber | Amber Floral | — |
| vocab.fragrance_family: Aromatic Fougere | Aromatic Fougere | — |
| vocab.fragrance_family: Aromatic-Fougere | Aromatic Fougere | — |
| vocab.fragrance_family: Aromatic Fougère | Aromatic Fougere | — |
| vocab.fragrance_family: Floral Woody Mu… | Floral Woody Musk | — |
| vocab.fragrance_family: Woody Floral Mu… | Floral Woody Musk | — |
| vocab.fragrance_family: Floral-Woody-Mu… | Floral Woody Musk | — |

</details>

## Parfemija (1-HR): одит (validate.py --audit)

Продукти по най-лошия статус: 214 блокирани · 656 предупреждения.

| Правило | Статус | Брой | Пример |
|---|---|---|---|
| `compare_at_ratio` | blocked | 76 | Amouage Lineage EDP 100 ml: Старата цена е 2.61× цената; групата допуска 1.2–2.5×. |
| `ean_invalid` | blocked | 54 | Xerjoff Opera New Bottle EDP 100ml TEST…: EAN „7426992790359“ е с грешна контролна цифра. Провери го от опаковката. (от SKU „SK7426… |
| `sku_formula` | blocked | 37 | Tom Ford Ombre Leather EDP 15ml: SKU „'5901234000013“ не следва SK{ean}, затова EAN не може да се прочете от него. |
| `sku_duplicate` | blocked | 33 | Paco Rabanne Lady Million Fabulous Inte…: SKU „SK3349668592371“ се повтаря 2 пъти. |
| `image_missing` | blocked | 20 | Yves Saint Laurent Libre Le Parfum 90 m…: Продуктът няма снимка. |
| `sku_missing` | blocked | 19 | Mystery Tester: Липсва SKU, затова няма и EAN. |
| `compare_at_not_above` | blocked | 6 | Zadig & Voltaire This Is Him! Undressed…: Старата цена 45.00 не е по-висока от цената 65.00. |
| `price_missing` | blocked | 3 | Tom Ford Vanilla Sex EDP 100 ml TESTER: Липсва цена за Parfemija (1-HR). |
| `language_notes` | warning | 1593 | Xerjoff Accento EDP New Bottle 100 ml T…: Нотите „Zumbul, citrus“ са на английски, а магазинът е на „hr“. Преводът идва във Фаза 2. |
| `language_body` | warning | 793 | Tom Ford Noir Pour Femme EDP 100 ml: Описанието е на „sl“, а магазинът е на „hr“. Регенерирането идва във Фаза 2. |
| `description_length` | warning | 680 | Tom Ford Orchid Soleil EDP 100 ml: Описанието е 211 знака; групата иска 300–600. |
| `tester_sentence` | warning | 375 | Hermes Eau Des Merveilles Bleue EDT 100…: Тестер без фиксираното изречение: „TESTER varijanta sadrži istu mirisnu kompoziciju i prv… |
| `fragrance_family_unknown` | warning | 176 | Yves Saint Laurent Libre Le Parfum 90 m…: „Orijentalno cvjetna“ не е в речника за fragrance_family. Избери от списъка или добави ка… |
| `title_formula` | warning | 49 | Lancôme Idole EDP 15ml: Заглавието не следва {brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'}. |
| `gender_empty` | warning | 32 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `fragrance_family_empty` | warning | 27 | Tom Ford Ombre Leather EDP 15ml: Полето е празно. Избери стойност от речника. |
| `ml_mismatch` | warning | 23 | Maison Francis Kurkdjian Ciel de Gum ED…: Обемът в заглавието е 70 ml, а в полето 100 ml. |
| `title_no_ml` | warning | 2 | Mystery Tester: В заглавието няма обем (напр. „100 ml“). Провери дали това е реален продукт. |
| `empty_paragraph` | fixed | 423 | Amouage Ashore EDP 100 ml: Премахнат празен параграф <p></p>. |
| `gender_variant` | fixed | 250 | Yves Saint Laurent Libre Le Parfum 90 m…: „Ženski parfem“ е вариант на „Women's Perfume“ (речник). |
| `fragrance_family_variant` | fixed | 243 | Louis Vuitton Spell on You Extrait de P…: „Cvjetna“ е вариант на „Floral“ (речник). |
| `format` | fixed | 178 | Xerjoff Opera New Bottle EDP 100ml TEST…: Форматиране: „Xerjoff Opera New Bottle EDP 100ml TESTER“ → „Xerjoff Opera New Bottle EDP … |
| `tester_marker` | fixed | 1 | Mystery Tester: Маркерът за тестер е „TESTER“: „Mystery Tester“ → „Mystery TESTER“. |
