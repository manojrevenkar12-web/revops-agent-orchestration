"""HTTP API of the agent service (Cloud Run). Called only by the orchestrator's job workers, with a service token.

uvicorn revops_agent.app:app --port 9500
"""

from __future__ import annotations

import json
import os
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from .config import provider_mode
from .providers.base import BudgetExceeded, ModelUnavailable
from .schemas import (
    ClassifyRequest,
    ClassifyResponse,
    DraftRequest,
    RenewalNextRequest,
    RenewalNextResponse,
    VerifyRequest,
)
from .tasks import PROMPT_VERSION, build_service

REQUESTS = Counter("agent_requests_total", "Agent service requests", ["task", "outcome"])
LATENCY = Histogram("agent_request_seconds", "Agent service latency", ["task"])
TOKENS = Counter("agent_tokens_total", "Model tokens", ["task", "direction"])

# AGENT_FAULTS (evaluation only) makes the simulated provider misbehave, e.g. {"fabricate": 0.2}.
service = build_service(json.loads(os.environ.get("AGENT_FAULTS") or "{}") or None)
app = FastAPI(title="RevOps agent service", version=PROMPT_VERSION)


def authorise(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("AGENT_SERVICE_TOKEN", "dev-agent-token")
    if authorization != f"Bearer {token}":
        raise HTTPException(401, "missing or wrong service token")


@app.exception_handler(ModelUnavailable)
async def unavailable(_: Request, e: ModelUnavailable) -> JSONResponse:
    return JSONResponse({"code": "MODEL_UNAVAILABLE", "message": str(e)}, status_code=503)


@app.exception_handler(BudgetExceeded)
async def budget(_: Request, e: BudgetExceeded) -> JSONResponse:
    return JSONResponse({"code": "BUDGET_EXCEEDED", "message": str(e)}, status_code=429, headers={"retry-after": "900"})


def _track(task: str, t0: float, usage: dict | None = None, outcome: str = "ok") -> None:
    REQUESTS.labels(task, outcome).inc()
    LATENCY.labels(task).observe(time.monotonic() - t0)
    if usage:
        TOKENS.labels(task, "input").inc(usage.get("inputTokens", 0))
        TOKENS.labels(task, "output").inc(usage.get("outputTokens", 0))


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "provider": provider_mode(),
        "promptVersion": PROMPT_VERSION,
        "breakers": service.chain.status(),
        "counters": service.counters,
    }


@app.get("/metrics")
def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest().decode(), media_type=CONTENT_TYPE_LATEST)


@app.post("/v1/lead/classify", response_model=ClassifyResponse, dependencies=[Depends(authorise)])
def classify(req: ClassifyRequest) -> dict:
    t0 = time.monotonic()
    out = service.classify(req.submission)
    _track("lead.classify", t0, out["usage"])
    return out


@app.post("/v1/renewal/next", response_model=RenewalNextResponse, dependencies=[Depends(authorise)])
def renewal_next(req: RenewalNextRequest) -> dict:
    t0 = time.monotonic()
    out = service.renewal_next(req.context, req.tools, req.results, req.state)
    _track("renewal.investigate", t0, out["stats"], out["action"])
    return out


@app.post("/v1/brief/verify", dependencies=[Depends(authorise)])
def verify(req: VerifyRequest) -> dict:
    t0 = time.monotonic()
    out = service.verify(req.brief, req.evidence)
    _track("brief.verify", t0, None, "grounded" if out["grounded"] else "ungrounded")
    return out


@app.post("/v1/dealreg/draft", dependencies=[Depends(authorise)])
def draft(req: DraftRequest) -> dict:
    t0 = time.monotonic()
    out = service.draft(req.model_dump())
    _track("dealreg.draft", t0, out["usage"], "withheld" if out["withheld"] else "ok")
    return out
