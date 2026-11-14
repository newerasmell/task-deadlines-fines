# Решения

Взети след прегледа на Фаза 1 (одит на GR и HR експортите, `docs/phase1-report.md`).

| # | Тема | Решение | Къде е приложено |
|---|---|---|---|
| 1 | Език на описанията в Parfemija (HR) | Правилно е хърватски. 84% от сегашните описания са на английски и са грешка: одитът ги маркира, Фаза 2 ги генерира наново на хърватски. | `validate.py` (`language_body`), Фаза 2 |
| 2 | Форма и дължина на описанието | Един `<p>`, 300–600 знака. Празен `<p></p>` (в експортите след почти всяко описание) се маха автоматично. | `group.yaml description`, `description.md`, `validate.py` (`empty_paragraph`) |
| 3 | Изречение за тестер | Фиксирано изречение на език, добавя се от кода, не от AI. Английският е основен; el и hr са взети от експортите; другите езици се превеждат във Фаза 2 и се одобряват. | `group.yaml tester_sentence`, `validate.py` (`tester_sentence`) |
| 4 | Стара цена (compare-at) | Допустимо 1.2–2.5× цената; извън това е blocked. | `group.yaml rules.compare_at_ratio` |
| 5 | Местни стойности в gender / fragrance family без превод | AI предлага английската стойност от речника (suggested), човек я одобрява веднъж и тя се запомня (`vocab_learned`). | Фаза 2 |
| 6 | Съставни семейства | Честите (≥ 8 продукта) стават канонични: Woody Oriental, Woody Spicy, Woody Aromatic, Woody Floral, Amber Woody, Amber Floral, Aromatic Fougere, Floral Woody Musk. Общо 25. По-редките остават warning, Фаза 2 ги свежда до най-близкото като предложение. | `vocab.yaml` |
| 7 | Глосар на нотите | AI дава английската дума; двойките гръцки ↔ хърватски от експортите потвърждават превода. | `config/glossary/pairs/`, Фаза 2 |
| 8 | Къде е EAN | EAN-ът се чете от SKU (`SK{ean}`). Полето Sklad е старо: не се пише при нови продукти и празно не е проблем. SKU, от което не се чете валиден EAN, е blocked. | `group.yaml`, `titles.ean_from_sku`, `validate.py` (`ean_invalid`, `sku_formula`) |
| 9 | Цена на проучването | Два режима. **Евтин** (по подразбиране): Sonnet 5.5, до 3 търсения без четене на страници, текстовете през Batch API; лимит $0.10 на продукт за всичко (вдигнат на $0.125, виж #10). **Задълбочен**: Opus 5.5, до 6 търсения и до 4 прочетени страници (по 6000 токена), текстовете веднага; лимит $0.50. Избира се за цялата партида (`--tier`), за избрани продукти (`--deep EAN,...` или колона `research` във входа) или за един продукт след това (`research_again.py --ean`, записва се като нова партида). Във Фаза 4: избор при „Нова партида“ за всички или маркираните редове и бутон „Проучи задълбочено“ на всеки продукт. | `pipeline/tiers.py`, `scripts/new_batch.py`, `scripts/research_again.py` |
| 10 | Таван на цената | Лимитът на режима може да се надвиши с най-много 20% (евтин: таван $0.15, задълбочен: $0.60). Евтиният лимит е $0.125, за да има място за търсене на снимка: снимката е задължителна, а проучване ≈ $0.08 + търсене на снимка ≈ $0.045 + текстове ≈ $0.015 не се събираха в $0.12. Преди всяка платена стъпка след проучването (търсене на снимка, текстове) кодът сравнява похарченото + очакваната цена на стъпката с тавана; ако минава, стъпката се пропуска и полето казва защо. Търсенето на снимка пази резерв за текстовете. Проучването не се продължава (pause_turn) след тавана. | `pipeline/tiers.py` (`OVERRUN`, `ceiling`), `pipeline/batch.py` (`affords`), `pipeline/ai.py` (`budget`) |
| 11 | EAN от друг размер или продукт | Не блокира. Проучването търси по името и обема и продължава с всички стъпки. EAN полето става suggested (`ean_mismatch`): входният EAN остава, а EAN-ът, който източниците дават за този обем (с валидна контролна цифра), е алтернатива за приемане; ако няма такъв, съобщението казва да се провери ръчно. Блокира само име, което не отговаря на никакъв продукт (`research_mismatch`). Търсенето на снимка не ползва грешния EAN. | `pipeline/research.py` (`mismatch`, `ean_for_volume`), `pipeline/batch.py` (`flag_ean`) |
| 12 | Главна снимка | Фонът и разположението се измерват от сегашните снимки в експортите (`learn_layout.py`): 80 снимки, 78 с равен бял фон, платно 1080×1080 PNG, шишето е центрирано и е до 84% от височината (широките шишета до 90% от ширината, както в магазините). Фонът се маха чрез „наливане“ от краищата, когато фонът на източника е равен; иначе локално с `rembg` (u2net). Наливането пази светлите части вътре в шишето (сребърната капачка на Gucci Bamboo, която `rembg` махаше). Никога не се уголемява: малко шише остава в истинския си размер и полето е warning; warning и когато шишето в източника опира в горния или долния край (вероятно е отрязано). Магазини с еднакъв шаблон ползват един файл. Файловете се именуват по съдържанието си (sha256) в `MEDIA_DIR`, на постоянен диск в Render. Полето `image` сочи към готовата снимка (`/api/media/{id}`), оригиналът е алтернатива, а URL-ът на източника е в `sources`. | `pipeline/layout.py`, `pipeline/compose.py`, `pipeline/media.py`, `db/repo.py` (`save_media`, `replace_composed`), `render.yaml` |
| 13 | Решения в приложението | Приеми (A) прави suggested/warning/fixed поле ok с името и часа; спряно поле не се приема, само се поправя (Промени или друга стойност). Всяка промяна минава през същата валидация като партидата, заедно със свързаното поле (цена ↔ зачеркната, EAN ↔ SKU); нов EAN сглобява SKU наново (отвореният въпрос от Фаза 2). Общите факти (марка, име, концентрация, пол, семейство, съставки, EAN, SKU, снимка) се променят във всички сайтове на продукта, в които стойността е същата; текстовете, нотите и цените са по сайт. Контролираните полета приемат само стойности от речника или алтернативите. „Одобри продукта“ е възможно само без спрени полета и без нерешени предложения във всички сайтове; всяка следваща промяна сваля одобрението. „Приеми всички в колоната“ иска едно потвърждение. Кой решава: име, питано веднъж и пазено в браузъра (заглавка X-Actor), докато приложението се свърже с входа на екипа. | `db/review.py`, `api/review.py`, `app/src` |
| 14 | Качване в Shopify | Admin GraphQL API 2026-10, един `productSet` на продукт и сайт: заглавие, описание, SEO, статус (чернова или активен, избира се при качване), категория Perfumes & Colognes от таксономията (търси се по име, не се отгатва ID), един вариант със SKU, цени, тегло 300 g, политика deny, без данък по шаблона, EAN и като баркод на варианта (GTIN за Google), metafields `custom.*` и `mm-google-shopping.*` (gender, google_product_category, condition). Снимката е готовата за този шаблон и минава през stagedUploadsCreate. Качват се само одобрени продукти без спрени и нерешени полета. Без дубликати: качен оттук продукт се обновява по пазения Shopify ID; SKU или handle, които вече съществуват в магазина, но не са качени оттук, са грешка с името на стария продукт и не се презаписват. Достъп: Dev Dashboard приложение (client id + secret → токен за 24 часа) или стар токен. | `pipeline/shopify.py`, `db/upload.py`, екран „Качване“ |
| 15 | Магазини в приложението | Каталог, качен в приложението, става предложен профил (версия на магазин, с разликите спрямо потвърдения) с препоръка за група: колони, метаполета, формули за заглавие и SKU; препоръка при ≥ 80%, иначе нова група. Езикът, държавата и валутата се вземат от профила при потвърждението, след проверката от човек (каталогът на Parfemija е 84% на английски). Потвърждението записва магазина в групата и пуска одит на същия експорт. Магазин или Shopify адрес, добавени в приложението, се пазят в базата и се сливат върху stores.yaml; токени никога: полето за токен от макета е махнато, профилът показва кои променливи да се добавят в Render. Новите продукти за магазин се правят по потвърдения му профил. CSV с поправките: само продукти с промяна, само променените колони, винаги с пълната текуща стойност; спрените стойности не излизат. Нова група: scripts/new_group.py от 1–3 експорта. | `db/stores.py`, `pipeline/groups.py`, `db/audit.py`, `scripts/new_group.py` |
| 16 | Нов продукт само по име, без цени | „Нова партида → Само имена“: по един продукт на ред с обема („Dior Sauvage EDT 100 ml TESTER“); обемът, тестерът и EAN (ако е в реда) се четат от реда, всичко останало се проучва и генерира по профила на всеки магазин. Липсващ EAN е спрян, с EAN-а от източниците за този обем като избор (AI не го попълва сам). Цени системата не слага: липсваща цена е предупреждение, продукт без цена се качва само като чернова и цената се задава в Shopify; качване като активен без цена се отказва, за да не излезе на 0.00. | `pipeline/input.read_names_text`, `pipeline/batch.flag_missing_ean`, `pipeline/validate.py` (`price_missing`), `pipeline/shopify.py` |


## 17. Team login; Shopify access entered in the app

Users with scrypt password hashes, sessions as random HttpOnly cookies (only their SHA-256 in the database),
5 wrong passwords in 15 minutes per name or address → wait. The first admin is created on an empty database;
admins create the others and enter Shopify access per store. Access is encrypted with Fernet; the key lives on
the persistent media disk (or `PERFUME_SECRET_KEY`), not in the database, so a database copy reveals nothing.
Values are write-only: the app shows only who set them and when, plus a "check connection" call.


## 18. One text per store; adding stores reuses research

A store with an accepted profile (example descriptions, HTML shape, length) gets its own description written
from the English master in its own style, so two competitors in one language never share a text; stores without
a profile share their language's translation. Its length is validated against the store's own range.
Stores can be added to a researched batch (Product → „Добави магазини“): saved research and the stored
original picture are reused, only the texts are paid (≈ $0.01 per text), and facts a person decided (EAN,
vendor, gender…) are carried over to the new stores.


## 19. Prices outside the euro

A price is always in the store's currency. To avoid typing a euro amount into a CZK/HUF/PLN/USD/CAD store, the
product screen takes one price in euros and fills every store by the ECB daily reference rate, rounded the way
the store writes its prices (whole tens for CZK, hundreds for HUF, else the store's usual cents). Every price in
another currency shows its euro equivalent. Publishing skips a store whose price in euros is more than 3× away
from the product's other stores ("провери валутата").


## 20. One product list across stores; plainer words

The start page is „Продукти“: every product of every store in one list, one row per EAN (without an EAN, the same
title in two stores is one row), searched by name or EAN. A store's copy comes from its latest catalog check (it is
live there) or from an import (prepared here); the catalog check wins for the same store, since it is what the
store shows. Each store is a square: на живо, има промени за качване (fixes or edits not yet sent), готов, не е
качен, нужна е намеса (something blocked), няма го. A row opens the product, a square opens that store's copy, and
the product screen shows the same squares. The list is rebuilt only when products, fields or uploads change.
Words: „партида“ is gone from the main path (imports are „внос“, under „История на вноса“), the audit is
„проверка на каталога“, statuses read „провери“, „поправено автоматично“, „липсва или е грешно“, and the
compare-at price is „стара цена“. Live Shopify sync, the quick new product and one-click publishing follow.


## 21. Products read live from Shopify

A store with a learned template and Shopify access has its products read straight from Shopify (all but archived,
25 per call with their custom metafields), shaped like an export and checked by the same rules, so the result is
the same as uploading a CSV. It runs every 6 hours by itself (`SYNC_HOURS`, 0 = off; the first round 10 minutes
after a start) and on „Изтегли“ (one store) or „Изтегли от магазините“ (all). Each read replaces the store's older
catalog check. What was made here and is not in the store yet (a person's edit or decision, an AI suggestion, a
picture or text taken from another store) is carried onto the same product (same handle) with the store's value
as `previous`, so it still shows as waiting to go live; pictures move with it. The Shopify product id is kept
for the later publishing. A store needs one export upload only to learn its template.


## 22. The quick new product

„Нов продукт“ asks only for what a person knows: the product with its volume (and TESTER), the EAN if known and
the price and the old price in euros, for one product or one per line („Име; EAN; цена; стара цена“, or columns
pasted from Excel). The free check shows how each line is read, what is missing (the volume; an old price not
above the price), the expected cost, and when a product with that EAN is already in a store, with a link to
it instead of creating it again. „Създай“ runs the names mode of a new batch with fast texts in the stores of
one group with a template (all of them by default), then sets every store's price from the euro price (ECB rate,
the store's rounding, decisions #19); a price that cannot be set is reported, the product is saved either way.
When done the product opens. The table/CSV form with deep research stays under „Таблица, CSV или задълбочено
проучване“. A Shopify read is now one transaction (save, carry over, remove the older read), so a restart in the
middle leaves the store as it was.


## 23. AI and links for flagged fields too, and for one field

„Попълни с AI“ now also takes fields a rule flagged (warning: a too short description, notes in the wrong
script…), not only empty or blocked ones, and works on a store's catalog products as well as new ones. A field's
panel offers it for that one field: facts from a link or a short search, a description written again from the
product's facts in each store's template (≈ $0.01 per store), even when the field looks fine. On a live product
the store's value stays the reference (`previous`), so the result shows as a change waiting to go live.


## 24. A store's own products: name and concentration from the title

A product read from a store (export or Shopify) has a title and a vendor but no name or concentration field, so
writing its description again said „липсва име на аромата“. The name, the concentration (EDP → Eau de Parfum) and
the tester marker are now read from the title for the description; notes without an English reference are given
in the store's language.


## 25. „Качи в магазините“: one button per product

The product screen has one primary action. It lists every store of the product's group: a store whose copy is
live gets only its changed fields written (db.live.push); a copy prepared here is created in the store (active or
draft); a store without the product can have it made like a quick new product (research reused by EAN when
known, the store's own text, the price from the euro price of a store that has it), then reviewed and sent from
the same button; what waits on a person (a suggestion to accept, a missing field) is named per store with a link
to that copy. „Одобри продукта“ and the upload screen leave the product's path. An AI suggestion goes live only
once accepted (CLAUDE.md #8), also on live products. After a live push the pushed values are the store's values
(`previous`), so a later edit shows again as waiting.


## 26. A missing store is made from the live copies, not researched again

When a product is already live in other stores, making it for a store that lacks it („Качи в магазините“ →
„Няма го в магазина: създай го“) reads those copies instead of researching the web: one small call turns their
facts (each in its store's language) into the canonical English facts with each store page as a source
(`pipeline.unify`), saved as the product's research. A fact two stores state alike is `ok` (two independent
sources, SPEC §3), a fact from one store is a suggestion, nothing absent from every copy is added. The picture is
taken from a live copy and composed for the store; the text is written by the store's template; the price comes
from the euro price of a live copy. A product live nowhere is still researched as a new one.


## 27. Deleting a product prepared here

„Изтрий“ on a new product removes it with all its store copies, and its import when it was the last product. Only
a product prepared here and in no store yet: a store's catalog product, or one already sent to a store, is
refused with what to do (delete it in Shopify first), so nothing in a store loses its link to the app.


## 28. Sending a store accepts its suggestions

Picking a store in „Качи в магазините“ is the person's acceptance of that store's AI suggestions (CLAUDE.md #8
holds: a person decides, now with one click per store instead of one per field): they are accepted, then the
store is sent. A blocked field still keeps its store back, named with a link. „Приеми всички предложения“ in the
product header does the same for every store without sending.


## 29. A change is a change of content

A store's description comes back from Shopify with its own markup, and a price as „124.00“ where the app wrote
„124“, so a product already sent kept showing a change to send. Values are compared as the shopper sees them:
without HTML tags, entities and extra spacing, numbers by value (db.live.same), everywhere a change is judged
(the product list, the send plan, a live push, a Shopify read).


## 30. Less memory for several new products at once

Several new products at once restarted the server (512 MB): every picture candidate of every product kept its
bytes until the batch ended, and ten products were composed at a time. Now only the picture that will be used
keeps its bytes, pictures are composed two at a time, and the automatic Shopify read waits while an AI job runs.


## 31. „Снимките ще ги кача сам“

A new product can be made without pictures: no picture is searched, downloaded or composed (less cost, time and
memory). The picture field then asks for one (blocked until it is there, so nothing goes live without a picture);
uploading a file or a link in it composes the picture for every store's layout as before. The choice is
remembered in the browser.


## 32. The SKU is the team's own code

The SKU is an internal code the team decides. Nothing rewrites it (a new EAN no longer rebuilds it in any store)
and nothing judges it against the EAN (the „SKU не съвпада с EAN“ block is gone). A new product starts with the
group's formula (SK{ean}) as its first value; a product without an SKU gets that code offered as a choice, never
written by itself. The EAN is still checked (check digit, length), and a product without an EAN of its own has
it read from an SKU that follows the formula, as older exports do.


## 33. A finished picture goes as it is; smaller pictures for the cut-out

A picture uploaded with „Готова снимка: качи я както е“ (its own background, badges such as „15 ML“) is stored
and used in every store as it is: nothing is cut out or composed, which also keeps the background-removal model
out of memory. Pictures that are cut out are first shrunk to 1600 px on the long side (the model works at
320 px; a 4000 px photo only cost memory and restarted the 512 MB server).


## 34. „Пренеси към всички“: one right store to every other

On a product with several stores, a person picks the store that is right. Brand, name, concentration, gender,
family and ingredients are copied to every other store as decided, the notes are translated into each store's
language (their English names come from the source, read from its own language when it has none), and every other
store's description and SEO text is written again from these facts in its own template, as suggestions (a wrong
language or a too short text included). The source store is not changed. ≈ $0.01 per store.


## 35. A new SKU goes live; the store's value stays the reference

A product read from Shopify is known by its Shopify id, so a live update now checks that id instead of the SKU,
and a new SKU (the team's own code) is simply sent. Without an id (a product from an uploaded export) the SKU
still tells that the handle is the same product. Edits on a store's own product keep the store's value as
`previous` however many times a field is changed, so the change and the product's identity stay right.


## 36. Products are linked by the team's SKU; a store catalog opens one product at a time

The product list linked store copies by EAN, but a 15 ml decant often carries the full bottle's EAN, so a decant
showed the 80 ml bottle of other stores as the same product. Copies are now linked by the SKU first (the team's
own code), counting both the SKU set here and the one the store still shows, so a product stays linked while a
new SKU reaches the stores one by one; then by the same EAN with the same volume; then, for a copy without an
EAN, by the same title. Two copies of one store are never joined.
Opening a product of a store's catalog loaded the whole catalog with every field (hundreds of products), which
ran the 512 MB server out of memory: now only the open product comes with its fields, the list beside it with
titles and status counts.


## 37. „Провери в магазина“: one product read again from Shopify

A store's product can be read again from Shopify alone (by its Shopify id, else its handle) and checked by the
store's rules. The store's values become the reference; what a person or the AI set here that the store does not
show is kept and shows again as a change to send; every other field takes the store's value. This is the answer
when the app says a change is live and the store disagrees (an earlier push that did not land, an edit in Shopify).


## 38. A prepared copy and its live copy are one row; one placeholder EAN, several brands

The rule that never joins two copies of one store also kept a product prepared here apart from the same product
read back from the store, so a decant fell apart into a row per store. Now only two products both live in one
store are kept apart; a prepared copy joins its live copy (the store's wins in the row). Placeholder EANs
(5901234000002) are used for several decants, so an EAN or a title links only copies of the same brand (the
title's first word); the SKU, the team's own code, links as it is.


## 39. A picture sent to a live product replaces its main picture

Sending a new picture to a product already in a store added it at the end, so the old main picture stayed first
and every send added another copy. Now the new picture is put first, and the main picture it replaces, plus any
earlier picture this app put there (marked by its alt text), is taken off the product; the files stay in Shopify →
Content → Files, and the gallery pictures behind the main one are kept. A step Shopify refuses is reported.


## 40. One linking rule: codes link, identity decides

Replaces the linking rules of #36 and #38. Store copies link through any code they share: the SKU (here and as the
store still shows it), the EAN (likewise) or the exact title. But no code ever joins two copies whose brand (the
title's first word), volume or tester marker differ: placeholder codes such as 5901234000002 sit as SKU and EAN on
several decants, and a shared SKU had folded a Carolina Herrera decant into a Chanel one. Two products both live in
one store stay apart (a store can hold duplicates); a copy prepared here joins its live copy. On the two full
group-1 catalogs: 844 products linked across both stores, 28 in one, no wrong joins.


## 41. „Изравни и качи“: the open store's copy to every chosen store

„Качи в магазините“ now offers (ticked by default when the product is in other stores) to make the chosen stores'
copies like the open one before sending: brand, name, concentration, gender, family and ingredients copied, notes
translated, description and SEO written again in each store's template, and the open copy's picture copied when it
differs (a finished picture as it is, else its original composed for the store's layout). It runs as a job; each
store's value stays as `previous`, then the stores are sent as before (their suggestions accepted). Stores without
the product are then made from the live copies.


## 42. A store's catalog is one batch, updated in place

Each Shopify read saved the catalog as a new batch and removed the old one, so every read (every 6 hours and after
each deploy) gave every product a new id and broke open pages and links („Няма партида 141“). Now a store's
catalog is one batch kept for good: a read matches each product by its Shopify id (else its handle) and updates it
in place, with the same rules as before (what was set here and is not in the store stays waiting; the rest takes
the store's value), adds new products and removes those the store no longer has. Older extra batches of the store
are removed on the next read. A link from before this change says it is stale and leads to the product list.


## 43. No background-removal model on the 512 MB server

Measured: importing rembg takes ~210 MB and cutting one 1600 px picture peaks at ~830 MB (u2net or u2netp alike;
~480 MB with a lean onnxruntime setup). On the 512 MB Render plan every scene picture that needed the model
restarted the server (502). The model is now off by default (`REMBG_ENABLED`): flat and transparent backgrounds
are still cut out without it (most packshots), a scene is placed whole on the store's background. With a 2 GB plan
set REMBG_ENABLED=1; it then runs the small u2netp model with the lean settings.


## 44. The app never waits for the whole list again

Every edit changes the data the product list is built from, and the next page then waited while the list of
every store (about 9000 products) was built again: slow pages, the stores of a product missing at the top for a
while. The app now gets the last built list at once and a new one is built in the background; a product the last
list does not have yet is looked up in a fresh build. Code (send, publish) still uses a fresh list. Moving from one
product to another no longer shows the new product with empty fields while its data loads.


## 45. Pouring one store into the others carries the SKU and EAN

„Изравни“ and „Пренеси към всички“ copied brand, name, concentration, gender, family, ingredients, notes and texts
but not the codes, so a new SKU set in one store did not reach the others. Pouring one store into the others is
the person saying that store is right, codes included: the SKU and EAN now go too, with each store's old code as
`previous` (so the product stays linked until the new code is live everywhere, #40).


## 46. A linked page that refuses to open: the same perfume is searched

Fragrantica (and other perfume sites) refuse automated visits, so „Попълни с AI“ with a Fragrantica link found
no notes. With a link the AI now also has web search: when the page does not open or does not show a fact, it
searches that perfume by the name in the page address (Fragrantica in the results, Parfumo, Notino) and takes the
fact from the results with them as sources; still nothing from memory.


## 47. Empty SEO title, volume and type come from the title

A store product with an empty SEO title, volume (custom.product_milliliters) or type (custom.product_type) gets it
from its title by the group's own formulas (SEO title = the title; „15 ml“; EDP/EDT/EDC or the concentration as
written) as an automatic fix, sent with the rest. Values the store has are never replaced, and a field the store
does not use is not added. It applies to a product when its store is read again (Shopify read or „Провери в
магазина“).


## 48. Stores are connected from the app, nothing uploaded

„Добави магазин“ and „Свържи“ ask only for the Shopify address and the app's access (and, for a new store, its
name, group, country, language and currency). The access is saved encrypted and checked, the products are read
from Shopify and the store's template is learned from them exactly as from an export; the person checks the
proposed template and accepts it, which saves the products as the store's one catalog (in place when it has one,
#42, now also on accepting a template learned again). The last read shown per store is the time of the last
read, not of the catalog's first save. A store of a group without its structure (group 2 today) can be connected,
but its template is accepted only once the group has one.


## 49. Groups made and learned in the app

Groups and a group's structure no longer need files in the repository. „Нова група“ makes the next group
(group-3, group-4…) on the persistent disk (MEDIA_DIR/groups); its stores are connected into it from the app. A
group without a structure (group 2, a new group) learns it from its connected stores' products with „Научи
структурата“ (the largest three; group.yaml, vocab.yaml, import template, a description guide started from group
1's and group 1's picture layout to begin with), the same derivation as scripts/new_group.py
(pipeline.newgroup). A group.yaml in the repository still wins over a learned one. Then the stores' templates are
accepted as usual.


## 50. A product made in another group's stores

„Качи в магазините“ offers every store that does not have the product and whose group has a structure, not only
stores of the product's own group. They are made like „Създай го“ (decisions #46): the facts come from the live
copies (no new web research when there are any), read into the target group's vocabulary (its genders and
families), the texts and title by each store's own template, the price from the euro price. One quick product
job per group; the next group's job starts when the previous one ends, so only one AI job runs at a time.

Later: the structure is learned on its own. „Запази шаблона“ on a store of a group with no structure asks for at
least two connected stores of that group (one store is too little to tell the group's rules from the store's);
with the second, it learns the structure from them and accepts, with no separate step.

Later: making and sending is one job. The dialog's job makes the product per group (each a quick product job
started beside it), waits for it, accepts its suggestions and sends it, so the result per store shows in the
dialog: created and uploading, waiting on a missing field, or why it was not made. Before, the product was made
after the dialog had said „Готово“, its outcome not shown, and it waited unsent.
