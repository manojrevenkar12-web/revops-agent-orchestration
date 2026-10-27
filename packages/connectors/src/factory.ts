import { loadConfig } from "@revops/core";
import { ClariClient, GainsightClient, ImpartnerClient, SalesloftClient, SlackClient, Warehouse } from "./gtm";
import type { Sleep } from "./http";
import { SalesforceClient } from "./salesforce";

export interface Connectors {
  salesforce: SalesforceClient;
  gainsight: GainsightClient;
  salesloft: SalesloftClient;
  clari: ClariClient;
  impartner: ImpartnerClient;
  slack: SlackClient;
  warehouse: Warehouse;
  cfg: ConnectorConfig;
}

export interface ConnectorConfig {
  salesforce: { login_url: string; client_id: string; client_secret: string; api_version: string; soft_reserve_pct: number; hard_reserve_pct: number; bulk_threshold: number };
  gainsight: { base_url: string; access_key: string };
  salesloft: { base_url: string; api_key: string };
  clari: { base_url: string; api_key: string };
  impartner: { base_url: string; key: string };
  hubspot: { client_secret: string };
  slack: { base_url: string; bot_token: string; signing_secret: string; channels: Record<string, string> };
  bigquery: { project: string; api_endpoint: string; audit_dataset: string };
}

/** Builds every client from config/connectors.yaml (with environment overrides). */
export function buildConnectors(overrides: { baseUrl?: string; sleep?: Sleep; now?: () => number } = {}): Connectors {
  const cfg = structuredClone(loadConfig<ConnectorConfig>("connectors"));
  if (overrides.baseUrl) {
    const b = overrides.baseUrl;
    cfg.salesforce.login_url = b;
    cfg.gainsight.base_url = b;
    cfg.salesloft.base_url = b;
    cfg.clari.base_url = b;
    cfg.impartner.base_url = b;
    cfg.slack.base_url = b;
    cfg.bigquery.api_endpoint = b;
  }
  const s = cfg.salesforce;
  const c: Connectors = {
    cfg,
    salesforce: new SalesforceClient(
      {
        loginUrl: s.login_url,
        clientId: s.client_id,
        clientSecret: s.client_secret,
        apiVersion: s.api_version,
        softReservePct: s.soft_reserve_pct,
        hardReservePct: s.hard_reserve_pct,
        bulkThreshold: s.bulk_threshold,
      },
      overrides.sleep,
    ),
    gainsight: new GainsightClient(cfg.gainsight.base_url, cfg.gainsight.access_key, overrides.sleep),
    salesloft: new SalesloftClient(cfg.salesloft.base_url, cfg.salesloft.api_key, overrides.sleep),
    clari: new ClariClient(cfg.clari.base_url, cfg.clari.api_key),
    impartner: new ImpartnerClient(cfg.impartner.base_url, cfg.impartner.key),
    slack: new SlackClient(cfg.slack.base_url, cfg.slack.bot_token),
    warehouse: new Warehouse(cfg.bigquery.project, cfg.bigquery.api_endpoint || undefined),
  };
  if (overrides.now) for (const b of [c.salesforce.breaker, c.gainsight.breaker, c.salesloft.breaker]) b.now = overrides.now;
  return c;
}
