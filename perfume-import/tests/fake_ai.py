"""A stand-in for anthropic.Anthropic with the same beta.messages.stream(...) shape. No network, no cost."""

import json
from contextlib import contextmanager
from types import SimpleNamespace as NS


def usage(input_tokens=1000, output_tokens=500, searches=0):
    return NS(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=0,
        server_tool_use=NS(web_search_requests=searches, web_fetch_requests=0),
    )


def message(data=None, *, stop_reason="end_turn", urls=(), searches=0, text=None, category=None):
    content = []
    if urls:
        results = [NS(type="web_search_result", url=u, title="") for u in urls]
        content.append(NS(type="web_search_tool_result", content=results))
    if stop_reason != "pause_turn":
        content.append(NS(type="text", text=text if text is not None else json.dumps(data)))
    return NS(
        content=content,
        stop_reason=stop_reason,
        stop_details=NS(category=category) if category else None,
        usage=usage(searches=searches),
        model="claude-sonnet-5-5",
    )


class FakeClient:
    """Returns the queued messages in order; `responder(kwargs)` can build one from the request instead.

    Message Batches: every request in a batch is answered the same way and lands in `calls` too;
    `batches` records the custom_ids of each batch sent."""

    def __init__(self, *messages, responder=None):
        self.queue = list(messages)
        self.responder = responder
        self.calls: list[dict] = []
        self.batches: list[list[str]] = []
        self._results: dict[str, list] = {}
        self.beta = NS(messages=NS(stream=self._stream))
        self.messages = NS(batches=NS(create=self._create, retrieve=self._retrieve, results=self._batch_results))

    def _answer(self, kwargs):
        self.calls.append(kwargs)
        return self.responder(kwargs) if self.responder else self.queue.pop(0)

    def _create(self, requests):
        batch_id = f"batch_{len(self.batches)}"
        self.batches.append([r["custom_id"] for r in requests])
        self._results[batch_id] = [
            NS(custom_id=r["custom_id"], result=NS(type="succeeded", message=self._answer(r["params"])))
            for r in requests
        ]
        return NS(id=batch_id, processing_status="in_progress")

    def _retrieve(self, batch_id):
        return NS(id=batch_id, processing_status="ended")

    def _batch_results(self, batch_id):
        return list(reversed(self._results[batch_id]))  # any order, matched by custom_id

    @contextmanager
    def _stream(self, **kwargs):
        msg = self._answer(kwargs)
        yield NS(get_final_message=lambda: msg)
