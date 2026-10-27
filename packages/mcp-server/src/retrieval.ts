/**
 * Retrieval over the GTM playbooks: passages (by heading), BM25 ranking with light stemming. Small and inspectable on
 * purpose; the passages carry ids so an agent's brief can cite them and the grounding check can verify the citation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@revops/core";

export interface Passage {
  id: string; // "renewal-save-plays#play-usage-recovery"
  doc: string;
  heading: string;
  text: string;
}

const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the this to was were will with when who what which not no do does".split(" "));
const stem = (w: string) => w.replace(/(ing|ers|er|ed|es|s)$/, "");
export const terms = (s: string) =>
  s
    .toLowerCase()
    .match(/[a-z0-9äöüß]+/g)
    ?.filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem) ?? [];

export class PlaybookIndex {
  readonly passages: Passage[] = [];
  private df = new Map<string, number>();
  private tf: Array<Map<string, number>> = [];
  private lengths: number[] = [];
  private avg = 1;

  constructor(dir = join(repoRoot(), "docs", "playbooks")) {
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".md"))
      .sort()) {
      const doc = f.replace(/\.md$/, "");
      let heading = "";
      let buf: string[] = [];
      const flush = () => {
        const text = buf.join(" ").replace(/\s+/g, " ").trim();
        if (text)
          this.passages.push({
            id: `${doc}#${heading
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")}`,
            doc,
            heading,
            text,
          });
        buf = [];
      };
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        const h = /^#{1,3}\s+(.*)/.exec(line);
        if (h) {
          flush();
          heading = h[1] as string;
        } else buf.push(line);
      }
      flush();
    }
    for (const p of this.passages) {
      const counts = new Map<string, number>();
      const ts = terms(`${p.heading} ${p.text}`);
      for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(counts);
      this.lengths.push(ts.length);
    }
    this.avg = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  search(query: string, k = 3): Array<Passage & { score: number }> {
    const q = terms(query);
    const n = this.passages.length;
    const scored = this.passages.map((p, i) => {
      let s = 0;
      for (const t of q) {
        const f = this.tf[i]?.get(t) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * ((this.lengths[i] ?? 0) / this.avg)));
      }
      return { ...p, score: Math.round(s * 1000) / 1000 };
    });
    return scored
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  get(id: string): Passage | undefined {
    return this.passages.find((p) => p.id === id);
  }
}
