"""Fit the agent service's models on labelled history and record how well calibrated they are.

    python -m revops_agent.train

History comes from scripts/export-history.ts (seeds 101-110). Seeds 101-106 fit the models, seeds 107-110 fit
the calibration and measure it. The live sandbox (seed 7) and the held-out sets are never used here.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .config import models_dir, repo_root
from .features import RISK_FEATURES, lead_text, risk_vector
from .learn import Isotonic, Logistic, TextClassifier, calibration_report

FIT_SEEDS = set(range(101, 107))
CAL_SEEDS = set(range(107, 111))


def load(name: str) -> list[dict]:
    path = repo_root() / "agent" / "data" / "history" / name
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def train_leads() -> dict:
    rows = load("leads.jsonl")
    fit = [r for r in rows if r["seed"] in FIT_SEEDS]
    cal = [r for r in rows if r["seed"] in CAL_SEEDS]
    clf = TextClassifier().fit([lead_text(r) for r in fit], [r["label"]["intent"] for r in fit])
    scored = [clf.score(lead_text(r)) for r in cal]
    pred = [s[0] for s in scored]
    raw = np.array([s[2] for s in scored])
    correct = np.array([p == r["label"]["intent"] for p, r in zip(pred, cal, strict=True)], dtype=float)
    # Calibrate on half of the calibration seeds, measure on the other half.
    half = np.array([r["seed"] in {107, 108} for r in cal])
    iso = Isotonic().fit(raw[half], correct[half])
    calibrated = np.array([iso(s) for s in raw[~half]])
    report = {
        "accuracy": round(float(correct[~half].mean()), 4),
        "raw": calibration_report(raw[~half], correct[~half]),
        "calibrated": calibration_report(calibrated, correct[~half]),
        "fitRows": len(fit),
        "calibrationRows": int(half.sum()),
        "measuredRows": int((~half).sum()),
    }
    # Final calibration uses all calibration seeds.
    iso_all = Isotonic().fit(raw, correct)
    (models_dir() / "lead_classifier.json").write_text(
        json.dumps({"classifier": clf.to_json(), "calibration": iso_all.to_json(), "report": report})
    )
    return report


def train_risk() -> dict:
    rows = load("renewals.jsonl")
    fit = [r for r in rows if r["seed"] in FIT_SEEDS]
    cal = [r for r in rows if r["seed"] in CAL_SEEDS]
    X = np.array([risk_vector(r["facts"]) for r in fit])
    y = np.array([1.0 if r["atRisk"] else 0.0 for r in fit])
    model = Logistic().fit(X, y, RISK_FEATURES)
    Xc = np.array([risk_vector(r["facts"]) for r in cal])
    yc = np.array([1.0 if r["atRisk"] else 0.0 for r in cal])
    p = model.predict(Xc)
    report = {
        "auc": round(auc(p, yc), 4),
        "calibration": calibration_report(p, yc),
        "atRiskRate": round(float(yc.mean()), 3),
        "fitRows": len(fit),
        "measuredRows": len(cal),
        "weights": {n: round(w, 3) for n, w in zip(model.names, model.w, strict=True)},
    }
    (models_dir() / "renewal_risk.json").write_text(json.dumps({"model": model.to_json(), "report": report}))
    return report


def auc(p: np.ndarray, y: np.ndarray) -> float:
    pos, neg = p[y == 1], p[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    return float(((pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()) / (len(pos) * len(neg)))


def main() -> None:
    models_dir().mkdir(parents=True, exist_ok=True)
    out = {"leadClassifier": train_leads(), "renewalRisk": train_risk()}
    reports = repo_root() / "reports" / "agent"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "calibration.json").write_text(json.dumps(out, indent=2) + "\n")
    print(
        json.dumps(
            {
                "lead": {k: out["leadClassifier"][k] for k in ("accuracy",)}
                | {
                    "eceRaw": out["leadClassifier"]["raw"]["ece"],
                    "eceCalibrated": out["leadClassifier"]["calibrated"]["ece"],
                },
                "risk": {"auc": out["renewalRisk"]["auc"], "ece": out["renewalRisk"]["calibration"]["ece"]},
            }
        )
    )


if __name__ == "__main__":
    main()


__all__ = ["main", "train_leads", "train_risk", "Path"]
