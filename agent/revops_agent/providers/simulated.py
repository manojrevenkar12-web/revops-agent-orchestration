"""A stand-in for Claude that runs without a model API, behind exactly the same interface.

It receives the same `ModelCall` the live providers receive (system prompt, messages with the input in <input>
tags, tools, the forced output tool) and answers with the same content blocks. So prompt construction, tool
definitions, structured-output validation and the repair loop are exercised in every test and evaluation run; only
the "thinking" is replaced:

- lead classification: a text classifier trained on labelled history (agent/models/lead_classifier.json);
- the renewal investigation: a careful analyst's routine (look at the account, look up the play for the main risk,
  write a brief that cites what it read);
- partner messages: templates per reason code.

`faults` lets the evaluation harness make it misbehave the way models do: invalid output, invented numbers,
uncited claims, tool calls with bad arguments, outages.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..features import language, persona, urgency
from ..learn import TextClassifier
from .base import ModelCall, ModelResult, TransientProviderError

INPUT = re.compile(r"<input>(.*?)</input>", re.S)

DRIVER_QUERY = {
    "usage_decline": "usage recovery process instances dropped",
    "champion_left": "champion has left new stakeholder",
    "sev1_tickets": "severity-1 support escalation",
    "health_drop": "health score down usage recovery",
    "close_date_pushed": "close date pushed commercial reset",
    "no_activity": "no customer activity close date pushed commercial reset",
}


def _input(call: ModelCall) -> dict[str, Any]:
    first = call.messages[0]["content"]
    text = first if isinstance(first, str) else "".join(b.get("text", "") for b in first if b.get("type") == "text")
    m = INPUT.search(text)
    return json.loads(m.group(1)) if m else {}


def _tokens(x: Any) -> int:
    return max(1, len(json.dumps(x)) // 4)


class SimulatedProvider:
    name = "simulated"

    def __init__(self, classifier: TextClassifier | None, faults: dict[str, float] | None = None):
        self.classifier = classifier
        self.faults = faults or {}
        self.calls = 0

    def _fault(self, name: str) -> bool:
        rate = self.faults.get(name, 0.0)
        if rate <= 0:
            return False
        # Deterministic: every k-th call misbehaves, so evaluation runs are reproducible.
        return (self.calls * 7919) % 1000 / 1000 < rate

    def create(self, call: ModelCall) -> ModelResult:
        self.calls += 1
        if self._fault("outage"):
            raise TransientProviderError("simulated outage")
        if call.task == "lead.classify":
            block = self._classify(call)
        elif call.task == "renewal.investigate":
            block = self._investigate(call)
        elif call.task == "dealreg.draft":
            block = self._draft(call)
        else:
            raise ValueError(f"the simulated provider does not know task {call.task}")
        blocks = block if isinstance(block, list) else [block]
        return ModelResult(
            content=blocks,
            model=f"simulated/{call.model}",
            provider=self.name,
            input_tokens=_tokens(call.messages) + _tokens(call.system),
            output_tokens=_tokens(blocks),
            latency_ms=0,
            stop_reason="tool_use",
        )

    # ---- tasks ----------------------------------------------------------------------------------------------------

    def _classify(self, call: ModelCall) -> dict[str, Any]:
        sub = _input(call)["submission"]
        text = str(sub.get("message", ""))
        assert self.classifier is not None, "train the lead classifier first (python -m revops_agent.train)"
        label, _raw, score = self.classifier.score(text)
        out: dict[str, Any] = {
            "intent": label,
            "urgency": urgency(text),
            "persona": persona(str(sub.get("jobtitle", ""))),
            "language": language(text),
            "confidence": round(score, 4),
            "rationale": f"The message reads as {label.replace('_', ' ')}.",
        }
        if self._fault("invalid_output") and not _repairing(call):
            out["intent"] = "maybe_demo"  # not an allowed value: the repair loop must catch it
        return {
            "type": "tool_use",
            "id": f"toolu_sim_{self.calls}",
            "name": call.tool_choice["name"] if call.tool_choice else "record",
            "input": out,
        }

    def _investigate(self, call: ModelCall) -> list[dict[str, Any]] | dict[str, Any]:
        ctx = _input(call)["context"]
        results = _tool_results(call.messages)
        names = {t["name"] for t in call.tools}
        account = next((r for r in results if isinstance(r, dict) and "facts" in r), None)
        passages = [p for r in results if isinstance(r, dict) for p in r.get("passages", [])]
        uid = f"toolu_sim_{self.calls}"
        if account is None:
            args = {"accountId": ctx["accountId"]}
            if self._fault("bad_tool_args"):
                args = {"accountId": "not-an-id"}
            return {"type": "tool_use", "id": f"{uid}_a", "name": "Account360", "input": args}
        facts = {f["id"]: f for f in account["facts"]}
        drivers = _drivers(facts)
        if not passages and "SearchPlaybooks" in names:
            query = DRIVER_QUERY.get(drivers[0][0] if drivers else "", "renewal at risk signals")
            calls = [{"type": "tool_use", "id": f"{uid}_p", "name": "SearchPlaybooks", "input": {"query": query}}]
            if "OpenOpportunities" in names:
                calls.append(
                    {
                        "type": "tool_use",
                        "id": f"{uid}_o",
                        "name": "OpenOpportunities",
                        "input": {"accountId": ctx["accountId"]},
                    }
                )
            return calls
        brief = _brief(facts, drivers, passages)
        if self._fault("fabricate"):
            brief["claims"].append(
                {
                    "text": "Weekly process instances fell by 61% over the last month.",
                    "cites": ["usage.process_instances_change_pct"],
                }
            )
        if self._fault("uncited"):
            brief["claims"].append({"text": "The customer is evaluating a competitor.", "cites": ["market.intel"]})
        return {"type": "tool_use", "id": f"{uid}_b", "name": "submit_brief", "input": brief}

    def _draft(self, call: ModelCall) -> dict[str, Any]:
        d = _input(call)
        reg, code = d["registration"], d["policyDecision"].get("reasonCode", "UNKNOWN")
        company = reg.get("companyName") or reg.get("CompanyName") or "the company"
        passage = next(
            (p["id"] for p in d.get("passages", []) if p["id"].startswith("partner-programme#registration-decisions")),
            None,
        )
        texts = {
            "CLEAN": f"Thank you for registering {company}. The registration is approved: there is no conflicting opportunity, and the deal is now protected for your team.",
            "ABOVE_AUTO_LIMIT": f"Thank you for registering {company}. Registrations of this size get a review by your partner manager, who will come back to you within two business days.",
            "DIRECT_LATE_STAGE": f"Thank you for registering {company}. We cannot approve this registration: our sales team is already in an advanced stage with this company. Your partner manager can explain the next steps.",
            "DIRECT_CONFLICT": f"Thank you for registering {company}. Our sales team is already in contact with this company, so your partner manager will review the registration with the account team within two business days.",
            "PARTNER_CONFLICT": f"Thank you for registering {company}. This company is already registered in the partner programme, so your partner manager will review the registration within two business days.",
        }
        msg = texts.get(
            code,
            f"Thank you for registering {company}. Your partner manager will review the registration within two business days.",
        )
        if self._fault("leak") and d.get("confidential"):
            msg += f" (Note: {d['confidential'][0]} is also involved.)"
        out = {
            "partnerMessage": msg,
            "internalNote": f"Policy reason {code}.",
            "citations": [passage] if passage else [],
        }
        return {
            "type": "tool_use",
            "id": f"toolu_sim_{self.calls}",
            "name": call.tool_choice["name"] if call.tool_choice else "record",
            "input": out,
        }


def _repairing(call: ModelCall) -> bool:
    return any(
        isinstance(m.get("content"), list) and any(b.get("type") == "tool_result" and b.get("is_error") for b in m["content"])
        for m in call.messages
    )


def _tool_results(messages: list[dict[str, Any]]) -> list[Any]:
    out = []
    for m in messages:
        if m["role"] != "user" or not isinstance(m["content"], list):
            continue
        for b in m["content"]:
            if b.get("type") == "tool_result":
                c = b.get("content")
                text = c if isinstance(c, str) else "".join(x.get("text", "") for x in c or [])
                try:
                    out.append(json.loads(text))
                except json.JSONDecodeError:
                    out.append(text)
    return out


def _num(facts: dict[str, Any], k: str) -> float | None:
    v = facts.get(k, {}).get("value")
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _drivers(facts: dict[str, Any]) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    u = _num(facts, "usage.process_instances_change_pct")
    if u is not None and u <= -25:
        out.append(("usage_decline", -u / 25))
    if facts.get("contacts.champion_left", {}).get("value") is True:
        out.append(("champion_left", 1.0))
    s = _num(facts, "support.sev1_30d")
    if s is not None and s >= 2:
        out.append(("sev1_tickets", s / 2))
    h = _num(facts, "health.change_12w")
    if h is not None and h <= -12:
        out.append(("health_drop", -h / 24))
    p = _num(facts, "forecast.close_date_pushes")
    if p is not None and p >= 2:
        out.append(("close_date_pushed", p / 4))
    d = _num(facts, "forecast.days_since_activity")
    if d is not None and d > 21:
        out.append(("no_activity", d / 60))
    return sorted(out, key=lambda x: -x[1])


CLAIM = {
    "usage_decline": (
        "Weekly process instances changed by {v:+.1f}% over the last twelve weeks.",
        "usage.process_instances_change_pct",
    ),
    "champion_left": ("The customer's champion has left the company.", "contacts.champion_left"),
    "sev1_tickets": ("{v:.0f} severity-1 tickets were opened in the last 30 days.", "support.sev1_30d"),
    "health_drop": ("The Gainsight health score changed by {v:+.0f} points over the period.", "health.change_12w"),
    "close_date_pushed": ("The renewal close date has been pushed {v:.0f} times.", "forecast.close_date_pushes"),
    "no_activity": ("No customer activity has been logged for {v:.0f} days.", "forecast.days_since_activity"),
}


def _brief(facts: dict[str, Any], drivers: list[tuple[str, float]], passages: list[dict[str, Any]]) -> dict[str, Any]:
    claims = []
    for name, _w in drivers[:4]:
        tpl, fid = CLAIM[name]
        v = facts.get(fid, {}).get("value")
        claims.append({"text": tpl.format(v=v if isinstance(v, int | float) else 0), "cites": [fid]})
    days = _num(facts, "renewal.days_to_close")
    if days is not None:
        claims.append({"text": f"The renewal closes in {days:.0f} days.", "cites": ["renewal.days_to_close"]})
    strong = {"usage_decline", "champion_left", "sev1_tickets"}
    at_risk = any(n in strong for n, _ in drivers) or len(drivers) >= 2
    play = None
    if passages and drivers:
        top = passages[0]
        play = {
            "passageId": top["id"],
            "title": top.get("heading", top["id"]),
            "why": f"The main driver is {drivers[0][0].replace('_', ' ')}.",
        }
        claims.append({"text": f"The recommended play is '{top.get('heading', top['id'])}'.", "cites": [top["id"]]})
    summary = (
        "At risk: " + ", ".join(n.replace("_", " ") for n, _ in drivers[:3]) + "." if at_risk else "No strong risk signal in the facts."
    )
    return {
        "summary": summary,
        "atRisk": at_risk,
        "claims": claims,
        "recommendedPlay": play,
        "nextSteps": ["Run the recommended play", "Review in the next renewal call"] if at_risk else [],
    }
