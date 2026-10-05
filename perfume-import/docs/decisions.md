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
