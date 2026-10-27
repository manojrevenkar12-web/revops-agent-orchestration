"""Settings from config/agent.yaml (the repository's config directory), with environment overrides."""

from __future__ import annotations

import os
from functools import cache
from pathlib import Path
from typing import Any

import yaml


def repo_root() -> Path:
    env = os.environ.get("REVOPS_ROOT")
    if env:
        return Path(env)
    p = Path(__file__).resolve()
    for parent in p.parents:
        if (parent / "config" / "automations.yaml").exists():
            return parent
    raise RuntimeError("cannot find the repository root (config/automations.yaml)")


@cache
def settings() -> dict[str, Any]:
    with open(repo_root() / "config" / "agent.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def provider_mode() -> str:
    """'simulated' (default locally and in CI) or 'live' (the provider chain in config/agent.yaml)."""
    return os.environ.get("AGENT_PROVIDER", "simulated")


def models_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "models"
