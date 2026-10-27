/**
 * Change Data Capture subscriber with durable replay and gap recovery.
 *
 * Salesforce keeps change events for 72 hours. A subscriber that stores the last replay ID can resume after a
 * restart without losing or repeating events. A subscriber that was down for longer than the retention window
 * cannot: its replay ID is refused. Then the only correct thing is to re-read the records that changed since the
 * last event it processed, which this subscriber does with a Bulk API query on SystemModstamp, after first taking
 * the current stream position so nothing that happens during the re-read is missed.
 *
 * The transport is an interface: the sandbox speaks Pub/Sub API semantics over HTTP; production uses the gRPC
 * Pub/Sub API with the same three replay presets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UpstreamError } from "./http";
import type { SalesforceClient } from "./salesforce";

export interface ChangeEvent {
  replayId: string;
  topic: string;
  payload: {
    ChangeEventHeader: { entityName: string; recordIds: string[]; changeType: string; changedFields: string[]; commitTimestamp: number };
    [field: string]: unknown;
  };
  resync?: boolean; // produced by gap recovery, not by the stream
}

export interface PubSubTransport {
  fetch(topic: string, preset: "LATEST" | "EARLIEST" | "CUSTOM", replayId: string | null, num: number): Promise<{ events: ChangeEvent[]; latestReplayId: string | null }>;
}

export interface ReplayStore {
  get(topic: string): { replayId: string; commitTimestamp: number } | null;
  set(topic: string, v: { replayId: string; commitTimestamp: number }): void;
}

/** File-backed store for local runs; production keeps the same record in Firestore. */
export class FileReplayStore implements ReplayStore {
  private data: Record<string, { replayId: string; commitTimestamp: number }> = {};
  constructor(private readonly path: string) {
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8"));
  }
  get(topic: string) {
    return this.data[topic] ?? null;
  }
  set(topic: string, v: { replayId: string; commitTimestamp: number }) {
    this.data[topic] = v;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

export class MemoryReplayStore implements ReplayStore {
  private data = new Map<string, { replayId: string; commitTimestamp: number }>();
  get(topic: string) {
    return this.data.get(topic) ?? null;
  }
  set(topic: string, v: { replayId: string; commitTimestamp: number }) {
    this.data.set(topic, v);
  }
}

/** Sandbox transport: the Pub/Sub API's replay semantics over HTTP. */
export class HttpPubSubTransport implements PubSubTransport {
  constructor(private readonly sf: SalesforceClient) {}
  async fetch(topic: string, preset: "LATEST" | "EARLIEST" | "CUSTOM", replayId: string | null, num: number) {
    const { data } = await this.sf.request<{ events: ChangeEvent[]; latestReplayId: string | null }>("POST", "/pubsub/subscribe", {
      body: { topicName: topic, replayPreset: preset, replayId, numRequested: num },
      priority: "interactive",
    });
    return data;
  }
}

export interface ResyncSpec {
  object: string;
  fields: string[];
}

export class ChangeSubscriber {
  constructor(
    private readonly transport: PubSubTransport,
    private readonly store: ReplayStore,
    private readonly sf: SalesforceClient,
    private readonly resync: Record<string, ResyncSpec>, // topic -> what to re-read after a gap
  ) {}

  /**
   * Fetch the next batch for a topic and hand each event to `handle`. The replay ID is stored only after the handler
   * succeeded, so a crash in between re-delivers rather than loses (handlers are idempotent by record and timestamp).
   */
  async poll(topic: string, handle: (e: ChangeEvent) => Promise<void>, num = 100): Promise<{ delivered: number; resynced: number }> {
    const pos = this.store.get(topic);
    try {
      const { events, latestReplayId } = await this.transport.fetch(topic, pos ? "CUSTOM" : "LATEST", pos?.replayId ?? null, num);
      for (const e of events) {
        await handle(e);
        this.store.set(topic, { replayId: e.replayId, commitTimestamp: e.payload.ChangeEventHeader.commitTimestamp });
      }
      if (!pos && latestReplayId && events.length === 0) this.store.set(topic, { replayId: latestReplayId, commitTimestamp: Date.now() });
      return { delivered: events.length, resynced: 0 };
    } catch (e) {
      if (!(e instanceof UpstreamError) || e.code !== "REPLAY_ID_NOT_AVAILABLE" || !pos) throw e;
      return { delivered: 0, resynced: await this.recover(topic, pos.commitTimestamp, handle) };
    }
  }

  /** Gap recovery: take the stream position first, then re-read what changed since the last processed event. */
  private async recover(topic: string, sinceMs: number, handle: (e: ChangeEvent) => Promise<void>): Promise<number> {
    const spec = this.resync[topic];
    if (!spec) throw new UpstreamError("salesforce", 400, "NO_RESYNC_SPEC", `no resync defined for ${topic}`, false);
    const head = await this.transport.fetch(topic, "LATEST", null, 1);
    const since = new Date(sinceMs).toISOString();
    const rows = await this.sf.bulkQuery(
      `SELECT ${["Id", "SystemModstamp", ...spec.fields.filter((f) => f !== "Id" && f !== "SystemModstamp")].join(", ")} FROM ${spec.object} WHERE SystemModstamp >= ${since}`,
    );
    for (const r of rows) {
      await handle({
        replayId: "resync",
        topic,
        resync: true,
        payload: {
          ChangeEventHeader: {
            entityName: spec.object,
            recordIds: [r.Id as string],
            changeType: "UPDATE",
            changedFields: spec.fields,
            commitTimestamp: new Date(r.SystemModstamp as string).getTime(),
          },
          ...r,
        },
      });
    }
    if (head.latestReplayId) this.store.set(topic, { replayId: head.latestReplayId, commitTimestamp: Date.now() });
    return rows.length;
  }
}
