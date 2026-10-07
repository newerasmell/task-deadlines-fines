"""Exchange rates and price conversion for stores outside the euro (SPEC: prices per store, in its currency).

Rates are the European Central Bank's daily reference rates (1 EUR = x), fetched at most every 6 hours; when
the ECB cannot be reached the last rates are used, and without any the app says so (no conversion is guessed).
A converted price is rounded the way the store rounds its own prices (profile item price_rounding), with whole
tens or hundreds for currencies with small units.
"""

import math
import re
import threading
import time

import httpx

ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
MAX_AGE = 6 * 3600
# Currencies whose prices are written in whole tens / hundreds (1 CZK ≈ 0.04 EUR, 1 HUF ≈ 0.003 EUR).
STEP = {"CZK": 10, "HUF": 100, "ISK": 100, "JPY": 100, "KRW": 1000}
# Prices more than this factor away (in euros) from the product's other stores are treated as a wrong currency.
SUSPICIOUS = 3.0

_cache: dict = {"at": 0.0, "date": None, "rates": {}}
_lock = threading.Lock()


class FxError(Exception):
    """Bulgarian message."""


def rates(fetch=None) -> tuple[str | None, dict[str, float]]:
    """(date, {currency: units per 1 EUR}) with EUR = 1."""
    with _lock:
        if time.time() - _cache["at"] < MAX_AGE and _cache["rates"]:
            return _cache["date"], dict(_cache["rates"])
        try:
            xml = (fetch or _fetch)()
            found = {c: float(r) for c, r in re.findall(r"currency='([A-Z]{3})' rate='([0-9.]+)'", xml)}
            date = (re.search(r"time='(\d{4}-\d{2}-\d{2})'", xml) or [None, None])[1]
            if found:
                _cache.update({"at": time.time(), "date": date, "rates": {"EUR": 1.0, **found}})
        except Exception:  # keep the last rates; none yet -> empty
            pass
        return _cache["date"], dict(_cache["rates"])


def _fetch() -> str:
    response = httpx.get(ECB_URL, timeout=10)
    response.raise_for_status()
    return response.text


def round_price(value: float, currency: str, cents: str | None = None) -> str:
    """The store's way of writing prices: whole tens/hundreds for small units, else its usual cents."""
    step = STEP.get(currency)
    if step:
        return str(int(max(step, round(value / step) * step)))
    if cents and re.fullmatch(r"\d{2}", cents) and cents != "00":
        whole = math.floor(value)
        # the nearest price with the store's ending: 323.01 with .99 -> 322.99, 73.6 -> 73.99
        candidate = min((whole - 1 + int(cents) / 100, whole + int(cents) / 100), key=lambda c: abs(c - value))
        return f"{max(candidate, int(cents) / 100):.2f}"
    return str(int(round(value)))


def convert(amount_eur: float, currency: str, table: dict[str, float], cents: str | None = None) -> str:
    rate = table.get(currency)
    if rate is None:
        raise FxError(f"Няма курс за {currency}.")
    return round_price(amount_eur * rate, currency, cents)


def to_eur(amount: float, currency: str, table: dict[str, float]) -> float | None:
    rate = table.get(currency)
    return amount / rate if rate else None


def suspicious(prices_eur: dict[str, float]) -> dict[str, str]:
    """Stores whose price in euros is far from the product's median: probably typed in the wrong currency."""
    values = sorted(prices_eur.values())
    if len(values) < 2:
        return {}
    mid = values[len(values) // 2]
    out = {}
    for store, eur in prices_eur.items():
        if eur < mid / SUSPICIOUS or eur > mid * SUSPICIOUS:
            out[store] = f"цената ≈ €{eur:.2f}, а в другите магазини е около €{mid:.2f}: провери валутата"
    return out
