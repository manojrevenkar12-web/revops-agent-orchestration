/** Values the components share with the CSS tokens: no magic numbers in components. */
export const motion = {
  fast: 0.15,
  base: 0.28,
  slow: 0.6,
  stagger: 0.08,
  ease: [0.2, 0.7, 0.2, 1] as [number, number, number, number],
};

export const layout = {
  laneHeight: 28,
  diagramHeight: 420,
  pageSize: 50,
  refreshMs: 10_000,
};

export type Kind = "policy" | "person" | "none" | "waiting" | "incident";

export const kindColor: Record<Kind, { fg: string; tint: string }> = {
  policy: { fg: "var(--policy)", tint: "var(--policy-tint)" },
  person: { fg: "var(--person)", tint: "var(--person-tint)" },
  none: { fg: "var(--none)", tint: "var(--none-tint)" },
  waiting: { fg: "var(--waiting)", tint: "var(--waiting-tint)" },
  incident: { fg: "var(--incident)", tint: "var(--incident-tint)" },
};
