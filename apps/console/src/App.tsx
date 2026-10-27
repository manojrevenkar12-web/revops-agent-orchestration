import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, motion as m } from "framer-motion";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ApprovalsPage } from "./features/approvals/ApprovalsPage";
import { AuditPage } from "./features/audit/AuditPage";
import { CataloguePage } from "./features/catalogue/CataloguePage";
import { InstanceDetail } from "./features/instances/InstanceDetail";
import { InstancesPage } from "./features/instances/InstancesPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { motion } from "./shared/theme/theme";
import { EmptyState } from "./shared/ui/states";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/approvals", label: "Decisions in Slack" },
  { to: "/instances", label: "Cases" },
  { to: "/audit", label: "Audit log" },
  { to: "/catalogue", label: "Tools and policy" },
];

function Pages() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <m.div key={location.pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motion.fast }}>
        <Routes location={location}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/instances" element={<InstancesPage />} />
          <Route path="/instances/:key" element={<InstanceDetail />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/catalogue" element={<CataloguePage />} />
          <Route path="*" element={<EmptyState title="There is no page here" />} />
        </Routes>
      </m.div>
    </AnimatePresence>
  );
}

export function Shell() {
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <p className="brand">
          RevOps
          <br />
          control room
        </p>
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="main">
        <Pages />
      </main>
    </div>
  );
}

export function App({ client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }) }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
