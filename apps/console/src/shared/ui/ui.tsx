import { motion as m } from "framer-motion";
import type { ReactNode } from "react";
import { type Kind, kindColor, motion } from "../theme/theme";

export function PageHeader({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {lead ? <p className="lead">{lead}</p> : null}
    </header>
  );
}

/** A section that fades in once, on first render. */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <m.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: motion.base, delay, ease: motion.ease }} className="reveal">
      {children}
    </m.section>
  );
}

export function KindDot({ kind }: { kind: Kind }) {
  return <span className="dot" style={{ background: kindColor[kind].fg }} aria-hidden="true" />;
}

export function Tag({ kind, children }: { kind: Kind; children: ReactNode }) {
  return (
    <span className="tag" style={{ color: kindColor[kind].fg, background: kindColor[kind].tint }}>
      {children}
    </span>
  );
}

export const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 1000) / 10} %`);
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");
export const PROCESS_NAMES: Record<string, string> = {
  "inbound-lead-routing": "Inbound leads",
  "renewal-risk-save-play": "Renewals at risk",
  "partner-deal-registration": "Deal registrations",
};
