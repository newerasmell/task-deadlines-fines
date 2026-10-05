"""Shopify market names as they appear in export columns ("Price / Greece") -> country and currency."""

MARKETS: dict[str, tuple[str, str]] = {
    "Greece": ("GR", "EUR"),
    "Cyprus": ("CY", "EUR"),
    "Bulgaria": ("BG", "EUR"),
    "Croatia": ("HR", "EUR"),
    "Slovenia": ("SI", "EUR"),
    "Slovakia": ("SK", "EUR"),
    "Estonia": ("EE", "EUR"),
    "Latvia": ("LV", "EUR"),
    "Lithuania": ("LT", "EUR"),
    "Germany": ("DE", "EUR"),
    "Austria": ("AT", "EUR"),
    "Romania": ("RO", "RON"),
    "Czechia": ("CZ", "CZK"),
    "Czech Republic": ("CZ", "CZK"),
    "Hungary": ("HU", "HUF"),
    "Poland": ("PL", "PLN"),
    "United States": ("US", "USD"),
    "Canada": ("CA", "CAD"),
    "United Kingdom": ("GB", "GBP"),
}
