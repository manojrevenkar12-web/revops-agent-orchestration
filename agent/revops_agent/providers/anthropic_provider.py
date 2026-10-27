"""Claude through the Anthropic API and through Vertex AI (the GCP route: billing and data residency stay in the
company's GCP project). Both speak the Messages API; only the client differs."""

from __future__ import annotations

import os
import time
from typing import Any

import anthropic

from .base import ModelCall, ModelResult, TransientProviderError

TRANSIENT_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}


def _blocks(content: Any) -> list[dict[str, Any]]:
    out = []
    for b in content:
        d = b.model_dump() if hasattr(b, "model_dump") else dict(b)
        out.append({k: v for k, v in d.items() if k in ("type", "text", "id", "name", "input")})
    return out


class _MessagesProvider:
    name = "anthropic"
    client: Any

    def create(self, call: ModelCall) -> ModelResult:
        kwargs: dict[str, Any] = {
            "model": call.model,
            "system": call.system,
            "messages": call.messages,
            "max_tokens": call.max_tokens,
        }
        if call.tools:
            kwargs["tools"] = call.tools
        if call.tool_choice:
            kwargs["tool_choice"] = call.tool_choice
        t0 = time.monotonic()
        try:
            r = self.client.messages.create(**kwargs)
        except anthropic.APIStatusError as e:
            if e.status_code in TRANSIENT_STATUS:
                raise TransientProviderError(f"HTTP {e.status_code}") from e
            raise
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            raise TransientProviderError(type(e).__name__) from e
        return ModelResult(
            content=_blocks(r.content),
            model=r.model,
            provider=self.name,
            input_tokens=r.usage.input_tokens,
            output_tokens=r.usage.output_tokens,
            latency_ms=int((time.monotonic() - t0) * 1000),
            stop_reason=r.stop_reason or "end_turn",
        )


class AnthropicProvider(_MessagesProvider):
    name = "anthropic"

    def __init__(self, cfg: dict[str, Any], timeout: float, http_client: Any = None):
        key = os.environ.get(cfg["api_key_env"])
        if not key:
            raise RuntimeError(f"{cfg['api_key_env']} is not set")
        self.client = anthropic.Anthropic(api_key=key, timeout=timeout, max_retries=0, http_client=http_client)


class VertexProvider(_MessagesProvider):
    name = "vertex"

    def __init__(self, cfg: dict[str, Any], timeout: float):
        project = os.environ.get(cfg["project_env"])
        if not project:
            raise RuntimeError(f"{cfg['project_env']} is not set")
        self.client = anthropic.AnthropicVertex(region=cfg["region"], project_id=project, timeout=timeout, max_retries=0)
