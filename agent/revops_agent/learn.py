"""Small, inspectable models in numpy: a bag-of-words softmax classifier, logistic regression, isotonic
calibration and the calibration metrics. Their weights are JSON files in agent/models, versioned with the code.

Nothing here needs a GPU or a model API: the point is that the probability a policy compares with a threshold is
a calibrated estimate measured on data the model was not fitted on, whatever produced the raw score.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

TOKEN = re.compile(r"[a-zäöüß0-9]+")


def tokens(text: str) -> list[str]:
    words = TOKEN.findall(text.lower())
    return words + [f"{a}_{b}" for a, b in zip(words, words[1:], strict=False)]


@dataclass
class TextClassifier:
    """Multinomial logistic regression over TF-IDF unigrams and bigrams."""

    labels: list[str] = field(default_factory=list)
    vocab: dict[str, int] = field(default_factory=dict)
    idf: list[float] = field(default_factory=list)
    W: list[list[float]] = field(default_factory=list)
    b: list[float] = field(default_factory=list)

    def _x(self, texts: list[str]) -> np.ndarray:
        X = np.zeros((len(texts), len(self.vocab)))
        for i, t in enumerate(texts):
            for w, c in Counter(tokens(t)).items():
                j = self.vocab.get(w)
                if j is not None:
                    X[i, j] = c
        X *= np.asarray(self.idf)
        norms = np.linalg.norm(X, axis=1, keepdims=True)
        return X / np.maximum(norms, 1e-9)

    def fit(
        self, texts: list[str], y: list[str], *, min_df: int = 2, l2: float = 1e-3, epochs: int = 300, lr: float = 2.0
    ) -> TextClassifier:
        self.labels = sorted(set(y))
        df: Counter[str] = Counter()
        for t in texts:
            df.update(set(tokens(t)))
        kept = sorted(w for w, c in df.items() if c >= min_df)
        self.vocab = {w: i for i, w in enumerate(kept)}
        n = len(texts)
        self.idf = [math.log((1 + n) / (1 + df[w])) + 1 for w in kept]
        X = self._x(texts)
        Y = np.zeros((n, len(self.labels)))
        for i, label in enumerate(y):
            Y[i, self.labels.index(label)] = 1
        W = np.zeros((X.shape[1], len(self.labels)))
        b = np.zeros(len(self.labels))
        for _ in range(epochs):
            P = softmax(X @ W + b)
            G = P - Y
            W -= lr * (X.T @ G / n + l2 * W)
            b -= lr * G.mean(axis=0)
        self.W, self.b = W.tolist(), b.tolist()
        return self

    def predict_proba(self, texts: list[str]) -> np.ndarray:
        return softmax(self._x(texts) @ np.asarray(self.W) + np.asarray(self.b))

    def coverage(self, text: str) -> float:
        """Share of the text's words the model has seen. Unfamiliar wording should lower confidence, not keep it."""
        words = TOKEN.findall(text.lower())
        if not words:
            return 0.0
        return sum(1 for w in words if w in self.vocab) / len(words)

    def score(self, text: str) -> tuple[str, float, float]:
        """(label, raw max probability, raw score discounted by vocabulary coverage)."""
        p = self.predict_proba([text])[0]
        i = int(p.argmax())
        return self.labels[i], float(p[i]), float(p[i]) * min(1.0, self.coverage(text) / 0.6)

    def to_json(self) -> dict:
        return {"labels": self.labels, "vocab": self.vocab, "idf": self.idf, "W": self.W, "b": self.b}

    @classmethod
    def from_json(cls, d: dict) -> TextClassifier:
        return cls(labels=d["labels"], vocab=d["vocab"], idf=d["idf"], W=d["W"], b=d["b"])


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


