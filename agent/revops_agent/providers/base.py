"""The model interface the tasks use, and the chain that keeps the service answering when a provider does not.

A task builds one `ModelCall` (system prompt, messages, tools, forced tool for structured output). The chain tries
each provider in order, skips providers whose circuit breaker is open, counts tokens against the daily budget and
reports usage, latency and which provider answered. When every provider fails the task gets `ModelUnavailable`,
which the workers turn into a BPMN error so the process can route the work to a person.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class ModelCall:
    task: str  # "lead.classify", "renewal.investigate", "dealreg.draft"
    model: str
    system: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = field(default_factory=list)
    tool_choice: dict[str, Any] | None = None
    max_tokens: int = 1024


@dataclass
class ModelResult:
    content: list[dict[str, Any]]  # Anthropic content blocks: {"type": "text"} / {"type": "tool_use", ...}
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    stop_reason: str = "end_turn"

    def tool_uses(self) -> list[dict[str, Any]]:
        return [b for b in self.content if b.get("type") == "tool_use"]


class Provider(Protocol):
    name: str

    def create(self, call: ModelCall) -> ModelResult: ...


class ModelUnavailable(Exception):
    """No provider could answer. Workers turn this into the BPMN error MODEL_UNAVAILABLE."""


class BudgetExceeded(Exception):
    """The daily token budget is used up. Workers back off and retry later."""


class TransientProviderError(Exception):
    """Rate limit, overload, timeout or a 5xx: worth trying the next provider."""


class Breaker:
    def __init__(self, failures_to_open: int, open_seconds: float, clock=time.monotonic):
        self.failures_to_open = failures_to_open
        self.open_seconds = open_seconds
        self.clock = clock
        self.failures = 0
        self.opened_at: float | None = None

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        return self.clock() - self.opened_at >= self.open_seconds  # after the pause: half-open, one attempt decides

    def success(self) -> None:
        self.failures = 0
        self.opened_at = None

    def failure(self) -> None:
        self.failures += 1
        if self.failures >= self.failures_to_open:
            self.opened_at = self.clock()

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "closed"
        return "half-open" if self.allow() else "open"


class TokenBudget:
    def __init__(self, daily_tokens: int, clock=time.time):
        self.daily = daily_tokens
        self.clock = clock
        self.day = int(clock() // 86400)
        self.used = 0
        self.lock = threading.Lock()

    def check(self) -> None:
        with self.lock:
            self._roll()
            if self.used >= self.daily:
                raise BudgetExceeded(f"daily token budget of {self.daily} is used up")

    def add(self, tokens: int) -> None:
        with self.lock:
            self._roll()
            self.used += tokens

    def _roll(self) -> None:
        d = int(self.clock() // 86400)
        if d != self.day:
            self.day, self.used = d, 0


class ProviderChain:
    def __init__(self, providers: list[Provider], breaker_cfg: dict[str, Any], budget: TokenBudget):
        self.providers = providers
        self.breakers = {p.name: Breaker(breaker_cfg["failures_to_open"], breaker_cfg["open_seconds"]) for p in providers}
        self.budget = budget

    def create(self, call: ModelCall) -> ModelResult:
        self.budget.check()
        errors: list[str] = []
        for p in self.providers:
            b = self.breakers[p.name]
            if not b.allow():
                errors.append(f"{p.name}: circuit open")
                continue
            try:
                r = p.create(call)
            except TransientProviderError as e:
                b.failure()
                errors.append(f"{p.name}: {e}")
                continue
            b.success()
            self.budget.add(r.input_tokens + r.output_tokens)
            return r
        raise ModelUnavailable("; ".join(errors) or "no provider configured")

    def status(self) -> dict[str, str]:
        return {name: b.state for name, b in self.breakers.items()}
