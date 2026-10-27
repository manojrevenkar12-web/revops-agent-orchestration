"""Turning inputs into what the models read: risk features from account_360 facts, text for the lead classifier,
and the deterministic signals (language, injection attempts, persona) that do not need a model."""

from __future__ import annotations

import re
from typing import Any

import numpy as np

from .config import settings

RISK_FEATURES = [
    "usage_process_instances_change_pct",
    "usage_active_users_change_pct",
    "health_change_12w",
    "champion_left",
    "sev1_30d",
    "close_date_pushes",
    "days_since_activity",
    "manager_call_weak",
]


def facts_by_id(facts: list[dict[str, Any]]) -> dict[str, Any]:
    return {f["id"]: f.get("value") for f in facts if isinstance(f, dict) and "id" in f}


def risk_vector(facts: list[dict[str, Any]]) -> np.ndarray:
    f = facts_by_id(facts)

    def num(k: str) -> float:
        v = f.get(k)
        return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else 0.0

    return np.array(
        [
            num("usage.process_instances_change_pct"),
            num("usage.active_users_change_pct"),
            num("health.change_12w"),
            1.0 if f.get("contacts.champion_left") is True else 0.0,
            num("support.sev1_30d"),
            num("forecast.close_date_pushes"),
            num("forecast.days_since_activity"),
            1.0 if f.get("forecast.manager_call") in ("pipeline", "omitted") else 0.0,
        ]
    )


# The fact each risk feature comes from, so a driver can be cited.
FEATURE_FACT = {
    "usage_process_instances_change_pct": "usage.process_instances_change_pct",
    "usage_active_users_change_pct": "usage.active_users_change_pct",
    "health_change_12w": "health.change_12w",
    "champion_left": "contacts.champion_left",
    "sev1_30d": "support.sev1_30d",
    "close_date_pushes": "forecast.close_date_pushes",
    "days_since_activity": "forecast.days_since_activity",
    "manager_call_weak": "forecast.manager_call",
}


def lead_text(sub: dict[str, Any]) -> str:
    return str(sub.get("message") or "")


GERMAN = re.compile(r"\b(wir|und|die|der|das|nicht|bitte|können|unser|unsere|für|mit|möchten|seit)\b", re.I)


def language(text: str) -> str:
    return "de" if len(GERMAN.findall(text)) >= 2 else "en"


URGENT = re.compile(
    r"(urgent|asap|immediately|production|stuck|by the end of the month|deadline|dringend|bis monatsende|sofort|seit heute)",
    re.I,
)


def urgency(text: str) -> str:
    return "high" if URGENT.search(text) else "normal"


def persona(title: str) -> str:
    t = (title or "").lower()
    if re.search(r"\b(cto|cio|chief|vp|vice president|head|director|leiter)\b", t):
        return "executive"
    if re.search(r"(architect|engineer|developer|entwickler|devops|platform)", t):
        return "technical"
    if re.search(r"(procurement|purchas|einkauf|buyer)", t):
        return "procurement"
    if re.search(r"(student|intern|praktikant)", t):
        return "student"
    return "business"


def injection_signals(text: str) -> list[str]:
    hits = []
    for p in settings()["injection"]["patterns"]:
        if re.search(p, text, re.I | re.M):
            hits.append(p)
    return hits
