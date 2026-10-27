/** Time is injectable: the engine's timers and the sandbox's retention windows run on a clock tests can move. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string = "2026-10-26T09:00:00Z") {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }
}

/** ISO 8601 durations used in BPMN timers ("PT15M", "P1DT4H"). */
export function parseDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!m || iso.trim() === "P" || iso.trim() === "PT") throw new Error(`not an ISO 8601 duration: ${iso}`);
  const [, d, h, mi, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi ?? 0)) * 60_000 + Number(s ?? 0) * 1000;
}
