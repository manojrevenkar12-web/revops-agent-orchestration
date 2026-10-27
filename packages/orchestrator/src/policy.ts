/**
 * config/automations.yaml as the `policy` variable each process instance starts with. The BPMN compares
 * calibrated probabilities and amounts with these values, so a threshold change is a config change, reviewed and
 * deployed like code, and every instance records the policy it ran under.
 */
import { loadConfig } from "@revops/core";

export interface AutomationsConfig {
  inbound_lead_routing: {
    process_id: string;
    message: string;
    mode: "auto" | "review_all";
    auto_route_min_probability: number;
    never_auto_segments: string[];
    review_timeout: string;
    review_queue_owner_role: string;
    minutes_saved_per_auto_route: number;
    minutes_saved_per_assisted_route: number;
  };
  renewal_risk: {
    process_id: string;
    message: string;
    mode: "auto" | "review_all";
    create_cta_min_probability: number;
    approval_deadline: string;
    agent_time_budget: string;
    renewal_window_days: number;
    minutes_saved_per_brief: number;
  };
  partner_deal_registration: {
    process_id: string;
    message: string;
    mode: "auto" | "review_all";
    decision_deadline: string;
    auto_approve_max_amount: number;
    minutes_saved_per_registration: number;
  };
  territories: Record<string, string[]>;
  segments: Record<string, string>;
  approvals: { token_ttl: string };
}

export const automations = () => loadConfig<AutomationsConfig>("automations");

export function leadPolicy() {
  const c = automations().inbound_lead_routing;
  return { mode: c.mode, autoRouteMinProbability: c.auto_route_min_probability, neverAutoSegments: c.never_auto_segments, reviewTimeout: c.review_timeout };
}

export function renewalPolicy() {
  const c = automations().renewal_risk;
  // review_all: no save play is ever proposed without a person, but the CSM still sees every brief.
  return { mode: c.mode, createCtaMinProbability: c.mode === "review_all" ? 0 : c.create_cta_min_probability, approvalDeadline: c.approval_deadline, agentTimeBudget: c.agent_time_budget };
}

export function dealRegistrationPolicy() {
  const c = automations().partner_deal_registration;
  return { mode: c.mode, autoApproveMaxAmount: c.auto_approve_max_amount, decisionDeadline: c.decision_deadline };
}

export function regionOf(country: string | undefined): string | null {
  if (!country) return null;
  for (const [region, countries] of Object.entries(automations().territories)) if (countries.includes(country)) return region;
  return null;
}

export function segmentOf(band: string | undefined): string {
  return automations().segments[band ?? ""] ?? "SMB";
}
