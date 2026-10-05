"""GTIN checksum (EAN-8, UPC-A/EAN-12, EAN-13, GTIN-14). The AI never guesses an EAN; code only checks it."""

VALID_LENGTHS = (8, 12, 13, 14)


def clean(raw: str | None) -> str:
    """Strip the spreadsheet artifacts seen in exports: leading apostrophe, spaces, '.0'."""
    s = (raw or "").strip().lstrip("'").strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def is_valid(code: str | None) -> bool:
    if not code or not code.isdigit() or len(code) not in VALID_LENGTHS:
        return False
    digits = [int(c) for c in code]
    body, check = digits[:-1], digits[-1]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def problem(raw: str | None) -> str | None:
    """Bulgarian message explaining why the EAN is unusable, or None when it is valid."""
    code = clean(raw)
    if not code:
        return "Липсва EAN."
    if not code.isdigit():
        return f"EAN „{code}“ съдържа символи, които не са цифри."
    if len(code) not in VALID_LENGTHS:
        return f"EAN „{code}“ е с {len(code)} цифри; очакват се 8, 12, 13 или 14."
    if not is_valid(code):
        return f"EAN „{code}“ е с грешна контролна цифра. Провери го от опаковката."
    return None
