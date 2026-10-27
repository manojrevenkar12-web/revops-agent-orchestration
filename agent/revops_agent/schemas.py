"""The structured outputs the models must return, and the service's request and response bodies."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Intent = Literal["demo_request", "pricing", "support_issue", "partnership", "job_application", "spam", "expansion"]


class LeadClassificationOut(BaseModel):
    """What the classifier tool must return."""

    intent: Intent
    urgency: Literal["high", "normal", "low"]
    persona: Literal["executive", "technical", "business", "procurement", "student"]
    language: Literal["en", "de", "other"]
    confidence: float = Field(ge=0, le=1, description="How sure you are that the intent is right, 0 to 1")
    rationale: str = Field(max_length=400)


class Claim(BaseModel):
    text: str = Field(min_length=5, max_length=400)
    cites: list[str] = Field(min_length=1, description="Fact ids from account_360 or passage ids from the playbooks")


class Play(BaseModel):
    passageId: str
    title: str = Field(max_length=120)
    why: str = Field(max_length=400)


class BriefOut(BaseModel):
    summary: str = Field(max_length=600)
    atRisk: bool
    claims: list[Claim] = Field(min_length=1, max_length=8)
    recommendedPlay: Play | None = None
    nextSteps: list[str] = Field(default_factory=list, max_length=4)


class PartnerMessageOut(BaseModel):
    partnerMessage: str = Field(min_length=20, max_length=1200)
    internalNote: str = Field(max_length=800)
    citations: list[str] = Field(default_factory=list)


# ---- service API ---------------------------------------------------------------------------------------------------


class Usage(BaseModel):
    provider: str
    model: str
    inputTokens: int
    outputTokens: int
    latencyMs: int
    costUsd: float | None = None
    repairs: int = 0


class ClassifyRequest(BaseModel):
    submission: dict[str, Any]
    lead: dict[str, Any] = Field(default_factory=dict)


class ClassifyResponse(BaseModel):
    intent: str
    urgency: str
    persona: str
    language: str
    injectionSuspected: bool
    injectionSignals: list[str]
    confidence: float  # calibrated P(intent is right); 0 when no calibration exists for the model
    calibrated: bool
    rawConfidence: float
    rationale: str
    source: str
    promptVersion: str
    usage: Usage


class RenewalNextRequest(BaseModel):
    context: dict[str, Any]
    tools: list[dict[str, Any]]
    results: list[dict[str, Any]] = Field(default_factory=list)
    state: dict[str, Any] | None = None


class ToolCall(BaseModel):
    id: str
    elementId: str
    arguments: dict[str, Any]


class RenewalNextResponse(BaseModel):
    action: Literal["call_tools", "finish", "give_up"]
    toolCalls: list[ToolCall] = Field(default_factory=list)
    brief: dict[str, Any] | None = None
    reason: str | None = None
    state: dict[str, Any]
    stats: dict[str, Any]


class VerifyRequest(BaseModel):
    brief: dict[str, Any] | None
    evidence: list[dict[str, Any]] = Field(default_factory=list)


class DraftRequest(BaseModel):
    registration: dict[str, Any]
    conflict: dict[str, Any]
    policyDecision: dict[str, Any]
    partner: dict[str, Any] = Field(default_factory=dict)
    passages: list[dict[str, Any]] = Field(default_factory=list)
    confidential: list[str] = Field(default_factory=list, description="Names and figures the partner must not see")
