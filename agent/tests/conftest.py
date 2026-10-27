import json
import os

import pytest

os.environ.setdefault("AGENT_PROVIDER", "simulated")

from revops_agent.config import repo_root  # noqa: E402


@pytest.fixture(scope="session")
def history_renewals():
    path = repo_root() / "agent" / "data" / "history" / "renewals.jsonl"
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
