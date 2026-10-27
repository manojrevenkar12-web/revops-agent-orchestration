import numpy as np

from revops_agent.learn import Isotonic, Logistic, TextClassifier, calibration_report


def test_isotonic_is_monotone_smoothed_and_never_overconfident_below_its_data():
    scores = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95])
    outcomes = np.array([0, 0, 1, 0, 1, 0, 1, 1, 1, 1])
    iso = Isotonic().fit(scores, outcomes)
    grid = [iso(s) for s in np.linspace(0.1, 0.95, 30)]
    assert all(a <= b + 1e-12 for a, b in zip(grid, grid[1:], strict=False))
    assert iso(0.95) < 1.0  # four correct answers in a row are not certainty
    assert iso(0.01) <= 0.01  # below anything seen: no more confident than the raw score


def test_all_correct_history_does_not_become_certainty():
    iso = Isotonic().fit(np.linspace(0.6, 0.99, 50), np.ones(50))
    assert 0.95 < iso(0.8) < 1.0


def test_calibration_report_measures_the_gap():
    probs = np.array([0.9] * 10)
    outcomes = np.array([1] * 6 + [0] * 4)
    r = calibration_report(probs, outcomes)
    assert abs(r["ece"] - 0.3) < 1e-9
    assert r["bins"][0]["observed"] == 0.6


def test_logistic_learns_the_direction_of_a_signal():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(400, 2))
    y = (X[:, 0] > 0).astype(float)
    m = Logistic().fit(X, y, ["signal", "noise"])
    assert m.w[0] > 1 and abs(m.w[1]) < 0.5
    assert m.contributions(np.array([2.0, 0.0]))["signal"] > 0


def test_text_classifier_and_coverage():
    texts = [
        "please send pricing for the enterprise plan",
        "we want a demo of the product",
        "pricing quote needed",
        "demo for our architects",
    ] * 5
    labels = ["pricing", "demo", "pricing", "demo"] * 5
    clf = TextClassifier().fit(texts, labels, min_df=1)
    label, raw, score = clf.score("can we get a pricing quote")
    assert label == "pricing" and score <= raw
    _, raw2, score2 = clf.score("xylophone zebra quantum")
    assert score2 < 0.1 and score2 < raw2
