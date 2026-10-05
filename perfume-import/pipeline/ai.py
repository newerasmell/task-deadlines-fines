"""One way to call Claude for the whole pipeline (research, generation, vocab/glossary suggestions).

Every call: Claude Opus 5.5, adaptive thinking (always on for this model), effort per task, streaming,
server-side fallback on a refusal, structured JSON output, `pause_turn` resumed, and its cost recorded.
Tests pass a fake client with the same `beta.messages.stream(...)` shape.
"""

import json
from dataclasses import dataclass, field
from typing import Any

MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RESUMES = 5

# USD per million tokens (Claude Opus 5.5) and per web search.
PRICE_INPUT = 4.00
PRICE_OUTPUT = 20.00
PRICE_CACHE_READ = 0.20
PRICE_CACHE_WRITE = 5.00
PRICE_WEB_SEARCH = 10.00 / 1000

WEB_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 8},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 8},
]


class AIError(Exception):
    """The model did not return a usable answer (refusal, truncation, invalid JSON)."""


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    web_searches: int = 0

    def add(self, other: "Usage") -> None:
        for name in self.__dataclass_fields__:
            setattr(self, name, getattr(self, name) + getattr(other, name))

    @property
    def cost_usd(self) -> float:
        return round(
            self.input_tokens / 1e6 * PRICE_INPUT
            + self.output_tokens / 1e6 * PRICE_OUTPUT
            + self.cache_read_tokens / 1e6 * PRICE_CACHE_READ
            + self.cache_write_tokens / 1e6 * PRICE_CACHE_WRITE
            + self.web_searches * PRICE_WEB_SEARCH,
            4,
        )

    def to_dict(self) -> dict:
        return {**{k: getattr(self, k) for k in self.__dataclass_fields__}, "cost_usd": self.cost_usd}


@dataclass
class Result:
    data: Any
    usage: Usage
    model: str
    sources: list[dict] = field(default_factory=list)  # every URL web search/fetch returned


def _usage(message) -> Usage:
    u = message.usage
    server = getattr(u, "server_tool_use", None)
    return Usage(
        input_tokens=u.input_tokens or 0,
        output_tokens=u.output_tokens or 0,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
        web_searches=(getattr(server, "web_search_requests", 0) or 0) if server else 0,
    )


def _sources(content) -> list[dict]:
    found = []
    for block in content:
        if block.type == "web_search_tool_result" and isinstance(block.content, list):
            found += [{"url": r.url, "title": getattr(r, "title", "")} for r in block.content]
        elif block.type == "web_fetch_tool_result" and getattr(block.content, "url", None):
            found.append({"url": block.content.url, "title": ""})
    return found


def default_client():
    import anthropic

    return anthropic.Anthropic()  # ANTHROPIC_API_KEY from the environment, never from the repo


def ask(
    client,
    *,
    system: str,
    prompt: str,
    schema: dict,
    effort: str = "medium",
    web: bool = False,
    max_tokens: int = 32000,
) -> Result:
    """One structured answer. Raises AIError with a Bulgarian message the field can show."""
    messages: list[dict] = [{"role": "user", "content": prompt}]
    usage, sources = Usage(), []
    for _ in range(MAX_RESUMES + 1):
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            tools=WEB_TOOLS if web else [],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        ) as stream:
            message = stream.get_final_message()
        usage.add(_usage(message))
        sources += _sources(message.content)
        if message.stop_reason != "pause_turn":
            break
        # Server tools hit their iteration limit: resend the paused turn and the server resumes it.
        messages = [messages[0], {"role": "assistant", "content": message.content}]
    else:
        raise AIError(f"Проучването не приключи след {MAX_RESUMES} продължения.")

    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None) if details else None
        raise AIError(f"Моделът отказа заявката (категория: {category or 'неизвестна'}). Попълни полето ръчно.")
    if message.stop_reason == "max_tokens":
        raise AIError("Отговорът беше прекъснат (max_tokens). Опитай отново.")
    text = next((b.text for b in message.content if b.type == "text" and b.text.strip()), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise AIError("Моделът върна невалиден JSON. Опитай отново.") from exc
    return Result(data=data, usage=usage, model=getattr(message, "model", MODEL), sources=sources)
