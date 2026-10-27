/** The demo server answers before its morning of activity has run; wait until every automation has cases. */
export default async function globalSetup() {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try {
      const o = (await fetch("http://127.0.0.1:9601/api/overview").then((r) => r.json())) as { lanes: Array<{ total: number }> };
      if (o.lanes.every((l) => l.total > 0)) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the demo did not produce activity in time");
}
