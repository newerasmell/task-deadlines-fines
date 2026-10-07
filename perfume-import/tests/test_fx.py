"""Prices outside the euro: ECB rates, the store's rounding, and a typed-in-the-wrong-currency guard."""

from pipeline import fx


def test_rates_and_rounding():
    date, table = fx.rates()
    assert date == "2026-10-06" and table["EUR"] == 1.0 and table["CZK"] == 24.405
    assert fx.convert(74, "CZK", table) == "1810"  # 1805.97 -> whole tens
    assert fx.convert(74, "HUF", table) == "27000"  # 27006 -> whole hundreds
    assert fx.convert(74, "PLN", table, "99") == "322.99"  # 323.01 -> the store's .99
    assert fx.convert(74, "EUR", table, "00") == "74"


def test_a_price_in_the_wrong_currency_is_caught():
    _, table = fx.rates()
    eur = {"premier": 74.0, "parfemija": 74.0, "parfem4u": fx.to_eur(74, "CZK", table)}
    wrong = fx.suspicious(eur)
    assert list(wrong) == ["parfem4u"] and "провери валутата" in wrong["parfem4u"]
    eur["parfem4u"] = fx.to_eur(1810, "CZK", table)
    assert fx.suspicious(eur) == {}
