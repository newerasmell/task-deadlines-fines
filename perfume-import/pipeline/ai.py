"""One way to call Claude for the whole pipeline (research, generation, vocab/glossary suggestions).

Every call: Claude Sonnet 5.5 (cost target $0.125 per product, docs/decisions.md), effort per task, structured
JSON output, automatic prompt caching, and its cost recorded. Interactive calls stream, resume `pause_turn` and
use the server-side fallback on a refusal. Texts can go through the Message Batches API at half price
(`ask_batch`; batches do not accept `fallbacks`, so a refusal there just blocks the field).
Tests pass a fake client with the same `beta.messages.stream(...)` / `messages.batches` shape.
"""

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from pipeline.tiers import NO_THINKING, SONNET  # noqa: E402,F401  (NO_THINKING re-exported for callers)

MODEL = SONNET  # default when a caller does not pass one
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RESUMES = 5
BATCH_DISCOUNT = 0.5  # token prices in the Batches API; web searches are not discounted

# USD per million tokens: input, output, cache read, cache write (5-minute). Web search: per request.
PRICES = {
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
}
PRICE_WEB_SEARCH = 10.00 / 1000

# Default web tools (economy tier): search snippets only; reading whole pages was 95% of the first run's cost.
WEB_TOOLS = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}]


class AIError(Exception):
    """The model did not return a usable answer (refusal, truncation, invalid JSON)."""


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    web_searches: int = 0
    cost: float = 0.0  # priced when recorded, so model and batch discount are already applied

    def add(self, other: "Usage") -> None:
        for name in self.__dataclass_fields__:
            setattr(self, name, getattr(self, name) + getattr(other, name))

    @property
    def cost_usd(self) -> float:
        return round(self.cost, 4)

    def to_dict(self) -> dict:
        out = {k: getattr(self, k) for k in self.__dataclass_fields__ if k != "cost"}
        return {**out, "cost_usd": self.cost_usd}


def price(model: str, input_tokens=0, output_tokens=0, cache_read=0, cache_write=0, searches=0, batch=False) -> float:
    p_in, p_out, p_read, p_write = PRICES.get(model, PRICES[MODEL])
    tokens = (input_tokens * p_in + output_tokens * p_out + cache_read * p_read + cache_write * p_write) / 1e6
    return tokens * (BATCH_DISCOUNT if batch else 1) + searches * PRICE_WEB_SEARCH


@dataclass
class Result:
    data: Any
    usage: Usage
    model: str
    sources: list[dict] = field(default_factory=list)  # every URL web search/fetch returned


def _usage(message, batch: bool = False) -> Usage:
    u = message.usage
    server = getattr(u, "server_tool_use", None)
    usage = Usage(
        input_tokens=u.input_tokens or 0,
        output_tokens=u.output_tokens or 0,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
        web_searches=(getattr(server, "web_search_requests", 0) or 0) if server else 0,
    )
    usage.cost = price(
        getattr(message, "model", None) or MODEL,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
        usage.web_searches,
        batch,
    )
    return usage


def _sources(content) -> list[dict]:
    found = []
    for block in content:
        if block.type == "web_search_tool_result" and isinstance(block.content, list):
            found += [{"url": r.url, "title": getattr(r, "title", "")} for r in block.content]
        elif block.type == "web_fetch_tool_result" and getattr(block.content, "url", None):
            found.append({"url": block.content.url, "title": ""})
    return found


API_URL = "https://api.anthropic.com"


def default_client():
    """ANTHROPIC_API_KEY from the environment, never from the repo.

    The base URL is pinned: a host tool (e.g. a Claude Code session) may set ANTHROPIC_BASE_URL for itself, and
    the SDK would otherwise send our requests there. PERFUME_ANTHROPIC_BASE_URL overrides it deliberately."""
    import anthropic

    return anthropic.Anthropic(api_key=api_key(), base_url=os.environ.get("PERFUME_ANTHROPIC_BASE_URL", API_URL))


