"""Field record with provenance (SPEC §3). Nothing in the pipeline passes a bare value around."""

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Origin = Literal["input", "template", "vocab", "ai_research", "ai_generated", "auto_fix"]
Status = Literal["ok", "suggested", "fixed", "warning", "blocked"]

# Worst first; used to summarise a product or a store by its worst field.
SEVERITY: dict[str, int] = {"blocked": 4, "warning": 3, "suggested": 2, "fixed": 1, "ok": 0}


@dataclass
class Field:
    key: str
    value: Any
    origin: Origin
    status: Status
    confidence: float | None = None
    sources: list[dict] = field(default_factory=list)
    alternatives: list[Any] = field(default_factory=list)
    previous: Any = None
    value_en: str | None = None
    message: str | None = None
    rule: str | None = None  # which validation rule set this status; not persisted as a column
    decided_by: str | None = None
    decided_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    def fix(self, new_value: Any, message: str, rule: str) -> None:
        """auto_fix: keep the old value in `previous`, status fixed."""
        self.previous, self.value = self.value, new_value
        self.origin, self.status, self.message, self.rule = "auto_fix", "fixed", message, rule

    def flag(self, status: Status, message: str, rule: str) -> None:
        """Raise the status (never lower it) and record why."""
        if SEVERITY[status] >= SEVERITY[self.status]:
            self.status, self.message, self.rule = status, message, rule


def default_status(origin: Origin, *, agreeing_sources: int = 0, direct_vocab_match: bool = False) -> Status:
    """Status rules from SPEC §3."""
    if origin in ("input", "template"):
        return "ok"
    if origin == "vocab":
        return "ok" if direct_vocab_match else "suggested"
    if origin == "ai_research":
        return "ok" if agreeing_sources >= 2 else "suggested"
    if origin == "auto_fix":
        return "fixed"
    return "suggested"  # ai_generated until the group opts into auto-accept


def worst(fields: list[Field]) -> Status:
    return max((f.status for f in fields), key=SEVERITY.__getitem__, default="ok")