@dataclass
class Logistic:
    """Binary logistic regression on standardised features."""

    names: list[str] = field(default_factory=list)
    mean: list[float] = field(default_factory=list)
    std: list[float] = field(default_factory=list)
    w: list[float] = field(default_factory=list)
    b: float = 0.0

    def fit(self, X: np.ndarray, y: np.ndarray, names: list[str], *, l2: float = 1e-2, epochs: int = 3000, lr: float = 0.5) -> Logistic:
        self.names = names
        m, s = X.mean(axis=0), X.std(axis=0)
        s[s == 0] = 1
        self.mean, self.std = m.tolist(), s.tolist()
        Z = (X - m) / s
        w = np.zeros(Z.shape[1])
        b = 0.0
        for _ in range(epochs):
            p = 1 / (1 + np.exp(-(Z @ w + b)))
            g = p - y
            w -= lr * (Z.T @ g / len(y) + l2 * w)
            b -= lr * g.mean()
        self.w, self.b = w.tolist(), float(b)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        Z = (X - np.asarray(self.mean)) / np.asarray(self.std)
        return 1 / (1 + np.exp(-(Z @ np.asarray(self.w) + self.b)))

    def contributions(self, x: np.ndarray) -> dict[str, float]:
        """Each feature's push on the log-odds, so the brief can say which facts drove the score."""
        z = (x - np.asarray(self.mean)) / np.asarray(self.std)
        return {n: float(v) for n, v in zip(self.names, z * np.asarray(self.w), strict=True)}

    def to_json(self) -> dict:
        return {"names": self.names, "mean": self.mean, "std": self.std, "w": self.w, "b": self.b}

    @classmethod
    def from_json(cls, d: dict) -> Logistic:
        return cls(**d)


@dataclass
class Isotonic:
    """Isotonic regression (pool adjacent violators) from a raw score to an observed frequency."""

    x: list[float] = field(default_factory=list)
    y: list[float] = field(default_factory=list)

    def fit(self, scores: np.ndarray, outcomes: np.ndarray) -> Isotonic:
        order = np.argsort(scores)
        s, o = scores[order], outcomes[order].astype(float)
        blocks = [[float(o[i]), 1.0, float(s[i]), float(s[i])] for i in range(len(s))]  # mean, weight, lo, hi
        out: list[list[float]] = []
        for blk in blocks:
            out.append(blk)
            while len(out) > 1 and out[-2][0] >= out[-1][0]:
                a, c = out[-2], out.pop()
                w = a[1] + c[1]
                out[-1] = [(a[0] * a[1] + c[0] * c[1]) / w, w, a[2], c[3]]
        xs: list[float] = []
        ys: list[float] = []
        for mean, w, lo, hi in out:
            # Laplace smoothing: a block of 40 correct answers is evidence for about 0.98, not certainty.
            smoothed = (mean * w + 1) / (w + 2)
            xs += [lo, hi]
            ys += [smoothed, smoothed]
        self.x, self.y = xs, ys
        return self

    def __call__(self, score: float) -> float:
        if not self.x:
            return score
        if score < self.x[0]:
            # Below anything seen in calibration: never more confident than the raw score.
            return min(score, self.y[0])
        return float(np.interp(score, self.x, self.y))

    def to_json(self) -> dict:
        return {"x": self.x, "y": self.y}

    @classmethod
    def from_json(cls, d: dict) -> Isotonic:
        return cls(**d)


def calibration_report(probs: np.ndarray, outcomes: np.ndarray, bins: int = 10) -> dict:
    """Expected calibration error, Brier score and the reliability table."""
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    ece = 0.0
    for lo, hi in zip(edges[:-1], edges[1:], strict=True):
        mask = (probs >= lo) & ((probs < hi) if hi < 1 else (probs <= hi))
        if not mask.any():
            continue
        conf, acc, n = float(probs[mask].mean()), float(outcomes[mask].mean()), int(mask.sum())
        ece += abs(conf - acc) * n / len(probs)
        rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": n, "meanPredicted": round(conf, 3), "observed": round(acc, 3)})
    return {
        "ece": round(ece, 4),
        "brier": round(float(((probs - outcomes) ** 2).mean()), 4),
        "n": len(probs),
        "bins": rows,
    }