def api_key() -> str | None:
    """PERFUME_ANTHROPIC_API_KEY first: Claude Code cloud environments reserve the name ANTHROPIC_API_KEY and do
    not pass it to sessions. On Render either name works."""
    return os.environ.get("PERFUME_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or None


def ask(
    client,
    *,
    system: str,
    prompt: str,
    schema: dict,
    effort: str = "medium",
    web: bool = False,
    max_tokens: int = 32000,
    thinking: dict | None = None,
    model: str = MODEL,
    tools: list[dict] | None = None,
    budget: float | None = None,
) -> Result:
    """One structured answer. Raises AIError with a Bulgarian message the field can show.

    budget (USD): a paused server-tool turn is resumed only while the call has cost less than this."""
    import anthropic

    try:
        web_tools = (tools or WEB_TOOLS) if web else None
        return _ask(client, system, prompt, schema, effort, web_tools, max_tokens, thinking, model, budget)
    except anthropic.APIError as exc:
        # One product's API failure (400, overload, network) blocks that product, not the whole batch.
        raise AIError(f"Грешка от Claude API: {_api_detail(exc)}") from exc


def _api_detail(exc) -> str:
    detail = getattr(exc, "body", None)
    detail = detail.get("error", {}).get("message") if isinstance(detail, dict) else None
    return detail or str(exc)


def params(*, system, prompt, schema, effort, max_tokens, thinking=None, tools=None, model=MODEL) -> dict:
    """Request body shared by interactive calls and batch requests."""
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        "cache_control": {"type": "ephemeral"},  # same system prompt + schema for every product
    }
    if tools:
        body["tools"] = tools
    if thinking:
        body["thinking"] = thinking
    return body


def _ask(client, system, prompt, schema, effort, tools, max_tokens, thinking, model, budget=None) -> Result:
    body = params(
        system=system,
        prompt=prompt,
        schema=schema,
        effort=effort,
        max_tokens=max_tokens,
        thinking=thinking,
        tools=tools,
        model=model,
    )
    first_turn = body["messages"][0]
    usage, sources = Usage(), []
    for _ in range(MAX_RESUMES + 1):
        with client.beta.messages.stream(**body, betas=[FALLBACK_BETA], fallbacks="default") as stream:
            message = stream.get_final_message()
        usage.add(_usage(message))
        sources += _sources(message.content)
        if message.stop_reason != "pause_turn":
            break
        if budget is not None and usage.cost >= budget:
            raise AIError(f"Проучването спря: стигна тавана ${budget:.2f} на продукт ({usage.cost_usd:.3f}).")
        # Server tools hit their iteration limit: resend the paused turn and the server resumes it.
        body["messages"] = [first_turn, {"role": "assistant", "content": message.content}]
    else:
        raise AIError(f"Проучването не приключи след {MAX_RESUMES} продължения.")
    return _finish(message, usage, sources)


def _finish(message, usage: Usage, sources: list[dict]) -> Result:
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


def ask_batch(client, requests: dict[str, dict], poll_seconds: float = 15, timeout: float = 24 * 3600) -> dict:
    """Send `{custom_id: params(...)}` as one Message Batch at half price and wait for it.

    Returns `{custom_id: Result | AIError}`. Results arrive in any order and are matched by custom_id."""
    import anthropic

    if not requests:
        return {}
    try:
        batch = client.messages.batches.create(
            requests=[{"custom_id": cid, "params": body} for cid, body in requests.items()]
        )
        started = time.monotonic()
        while batch.processing_status != "ended":
            if time.monotonic() - started > timeout:
                raise AIError("Партидата към Claude не приключи навреме.")
            time.sleep(poll_seconds)
            batch = client.messages.batches.retrieve(batch.id)
        out: dict[str, Result | AIError] = {}
        for item in client.messages.batches.results(batch.id):
            result = item.result
            if result.type == "succeeded":
                try:
                    out[item.custom_id] = _finish(result.message, _usage(result.message, batch=True), [])
                except AIError as exc:
                    out[item.custom_id] = exc
            elif result.type == "errored":
                out[item.custom_id] = AIError(f"Грешка от Claude API: {getattr(result.error, 'type', 'error')}")
            else:
                out[item.custom_id] = AIError(f"Заявката в партидата е {result.type}. Пусни отново.")
    except anthropic.APIError as exc:
        error = AIError(f"Грешка от Claude API: {_api_detail(exc)}")
        return {cid: error for cid in requests}
    missing = AIError("Липсва резултат в партидата.")
    return {cid: out.get(cid, missing) for cid in requests}
