import { motion as m } from "framer-motion";
import { Link } from "react-router-dom";
import type { Lane } from "../../shared/api/client";
import { kindColor, layout, motion } from "../../shared/theme/theme";

/**
 * One automation as a lane: every case it handled, split by who decided. The segments grow in order on first load,
 * the way work flows through the process.
 */
export function FlowLane({ lane, index }: { lane: Lane; index: number }) {
  const total = Math.max(
    1,
    lane.segments.reduce((n, s) => n + s.count, 0),
  );
  return (
    <div className="lane">
      <div className="lane-head">
        <Link to={`/instances?process=${lane.id}`} className="lane-title">
          {lane.title}
        </Link>
        <span className="lane-total num">{lane.total} cases</span>
      </div>
      <div className="lane-bar" style={{ height: layout.laneHeight }} role="img" aria-label={`${lane.title}: ${lane.segments.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(", ")}`}>
        {lane.segments.map((s, i) => (
          <m.span
            key={s.kind + s.label}
            className="lane-seg"
            style={{ background: kindColor[s.kind].fg }}
            initial={{ width: 0 }}
            animate={{ width: `${(s.count / total) * 100}%` }}
            transition={{ duration: motion.slow, delay: index * motion.stagger * 3 + i * motion.stagger, ease: motion.ease }}
          />
        ))}
      </div>
      <ul className="lane-legend">
        {lane.segments.map((s) => (
          <li key={s.kind + s.label}>
            <span className="dot" style={{ background: kindColor[s.kind].fg }} aria-hidden="true" />
            <span className="num">{s.count}</span> {s.label.toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}
