/**
 * A local, deterministic engine for the subset of Zeebe that the RevOps processes use. It exists so that the same
 * BPMN and DMN files that deploy to Camunda 8.8 can run in unit tests, in the evaluation harness and on a laptop,
 * on a virtual clock (a 24-hour approval timeout takes no time in a test).
 *
 * Semantics follow Zeebe where the processes depend on them:
 * - variables: input mappings create local variables; job, message and user-task variables propagate from the
 *   element's flow scope to the scope that already holds the variable, else to the process instance; output
 *   mappings replace propagation; inside an ad-hoc sub-process each activation keeps its variables local;
 * - jobs: activation with a timeout (expired jobs become activatable again), failure with retries and back-off,
 *   an incident when retries reach zero, business errors caught by the nearest matching error boundary event;
 * - messages: subscriptions opened on activation with the correlation key evaluated then, buffering with a time to
 *   live, a message id that is unique while buffered, at most one correlation per process instance, message start
 *   events that start one instance per correlation key at a time;
 * - timers: durations, dates and repeating cycles, interrupting and non-interrupting boundary events;
 * - ad-hoc sub-processes with a job worker (the AI agent pattern): a job on activation and after every completed
 *   inner flow, at most one job at a time, completion with an `adHocSubProcess` result.
 * Anything else is refused at deploy time (model.ts). The engine is not a replacement for Zeebe in production.
 */
import { type Clock, systemClock } from "@revops/core";
import { type DecisionDef, DecisionError, evaluateDecision, parseDmn } from "./dmn";
import { condition, evalFeel, FeelError, type FeelEnv, isExpression, parseCycle, parseIsoDuration, feelValue } from "./feel";
import { DeploymentError, type ElementDef, type FlowDef, fromAiParameters, type ProcessDef, parseBpmn } from "./model";

export type Vars = Record<string, unknown>;

export interface Scope {
  key: string;
  processInstanceKey: string;
  processDefinitionKey: string;
  bpmnProcessId: string;
  elementId: string;
  elementName: string;
  elementType: string; // an ElementType, "process" or "adHocInner"
  parentKey: string | null;
  state: "ACTIVE" | "COMPLETED" | "TERMINATED";
  vars: Vars;
  startDate: string;
  endDate?: string;
  incidentKey?: string;
  jobKey?: string;
  userTaskKey?: string;
  joins: Record<string, Record<string, number>>; // gateway -> incoming flow -> waiting tokens
  pendingCompletion?: boolean;
  startedByMessage?: string; // correlation key of the message that started this process instance
}

export interface Job {
  key: string;
  type: string;
  kind: "task" | "adHoc";
  processInstanceKey: string;
  processDefinitionKey: string;
  bpmnProcessId: string;
  processDefinitionVersion: number;
  elementId: string;
  elementInstanceKey: string;
  customHeaders: Record<string, string>;
  retries: number;
  state: "ACTIVATABLE" | "ACTIVATED" | "FAILED" | "COMPLETED" | "CANCELED" | "ERROR_THROWN";
  worker?: string;
  deadlineMs?: number;
  retryAtMs?: number;
  errorMessage?: string;
  createdMs: number;
}

export interface UserTask {
  key: string;
  elementInstanceKey: string;
  processInstanceKey: string;
  processDefinitionKey: string;
  bpmnProcessId: string;
  elementId: string;
  name: string;
  assignee: string | null;
  candidateGroups: string[];
  candidateUsers: string[];
  formKey: string | null;
  dueDate: string | null;
  state: "CREATED" | "COMPLETED" | "CANCELED";
  creationDate: string;
  completionDate?: string;
}

export type IncidentType = "JOB_NO_RETRIES" | "IO_MAPPING_ERROR" | "CONDITION_ERROR" | "EXTRACT_VALUE_ERROR" | "DECISION_EVALUATION_ERROR" | "UNHANDLED_ERROR_EVENT" | "AD_HOC_SUB_PROCESS_NO_RETRIES";

export interface Incident {
  key: string;
  processInstanceKey: string;
  bpmnProcessId: string;
  elementId: string;
  elementInstanceKey: string;
  errorType: IncidentType;
  errorMessage: string;
  state: "ACTIVE" | "RESOLVED";
  creationTime: string;
  jobKey?: string;
}

interface Subscription {
  key: string;
  processInstanceKey: string;
  elementInstanceKey: string; // the catching instance, or the host activity of a boundary event
  boundaryId?: string;
  messageName: string;
  correlationKey: string;
  open: boolean;
}

interface Timer {
  key: string;
  processInstanceKey: string;
  elementInstanceKey: string;
  boundaryId?: string;
  dueMs: number;
  repetitions: number | null; // remaining for a cycle; null = forever
  intervalMs?: number;
  open: boolean;
}

interface BufferedMessage {
  key: string;
  name: string;
  correlationKey: string;
  variables: Vars;
  expiresMs: number;
  messageId?: string;
  correlatedTo: Set<string>; // process instance keys
}

export interface EngineRecord {
  position: number;
  timestamp: string;
  valueType: "DEPLOYMENT" | "PROCESS_INSTANCE" | "JOB" | "USER_TASK" | "INCIDENT" | "MESSAGE" | "MESSAGE_SUBSCRIPTION" | "TIMER" | "DECISION_EVALUATION" | "VARIABLE";
  intent: string;
  key: string;
  processInstanceKey?: string;
  bpmnProcessId?: string;
  elementId?: string;
  value: Record<string, unknown>;
}

export class EngineError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_ARGUMENT" | "INVALID_STATE" | "ALREADY_EXISTS",
    message: string,
  ) {
    super(message);
  }
}

export interface AdHocResult {
  type: "adHocSubProcess";
  activateElements?: Array<{ elementId: string; variables?: Vars | null }>;
  isCompletionConditionFulfilled?: boolean;
  isCancelRemainingInstances?: boolean;
}

const ACTIVITY_TYPES = new Set(["serviceTask", "sendTask", "scriptTask", "businessRuleTask", "userTask", "receiveTask", "subProcess", "adHocSubProcess"]);

export class Engine {
  readonly processes = new Map<string, ProcessDef>(); // key -> definition
  readonly decisions = new Map<string, DecisionDef>(); // key -> definition
  readonly scopes = new Map<string, Scope>();
  readonly jobs = new Map<string, Job>();
  readonly userTasks = new Map<string, UserTask>();
  readonly incidents = new Map<string, Incident>();
  readonly records: EngineRecord[] = [];
  private subscriptions = new Map<string, Subscription>();
  private timers = new Map<string, Timer>();
  private messages = new Map<string, BufferedMessage>();
  private children = new Map<string, Set<string>>();
  private retryActions = new Map<string, () => void>(); // incident -> what resolving it does
  private nextKey = 2251799813685249n;
  private listeners: Array<(r: EngineRecord) => void> = [];
  private jobWaiters: Array<() => void> = [];
  private completionWaiters = new Map<string, Array<(s: Scope) => void>>();
  private readonly env: FeelEnv;

  constructor(readonly clock: Clock = systemClock) {
    this.env = { now: () => clock.now() };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // deployment

  async deploy(resources: Array<{ name: string; content: string }>): Promise<{
    key: string;
    processes: Array<{ bpmnProcessId: string; version: number; processDefinitionKey: string; resourceName: string }>;
    decisions: Array<{ decisionId: string; version: number; decisionKey: string; name: string; decisionRequirementsId: string }>;
  }> {
    const parsedP: Array<Omit<ProcessDef, "version" | "key">> = [];
    const parsedD: Array<Omit<DecisionDef, "version" | "key">> = [];
    for (const r of resources) {
      if (r.name.endsWith(".bpmn")) parsedP.push(...(await parseBpmn(r.content, r.name)));
      else if (r.name.endsWith(".dmn")) parsedD.push(...(await parseDmn(r.content, r.name)));
      else throw new DeploymentError(`${r.name}: only .bpmn and .dmn resources are supported`);
    }
    const key = this.key();
    const processes = parsedP.map((p) => {
      const latest = this.latestProcess(p.bpmnProcessId);
      if (latest && latest.xml === p.xml) return { bpmnProcessId: p.bpmnProcessId, version: latest.version, processDefinitionKey: latest.key, resourceName: p.resourceName };
      const def: ProcessDef = { ...p, version: (latest?.version ?? 0) + 1, key: this.key() };
      this.processes.set(def.key, def);
      return { bpmnProcessId: def.bpmnProcessId, version: def.version, processDefinitionKey: def.key, resourceName: def.resourceName };
    });
    const decisions = parsedD.map((d) => {
      const latest = this.latestDecision(d.decisionId);
      if (latest && latest.xml === d.xml) return { decisionId: d.decisionId, version: latest.version, decisionKey: latest.key, name: latest.name, decisionRequirementsId: latest.drgId };
      const def: DecisionDef = { ...d, version: (latest?.version ?? 0) + 1, key: this.key() };
      this.decisions.set(def.key, def);
      return { decisionId: def.decisionId, version: def.version, decisionKey: def.key, name: def.name, decisionRequirementsId: def.drgId };
    });
    this.record("DEPLOYMENT", "CREATED", key, { processes, decisions });
    return { key, processes, decisions };
  }

  latestProcess(bpmnProcessId: string): ProcessDef | undefined {
    let best: ProcessDef | undefined;
    for (const p of this.processes.values()) if (p.bpmnProcessId === bpmnProcessId && (!best || p.version > best.version)) best = p;
    return best;
  }

  latestDecision(decisionId: string): DecisionDef | undefined {
    let best: DecisionDef | undefined;
    for (const d of this.decisions.values()) if (d.decisionId === decisionId && (!best || d.version > best.version)) best = d;
    return best;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // commands

  createProcessInstance(req: { bpmnProcessId?: string; processDefinitionKey?: string; variables?: Vars; startElementId?: string }): Scope {
    const def = req.processDefinitionKey ? this.processes.get(req.processDefinitionKey) : this.latestProcess(req.bpmnProcessId ?? "");
    if (!def) throw new EngineError("NOT_FOUND", `no process ${req.bpmnProcessId ?? req.processDefinitionKey} is deployed`);
    const start = req.startElementId ?? def.startEvents.find((id) => def.elements.get(id)?.event?.kind === "none");
    if (!start) throw new EngineError("INVALID_STATE", `${def.bpmnProcessId} has no none start event; start it with a message`);
    return this.startInstance(def, start, req.variables ?? {});
  }

  awaitCompletion(processInstanceKey: string): Promise<Scope> {
    const s = this.scopes.get(processInstanceKey);
    if (s && s.state !== "ACTIVE") return Promise.resolve(s);
    return new Promise((resolve) => {
      const list = this.completionWaiters.get(processInstanceKey) ?? [];
      list.push(resolve);
      this.completionWaiters.set(processInstanceKey, list);
    });
  }

  cancelProcessInstance(processInstanceKey: string): void {
    const s = this.scopes.get(processInstanceKey);
    if (!s || s.elementType !== "process") throw new EngineError("NOT_FOUND", `no process instance ${processInstanceKey}`);
    if (s.state !== "ACTIVE") throw new EngineError("INVALID_STATE", `process instance ${processInstanceKey} is not active`);
    this.terminate(s);
    this.finishProcess(s);
  }

  /** Jobs that a worker may take now; marks them activated until the timeout. */
  activateJobs(req: { type: string; worker: string; maxJobsToActivate: number; timeout: number; fetchVariable?: string[] }): Array<Job & { variables: Vars; deadline: string }> {
    this.tick();
    const now = this.nowMs();
    const out: Array<Job & { variables: Vars; deadline: string }> = [];
    for (const j of this.jobs.values()) {
      if (out.length >= req.maxJobsToActivate) break;
      if (j.type !== req.type || j.state !== "ACTIVATABLE" || (j.retryAtMs ?? 0) > now) continue;
      j.state = "ACTIVATED";
      j.worker = req.worker;
      j.deadlineMs = now + req.timeout;
      this.record("JOB", "ACTIVATED", j.key, { type: j.type, worker: req.worker, retries: j.retries }, j);
      let variables = this.context(j.elementInstanceKey);
      if (req.fetchVariable?.length) variables = Object.fromEntries(Object.entries(variables).filter(([k]) => req.fetchVariable?.includes(k)));
      out.push({ ...j, variables, deadline: new Date(j.deadlineMs).toISOString() });
    }
    return out;
  }

  /** Resolves when a job of any type may be activatable (long polling). */
  waitForJobs(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.jobWaiters.push(done);
    });
  }

  completeJob(jobKey: string, variables: Vars = {}, result?: AdHocResult | { type: "userTask" } | null): void {
    const j = this.activeJob(jobKey);
    const s = this.scopes.get(j.elementInstanceKey);
    if (!s || s.state !== "ACTIVE") throw new EngineError("NOT_FOUND", `job ${jobKey} belongs to an element that is no longer active`);
    if (j.kind === "adHoc") {
      const r = (result ?? { type: "adHocSubProcess" }) as AdHocResult;
      const def = this.def(s);
      const activatable = new Set(this.activatableElements(def, s).map((e) => e.elementId));
      for (const a of r.activateElements ?? []) if (!activatable.has(a.elementId)) throw new EngineError("INVALID_ARGUMENT", `element ${a.elementId} cannot be activated in ${def.id}`);
      if (r.isCompletionConditionFulfilled && r.activateElements?.length)
        throw new EngineError("INVALID_ARGUMENT", "a job result cannot activate elements and fulfil the completion condition at the same time");
      j.state = "COMPLETED";
      s.jobKey = undefined;
      this.record(
        "JOB",
        "COMPLETED",
        j.key,
        { type: j.type, variables: Object.keys(variables), activateElements: (r.activateElements ?? []).map((a) => a.elementId), done: !!r.isCompletionConditionFulfilled },
        j,
      );
      Object.assign(s.vars, variables);
      if (r.isCancelRemainingInstances) for (const c of this.activeChildren(s.key)) this.terminate(c);
      for (const a of r.activateElements ?? []) this.activateInner(s, a.elementId, a.variables ?? {});
      if (r.isCompletionConditionFulfilled) {
        if (this.activeChildren(s.key).length === 0) this.completeElement(s);
        else s.pendingCompletion = true;
      }
      return;
    }
    j.state = "COMPLETED";
    s.jobKey = undefined;
    this.record("JOB", "COMPLETED", j.key, { type: j.type, variables: Object.keys(variables) }, j);
    this.completeElement(s, variables);
  }

  failJob(jobKey: string, req: { retries: number; errorMessage?: string; retryBackOff?: number; variables?: Vars }): void {
    const j = this.activeJob(jobKey);
    j.retries = req.retries;
    j.errorMessage = req.errorMessage;
    if (req.variables) Object.assign(this.scopes.get(j.elementInstanceKey)?.vars ?? {}, req.variables);
    if (req.retries > 0) {
      j.state = "ACTIVATABLE";
      j.retryAtMs = this.nowMs() + (req.retryBackOff ?? 0);
      this.record("JOB", "FAILED", j.key, { type: j.type, retries: j.retries, errorMessage: req.errorMessage, retryBackOff: req.retryBackOff ?? 0 }, j);
      this.notifyJobs();
      return;
    }
    j.state = "FAILED";
    this.record("JOB", "FAILED", j.key, { type: j.type, retries: 0, errorMessage: req.errorMessage }, j);
    const s = this.scopes.get(j.elementInstanceKey) as Scope;
    this.raiseIncident(
      s,
      j.kind === "adHoc" ? "AD_HOC_SUB_PROCESS_NO_RETRIES" : "JOB_NO_RETRIES",
      req.errorMessage ?? "job failed with no retries left",
      () => {
        j.state = "ACTIVATABLE";
        j.retryAtMs = undefined;
        this.notifyJobs();
      },
      j.key,
    );
  }

  throwError(jobKey: string, req: { errorCode: string; errorMessage?: string; variables?: Vars }): void {
    const j = this.activeJob(jobKey);
    const s = this.scopes.get(j.elementInstanceKey) as Scope;
    j.state = "ERROR_THROWN";
    s.jobKey = undefined;
    this.record("JOB", "ERROR_THROWN", j.key, { type: j.type, errorCode: req.errorCode, errorMessage: req.errorMessage }, j);
    this.propagateError(s, req.errorCode, req.errorMessage ?? "", req.variables ?? {});
  }

  updateJob(jobKey: string, changeset: { retries?: number; timeout?: number }): void {
    const j = this.jobs.get(jobKey);
    if (!j || j.state === "COMPLETED" || j.state === "CANCELED") throw new EngineError("NOT_FOUND", `no job ${jobKey}`);
    if (changeset.retries !== undefined) j.retries = changeset.retries;
    if (changeset.timeout !== undefined && j.state === "ACTIVATED") j.deadlineMs = this.nowMs() + changeset.timeout;
    this.record("JOB", "UPDATED", j.key, { retries: j.retries }, j);
  }

  resolveIncident(incidentKey: string): void {
    const inc = this.incidents.get(incidentKey);
    if (!inc || inc.state !== "ACTIVE") throw new EngineError("NOT_FOUND", `no active incident ${incidentKey}`);
    if (inc.jobKey && (this.jobs.get(inc.jobKey)?.retries ?? 0) <= 0) throw new EngineError("INVALID_STATE", "the job has no retries left; update its retries first");
    inc.state = "RESOLVED";
    const s = this.scopes.get(inc.elementInstanceKey);
    if (s) s.incidentKey = undefined;
    this.record("INCIDENT", "RESOLVED", inc.key, { errorType: inc.errorType }, s);
    const retry = this.retryActions.get(incidentKey);
    this.retryActions.delete(incidentKey);
    retry?.();
  }

  publishMessage(req: { name: string; correlationKey?: string; variables?: Vars; timeToLive?: number; messageId?: string }): { messageKey: string; correlatedTo: string[] } {
    this.tick();
    const now = this.nowMs();
    if (req.messageId) {
      for (const m of this.messages.values()) {
        if (m.messageId === req.messageId && m.name === req.name && m.expiresMs > now)
          throw new EngineError("ALREADY_EXISTS", `a message with id ${req.messageId} was already published and is still buffered`);
      }
    }
    const msg: BufferedMessage = {
      key: this.key(),
      name: req.name,
      correlationKey: req.correlationKey ?? "",
      variables: req.variables ?? {},
      expiresMs: now + (req.timeToLive ?? 0),
      messageId: req.messageId,
      correlatedTo: new Set(),
    };
    this.record("MESSAGE", "PUBLISHED", msg.key, { name: msg.name, correlationKey: msg.correlationKey, messageId: msg.messageId, timeToLive: req.timeToLive ?? 0 });
    // Message start events: one instance per process and correlation key at a time.
    const latest = new Map<string, ProcessDef>();
    for (const p of this.processes.values()) if (!latest.has(p.bpmnProcessId) || (latest.get(p.bpmnProcessId)?.version ?? 0) < p.version) latest.set(p.bpmnProcessId, p);
    for (const p of latest.values()) {
      const start = p.startEvents.map((id) => p.elements.get(id) as ElementDef).find((e) => e.event?.kind === "message" && e.event.messageName === msg.name);
      if (!start) continue;
      const running = [...this.scopes.values()].some(
        (s) => s.elementType === "process" && s.state === "ACTIVE" && s.bpmnProcessId === p.bpmnProcessId && s.startedByMessage === msg.correlationKey && msg.correlationKey !== "",
      );
      if (running) continue;
      const inst = this.startInstance(p, start.id, msg.variables, msg.correlationKey);
      msg.correlatedTo.add(inst.key);
    }
    for (const sub of [...this.subscriptions.values()]) {
      if (!sub.open || sub.messageName !== msg.name || sub.correlationKey !== msg.correlationKey || msg.correlatedTo.has(sub.processInstanceKey)) continue;
      msg.correlatedTo.add(sub.processInstanceKey);
      this.correlate(sub, msg);
    }
    if ((req.timeToLive ?? 0) > 0) this.messages.set(msg.key, msg);
    return { messageKey: msg.key, correlatedTo: [...msg.correlatedTo] };
  }

  /** Correlate now or fail: for callers who must know the message reached a waiting instance. */
  correlateMessage(req: { name: string; correlationKey?: string; variables?: Vars }): { messageKey: string; processInstanceKey: string } {
    const r = this.publishMessage({ ...req, timeToLive: 0 });
    const first = r.correlatedTo[0];
    if (!first) throw new EngineError("NOT_FOUND", `no process instance is waiting for message ${req.name} with correlation key ${req.correlationKey}`);
    return { messageKey: r.messageKey, processInstanceKey: first };
  }

  completeUserTask(userTaskKey: string, variables: Vars = {}): void {
    const t = this.userTasks.get(userTaskKey);
    if (!t || t.state !== "CREATED") throw new EngineError("NOT_FOUND", `no open user task ${userTaskKey}`);
    t.state = "COMPLETED";
    t.completionDate = this.nowIso();
    this.record("USER_TASK", "COMPLETED", t.key, { variables: Object.keys(variables) }, this.scopes.get(t.elementInstanceKey));
    const s = this.scopes.get(t.elementInstanceKey) as Scope;
    s.userTaskKey = undefined;
    this.completeElement(s, variables);
  }

  assignUserTask(userTaskKey: string, assignee: string | null): void {
    const t = this.userTasks.get(userTaskKey);
    if (!t || t.state !== "CREATED") throw new EngineError("NOT_FOUND", `no open user task ${userTaskKey}`);
    t.assignee = assignee;
    this.record("USER_TASK", "ASSIGNED", t.key, { assignee }, this.scopes.get(t.elementInstanceKey));
  }

  evaluateDecision(decisionId: string, variables: Vars) {
    const r = evaluateDecision(decisionId, (id) => this.latestDecision(id), variables, this.env);
    this.record("DECISION_EVALUATION", "EVALUATED", this.key(), { decisionId, output: r.output, matchedRules: r.matchedRules });
    return r;
  }

  /** Fire due timers, time out expired jobs and drop expired messages. Call after moving a manual clock. */
  tick(): number {
    let fired = 0;
    for (;;) {
      const now = this.nowMs();
      for (const j of this.jobs.values()) {
        if (j.state === "ACTIVATED" && (j.deadlineMs ?? Number.POSITIVE_INFINITY) <= now) {
          j.state = "ACTIVATABLE";
          this.record("JOB", "TIMED_OUT", j.key, { type: j.type, worker: j.worker }, j);
          this.notifyJobs();
        }
      }
      for (const m of this.messages.values()) if (m.expiresMs <= now) this.messages.delete(m.key);
      const due = [...this.timers.values()].filter((t) => t.open && t.dueMs <= now).sort((a, b) => a.dueMs - b.dueMs)[0];
      if (!due) return fired;
      fired++;
      this.fireTimer(due);
    }
  }

  onRecord(fn: (r: EngineRecord) => void): void {
    this.listeners.push(fn);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // queries

  context(scopeKey: string): Vars {
    const chain: Scope[] = [];
    for (let s = this.scopes.get(scopeKey); s; s = s.parentKey ? this.scopes.get(s.parentKey) : undefined) chain.unshift(s);
    return Object.assign({}, ...chain.map((s) => s.vars));
  }

  activeChildren(scopeKey: string): Scope[] {
    return [...(this.children.get(scopeKey) ?? [])].map((k) => this.scopes.get(k) as Scope).filter((s) => s.state === "ACTIVE");
  }

  elementInstances(processInstanceKey: string): Scope[] {
    return [...this.scopes.values()].filter((s) => s.processInstanceKey === processInstanceKey && s.elementType !== "adHocInner");
  }

  // ---------------------------------------------------------------------------------------------------------------
  // execution

  private startInstance(def: ProcessDef, startElementId: string, variables: Vars, startedByMessage?: string): Scope {
    const key = this.key();
    const root: Scope = {
      key,
      processInstanceKey: key,
      processDefinitionKey: def.key,
      bpmnProcessId: def.bpmnProcessId,
      elementId: def.bpmnProcessId,
      elementName: def.name,
      elementType: "process",
      parentKey: null,
      state: "ACTIVE",
      vars: { ...variables },
      startDate: this.nowIso(),
      joins: {},
      startedByMessage,
    };
    this.scopes.set(key, root);
    this.record("PROCESS_INSTANCE", "ELEMENT_ACTIVATED", key, { bpmnProcessId: def.bpmnProcessId, version: def.version, elementType: "PROCESS" }, root);
    this.activate(def.elements.get(startElementId) as ElementDef, root);
    return root;
  }

  private activate(def: ElementDef, flowScope: Scope, localVars: Vars = {}): Scope {
    const s: Scope = {
      key: this.key(),
      processInstanceKey: flowScope.processInstanceKey,
      processDefinitionKey: flowScope.processDefinitionKey,
      bpmnProcessId: flowScope.bpmnProcessId,
      elementId: def.id,
      elementName: def.name,
      elementType: def.type,
      parentKey: flowScope.key,
      state: "ACTIVE",
      vars: { ...localVars },
      startDate: this.nowIso(),
      joins: {},
    };
    this.scopes.set(s.key, s);
    this.addChild(flowScope.key, s.key);
    this.record("PROCESS_INSTANCE", "ELEMENT_ACTIVATED", s.key, { elementType: def.type.toUpperCase(), elementName: def.name }, s);
    this.enter(s, def);
    return s;
  }

  private enter(s: Scope, def: ElementDef): void {
    try {
      for (const m of def.inputs) setPath(s.vars, m.target, isExpression(m.source) ? evalFeel(m.source, this.context(s.key), this.env) : m.source);
    } catch (e) {
      return this.raiseIncident(s, "IO_MAPPING_ERROR", (e as Error).message, () => this.enter(s, def));
    }
    if (ACTIVITY_TYPES.has(def.type)) {
      try {
        this.openBoundaries(s, def);
      } catch (e) {
        return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.enter(s, def));
      }
    }
    switch (def.type) {
      case "startEvent":
      case "intermediateThrowEvent":
        return this.completeElement(s);
      case "endEvent":
        if (def.event?.kind === "error") {
          this.finish(s, "COMPLETED");
          this.removeChild(s);
          return this.propagateError(this.scopes.get(s.parentKey as string) as Scope, def.event.errorCode ?? "", `error end event ${def.id}`, {}, s);
        }
        if (def.job) return this.createJob(s, def);
        return this.completeElement(s);
      case "serviceTask":
      case "sendTask":
        return this.createJob(s, def);
      case "scriptTask":
        try {
          const v = evalFeel(def.script?.expression ?? "", this.context(s.key), this.env, { strict: true });
          return this.completeElement(s, { [def.script?.resultVariable ?? "result"]: v });
        } catch (e) {
          return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.enter(s, def));
        }
      case "businessRuleTask":
        try {
          const r = evaluateDecision(def.decision?.decisionId ?? "", (id) => this.latestDecision(id), this.context(s.key), this.env);
          this.record("DECISION_EVALUATION", "EVALUATED", this.key(), { decisionId: r.decisionId, output: r.output, matchedRules: r.matchedRules, evaluated: r.evaluated }, s);
          return this.completeElement(s, { [def.decision?.resultVariable ?? "result"]: r.output });
        } catch (e) {
          const type = e instanceof DecisionError || e instanceof FeelError ? "DECISION_EVALUATION_ERROR" : "EXTRACT_VALUE_ERROR";
          return this.raiseIncident(s, type, (e as Error).message, () => this.enter(s, def));
        }
      case "userTask":
        return this.createUserTask(s, def);
      case "receiveTask":
      case "intermediateCatchEvent":
        if (def.event?.kind === "message") {
          try {
            return this.openSubscription(s, def, undefined);
          } catch (e) {
            return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.enter(s, def));
          }
        }
        if (def.event?.kind === "timer") return this.openTimer(s, def, undefined);
        return this.completeElement(s);
      case "exclusiveGateway":
        return this.leaveExclusive(s, def);
      case "parallelGateway":
        return this.completeElement(s);
      case "subProcess": {
        const start = def.children.map((id) => this.process(s).elements.get(id) as ElementDef).find((e) => e.type === "startEvent");
        if (!start) return this.completeElement(s);
        this.activate(start, s);
        return;
      }
      case "adHocSubProcess":
        return this.enterAdHoc(s, def);
      case "boundaryEvent":
        return this.completeElement(s);
    }
  }

  private leaveExclusive(s: Scope, def: ElementDef): void {
    const p = this.process(s);
    let target: FlowDef | undefined;
    try {
      for (const fid of def.outgoing) {
        if (fid === def.defaultFlow) continue;
        const f = p.flows.get(fid) as FlowDef;
        if (!f.condition || condition(f.condition, this.context(s.key), this.env)) {
          target = f;
          break;
        }
      }
    } catch (e) {
      return this.raiseIncident(s, "CONDITION_ERROR", (e as Error).message, () => this.leaveExclusive(s, def));
    }
    if (!target && def.defaultFlow) target = p.flows.get(def.defaultFlow);
    if (!target) return this.raiseIncident(s, "CONDITION_ERROR", `no outgoing sequence flow of ${def.id} applies and there is no default flow`, () => this.leaveExclusive(s, def));
    this.finish(s, "COMPLETED");
    this.takeFlow(target, this.scopes.get(s.parentKey as string) as Scope);
  }

  private enterAdHoc(s: Scope, def: ElementDef): void {
    s.vars.adHocSubProcessElements = this.activatableElements(def, s);
    if (def.adHoc?.outputCollection) s.vars[def.adHoc.outputCollection] = [];
    if (def.job) return this.createJob(s, def, "adHoc");
    let ids: unknown = null;
    try {
      ids = def.adHoc?.activeElementsCollection ? evalFeel(def.adHoc.activeElementsCollection, this.context(s.key), this.env, { strict: true }) : [];
    } catch (e) {
      return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.enterAdHoc(s, def));
    }
    if (ids !== null && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")))
      return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", "activeElementsCollection must be a list of element ids", () => this.enterAdHoc(s, def));
    for (const id of (ids as string[] | null) ?? []) this.activateInner(s, id, {});
    if (this.activeChildren(s.key).length === 0) this.completeElement(s);
  }

  activatableElements(
    def: ElementDef,
    _s?: Scope,
  ): Array<{ elementId: string; elementName: string; documentation: string; properties: Record<string, string>; parameters: Array<{ name: string; description: string; type: string }> }> {
    const p = [...this.processes.values()].find((x) => x.elements.get(def.id) === def) as ProcessDef;
    return def.children
      .map((id) => p.elements.get(id) as ElementDef)
      .filter((e) => e.incoming.length === 0 && e.type !== "boundaryEvent" && e.type !== "startEvent")
      .map((e) => ({ elementId: e.id, elementName: e.name, documentation: e.documentation, properties: e.properties, parameters: fromAiParameters(e.inputs) }));
  }

  private activateInner(adhoc: Scope, elementId: string, vars: Vars): void {
    const def = this.process(adhoc).elements.get(elementId);
    if (!def || def.parent !== adhoc.elementId) throw new EngineError("INVALID_ARGUMENT", `element ${elementId} is not in ${adhoc.elementId}`);
    const inner: Scope = {
      ...adhoc,
      key: this.key(),
      elementId: `${adhoc.elementId}#inner`,
      elementType: "adHocInner",
      parentKey: adhoc.key,
      state: "ACTIVE",
      vars: { ...vars },
      startDate: this.nowIso(),
      joins: {},
      jobKey: undefined,
      incidentKey: undefined,
      pendingCompletion: undefined,
    };
    this.scopes.set(inner.key, inner);
    this.addChild(adhoc.key, inner.key);
    this.activate(def, inner);
  }

  private completeInner(inner: Scope): void {
    const adhoc = this.scopes.get(inner.parentKey as string) as Scope;
    const def = this.def(adhoc);
    if (def.adHoc?.outputCollection) {
      let v: unknown = null;
      try {
        v = def.adHoc.outputElement ? evalFeel(def.adHoc.outputElement, this.context(inner.key), this.env) : null;
      } catch {
        v = null;
      }
      (adhoc.vars[def.adHoc.outputCollection] as unknown[]).push(v);
    }
    this.finish(inner, "COMPLETED");
    if (adhoc.state !== "ACTIVE") return;
    if (adhoc.pendingCompletion) {
      if (this.activeChildren(adhoc.key).length === 0) this.completeElement(adhoc);
      return;
    }
    if (def.job) {
      if (adhoc.jobKey) {
        const old = this.jobs.get(adhoc.jobKey);
        if (old && (old.state === "ACTIVATABLE" || old.state === "ACTIVATED")) {
          old.state = "CANCELED";
          this.record("JOB", "CANCELED", old.key, { type: old.type, reason: "an inner flow completed; a new job replaces this one" }, old);
        }
      }
      return this.createJob(adhoc, def, "adHoc");
    }
    let done = false;
    try {
      done = def.adHoc?.completionCondition ? condition(def.adHoc.completionCondition, this.context(adhoc.key), this.env) : this.activeChildren(adhoc.key).length === 0;
    } catch (e) {
      return this.raiseIncident(adhoc, "CONDITION_ERROR", (e as Error).message, () => this.completeElement(adhoc));
    }
    if (!done) return;
    const remaining = this.activeChildren(adhoc.key);
    if (remaining.length && def.adHoc?.cancelRemainingInstances) for (const r of remaining) this.terminate(r);
    if (this.activeChildren(adhoc.key).length === 0) this.completeElement(adhoc);
    else adhoc.pendingCompletion = true;
  }

  private completeElement(s: Scope, result: Vars = {}): void {
    if (s.state !== "ACTIVE") return;
    const def = this.def(s);
    const parent = this.scopes.get(s.parentKey as string) as Scope;
    try {
      if (def.outputs.length) {
        const ctx = { ...this.context(s.key), ...result };
        const values = def.outputs.map((m) => [m.target, isExpression(m.source) ? evalFeel(m.source, ctx, this.env) : m.source] as const);
        for (const [target, v] of values) this.propagate(parent, target, v);
      } else {
        for (const [k, v] of Object.entries(result)) this.propagate(parent, k, v);
      }
    } catch (e) {
      return this.raiseIncident(s, "IO_MAPPING_ERROR", (e as Error).message, () => this.completeElement(s, result));
    }
    this.closeWaits(s);
    this.finish(s, "COMPLETED");
    const p = this.process(s);
    const outgoing = def.type === "exclusiveGateway" ? [] : def.outgoing.map((id) => p.flows.get(id) as FlowDef);
    for (const f of outgoing) this.takeFlow(f, parent);
    if (!outgoing.length) this.checkScope(parent);
  }

  private takeFlow(f: FlowDef, flowScope: Scope): void {
    if (flowScope.state !== "ACTIVE") return;
    const p = this.process(flowScope);
    const target = p.elements.get(f.target) as ElementDef;
    this.record("PROCESS_INSTANCE", "SEQUENCE_FLOW_TAKEN", this.key(), { flowId: f.id, from: f.source, to: f.target }, flowScope);
    if (target.type === "parallelGateway" && target.incoming.length > 1) {
      const arrivals = flowScope.joins[target.id] ?? {};
      arrivals[f.id] = (arrivals[f.id] ?? 0) + 1;
      flowScope.joins[target.id] = arrivals;
      if (!target.incoming.every((i) => (arrivals[i] ?? 0) > 0)) return;
      for (const i of target.incoming) arrivals[i] = (arrivals[i] ?? 0) - 1;
    }
    this.activate(target, flowScope);
  }

  private checkScope(s: Scope): void {
    if (s.state !== "ACTIVE") return;
    if (this.activeChildren(s.key).length) return;
    if (Object.values(s.joins).some((a) => Object.values(a).some((n) => n > 0))) return;
    if (s.elementType === "process") {
      this.finish(s, "COMPLETED");
      return this.finishProcess(s);
    }
    if (s.elementType === "adHocInner") return this.completeInner(s);
    if (s.elementType === "subProcess") return this.completeElement(s);
    if (s.elementType === "adHocSubProcess") {
      // A BPMN-implemented ad-hoc sub-process without a completion condition completes when nothing is active.
      const def = this.def(s);
      if (!def.job && !def.adHoc?.completionCondition) this.completeElement(s);
    }
  }

  private finishProcess(s: Scope): void {
    this.record("PROCESS_INSTANCE", s.state === "COMPLETED" ? "ELEMENT_COMPLETED" : "ELEMENT_TERMINATED", s.key, { bpmnProcessId: s.bpmnProcessId, elementType: "PROCESS" }, s);
    for (const w of this.completionWaiters.get(s.key) ?? []) w(s);
    this.completionWaiters.delete(s.key);
  }

  private finish(s: Scope, state: "COMPLETED" | "TERMINATED"): void {
    s.state = state;
    s.endDate = this.nowIso();
    if (s.elementType !== "process" && s.elementType !== "adHocInner")
      this.record("PROCESS_INSTANCE", state === "COMPLETED" ? "ELEMENT_COMPLETED" : "ELEMENT_TERMINATED", s.key, { elementType: s.elementType.toUpperCase() }, s);
    for (const inc of this.incidents.values()) {
      if (inc.elementInstanceKey === s.key && inc.state === "ACTIVE") {
        inc.state = "RESOLVED";
        this.retryActions.delete(inc.key);
        this.record("INCIDENT", "RESOLVED", inc.key, { reason: `element ${state.toLowerCase()}` }, s);
      }
    }
  }

  private terminate(s: Scope): void {
    if (s.state !== "ACTIVE") return;
    for (const c of this.activeChildren(s.key)) this.terminate(c);
    this.closeWaits(s);
    if (s.jobKey) {
      const j = this.jobs.get(s.jobKey);
      if (j && j.state !== "COMPLETED") {
        j.state = "CANCELED";
        this.record("JOB", "CANCELED", j.key, { type: j.type }, j);
      }
    }
    if (s.userTaskKey) {
      const t = this.userTasks.get(s.userTaskKey);
      if (t && t.state === "CREATED") {
        t.state = "CANCELED";
        this.record("USER_TASK", "CANCELED", t.key, {}, s);
      }
    }
    this.finish(s, "TERMINATED");
  }

  /** Variables flow up to the scope that already has them, else to the process instance, but not out of an ad-hoc activation. */
  private propagate(from: Scope, name: string, value: unknown): void {
    const top = name.split(".")[0] as string;
    let target: Scope | undefined;
    let last = from;
    for (let s: Scope | undefined = from; s; s = s.parentKey ? this.scopes.get(s.parentKey) : undefined) {
      last = s;
      if (top in s.vars) {
        target = s;
        break;
      }
      if (s.elementType === "adHocInner") {
        target = s;
        break;
      }
    }
    setPath((target ?? last).vars, name, value);
  }

  // jobs, user tasks, waits ------------------------------------------------------------------------------------------

  private createJob(s: Scope, def: ElementDef, kind: Job["kind"] = "task"): void {
    let type: string;
    let retries: number;
    let headers: Record<string, string>;
    try {
      const ctx = this.context(s.key);
      type = String(feelValue(def.job?.type, ctx, this.env));
      retries = Number(feelValue(def.job?.retries ?? "3", ctx, this.env));
      headers = def.headers;
    } catch (e) {
      return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.createJob(s, def, kind));
    }
    const p = this.process(s);
    const j: Job = {
      key: this.key(),
      type,
      kind,
      processInstanceKey: s.processInstanceKey,
      processDefinitionKey: s.processDefinitionKey,
      bpmnProcessId: s.bpmnProcessId,
      processDefinitionVersion: p.version,
      elementId: def.id,
      elementInstanceKey: s.key,
      customHeaders: headers,
      retries: Number.isFinite(retries) ? retries : 3,
      state: "ACTIVATABLE",
      createdMs: this.nowMs(),
    };
    this.jobs.set(j.key, j);
    s.jobKey = j.key;
    this.record("JOB", "CREATED", j.key, { type, retries: j.retries, customHeaders: headers }, j);
    this.notifyJobs();
  }

  private createUserTask(s: Scope, def: ElementDef): void {
    const ctx = this.context(s.key);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(",").map((x) => x.trim()) : []);
    let t: UserTask;
    try {
      const u = def.userTask ?? {};
      t = {
        key: this.key(),
        elementInstanceKey: s.key,
        processInstanceKey: s.processInstanceKey,
        processDefinitionKey: s.processDefinitionKey,
        bpmnProcessId: s.bpmnProcessId,
        elementId: def.id,
        name: def.name,
        assignee: (feelValue(u.assignee, ctx, this.env) as string | null) ?? null,
        candidateGroups: list(feelValue(u.candidateGroups, ctx, this.env)),
        candidateUsers: list(feelValue(u.candidateUsers, ctx, this.env)),
        formKey: u.formKey ?? null,
        dueDate: (feelValue(u.dueDate, ctx, this.env) as string | null) ?? null,
        state: "CREATED",
        creationDate: this.nowIso(),
      };
    } catch (e) {
      return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.createUserTask(s, def));
    }
    this.userTasks.set(t.key, t);
    s.userTaskKey = t.key;
    this.record("USER_TASK", "CREATED", t.key, { assignee: t.assignee, candidateGroups: t.candidateGroups }, s);
  }

  private openBoundaries(s: Scope, def: ElementDef): void {
    const p = this.process(s);
    for (const bid of def.boundaries) {
      const b = p.elements.get(bid) as ElementDef;
      if (b.event?.kind === "timer") this.openTimer(s, b, bid);
      if (b.event?.kind === "message") this.openSubscription(s, b, bid);
    }
  }

  private openSubscription(s: Scope, def: ElementDef, boundaryId: string | undefined): void {
    const ck = def.event?.correlationKey;
    const value = ck ? feelValue(ck, this.context(s.key), this.env) : "";
    if (value === null || value === undefined || (typeof value !== "string" && typeof value !== "number")) {
      throw new FeelError(ck ?? "", `the correlation key must be a string or a number, got ${JSON.stringify(value)}`);
    }
    const sub: Subscription = {
      key: this.key(),
      processInstanceKey: s.processInstanceKey,
      elementInstanceKey: s.key,
      boundaryId,
      messageName: def.event?.messageName ?? "",
      correlationKey: String(value),
      open: true,
    };
    this.subscriptions.set(sub.key, sub);
    this.record("MESSAGE_SUBSCRIPTION", "CREATED", sub.key, { messageName: sub.messageName, correlationKey: sub.correlationKey, boundary: !!boundaryId }, s);
    const now = this.nowMs();
    const buffered = [...this.messages.values()].find((m) => m.name === sub.messageName && m.correlationKey === sub.correlationKey && m.expiresMs > now && !m.correlatedTo.has(sub.processInstanceKey));
    if (buffered) {
      buffered.correlatedTo.add(sub.processInstanceKey);
      this.correlate(sub, buffered);
    }
  }

  private openTimer(s: Scope, def: ElementDef, boundaryId: string | undefined): void {
    const t = def.event?.timer ?? {};
    const ctx = this.context(s.key);
    const now = this.nowMs();
    let dueMs: number;
    let repetitions: number | null = 1;
    let intervalMs: number | undefined;
    try {
      if (t.duration) dueMs = now + parseIsoDuration(String(feelValue(t.duration, ctx, this.env)));
      else if (t.date) dueMs = new Date(String(feelValue(t.date, ctx, this.env))).getTime();
      else if (t.cycle) {
        const c = parseCycle(String(feelValue(t.cycle, ctx, this.env)));
        repetitions = c.repetitions;
        intervalMs = c.intervalMs;
        dueMs = now + c.intervalMs;
      } else throw new FeelError("", `${def.id}: timer without a definition`);
      if (!Number.isFinite(dueMs)) throw new FeelError(t.date ?? "", "not a valid date");
    } catch (e) {
      if (boundaryId) throw e;
      return this.raiseIncident(s, "EXTRACT_VALUE_ERROR", (e as Error).message, () => this.openTimer(s, def, boundaryId));
    }
    const timer: Timer = { key: this.key(), processInstanceKey: s.processInstanceKey, elementInstanceKey: s.key, boundaryId, dueMs, repetitions, intervalMs, open: true };
    this.timers.set(timer.key, timer);
    this.record("TIMER", "CREATED", timer.key, { dueDate: new Date(dueMs).toISOString(), boundary: !!boundaryId, elementId: boundaryId ?? def.id }, s);
  }

  private fireTimer(t: Timer): void {
    const s = this.scopes.get(t.elementInstanceKey) as Scope;
    this.record("TIMER", "TRIGGERED", t.key, { elementId: t.boundaryId ?? s.elementId }, s);
    if (t.intervalMs && (t.repetitions === null || t.repetitions > 1)) {
      t.dueMs += t.intervalMs;
      if (t.repetitions !== null) t.repetitions--;
    } else t.open = false;
    if (t.boundaryId) return this.triggerBoundary(s, t.boundaryId, {});
    this.completeElement(s);
  }

  private correlate(sub: Subscription, msg: BufferedMessage): void {
    const s = this.scopes.get(sub.elementInstanceKey) as Scope;
    this.record("MESSAGE_SUBSCRIPTION", "CORRELATED", sub.key, { messageName: sub.messageName, correlationKey: sub.correlationKey, messageKey: msg.key }, s);
    sub.open = false;
    if (sub.boundaryId) return this.triggerBoundary(s, sub.boundaryId, msg.variables);
    this.completeElement(s, msg.variables);
  }

  private triggerBoundary(host: Scope, boundaryId: string, vars: Vars): void {
    if (host.state !== "ACTIVE") return;
    const b = this.process(host).elements.get(boundaryId) as ElementDef;
    const flowScope = this.scopes.get(host.parentKey as string) as Scope;
    if (b.event?.interrupting !== false) this.terminate(host);
    const ev = this.activateDeferred(b, flowScope);
    this.completeElement(ev, vars);
  }

  /** Create an element instance without entering it (boundary events complete with the trigger's variables). */
  private activateDeferred(def: ElementDef, flowScope: Scope): Scope {
    const s: Scope = {
      key: this.key(),
      processInstanceKey: flowScope.processInstanceKey,
      processDefinitionKey: flowScope.processDefinitionKey,
      bpmnProcessId: flowScope.bpmnProcessId,
      elementId: def.id,
      elementName: def.name,
      elementType: def.type,
      parentKey: flowScope.key,
      state: "ACTIVE",
      vars: {},
      startDate: this.nowIso(),
      joins: {},
    };
    this.scopes.set(s.key, s);
    this.addChild(flowScope.key, s.key);
    this.record("PROCESS_INSTANCE", "ELEMENT_ACTIVATED", s.key, { elementType: def.type.toUpperCase(), elementName: def.name }, s);
    return s;
  }

  private closeWaits(s: Scope): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.elementInstanceKey === s.key && sub.open) {
        sub.open = false;
        this.record("MESSAGE_SUBSCRIPTION", "DELETED", sub.key, { messageName: sub.messageName }, s);
      }
    }
    for (const t of this.timers.values()) {
      if (t.elementInstanceKey === s.key && t.open) {
        t.open = false;
        this.record("TIMER", "CANCELED", t.key, {}, s);
      }
    }
  }

  /** Find the nearest error boundary event that catches this code, from `from` outwards; else raise an incident. */
  private propagateError(from: Scope, errorCode: string, errorMessage: string, vars: Vars, thrower?: Scope): void {
    const origin = thrower ?? from;
    for (let s: Scope | undefined = from; s && s.elementType !== "process"; s = s.parentKey ? this.scopes.get(s.parentKey) : undefined) {
      if (s.elementType === "adHocInner") continue;
      const def = this.def(s);
      const p = this.process(s);
      const catcher =
        def.boundaries.map((id) => p.elements.get(id) as ElementDef).find((b) => b.event?.kind === "error" && b.event.errorCode === errorCode) ??
        def.boundaries.map((id) => p.elements.get(id) as ElementDef).find((b) => b.event?.kind === "error" && !b.event.errorCode);
      if (catcher) {
        this.record("PROCESS_INSTANCE", "ERROR_CAUGHT", this.key(), { errorCode, errorMessage, caughtBy: catcher.id }, s);
        return this.triggerBoundary(s, catcher.id, { ...vars, errorCode, errorMessage });
      }
    }
    const target = origin.state === "ACTIVE" ? origin : from;
    this.raiseIncident(target, "UNHANDLED_ERROR_EVENT", `error ${errorCode} was not caught: ${errorMessage}`, () => this.propagateError(from, errorCode, errorMessage, vars, thrower));
  }

  private raiseIncident(s: Scope, type: IncidentType, message: string, retry: () => void, jobKey?: string): void {
    const inc: Incident = {
      key: this.key(),
      processInstanceKey: s.processInstanceKey,
      bpmnProcessId: s.bpmnProcessId,
      elementId: s.elementId,
      elementInstanceKey: s.key,
      errorType: type,
      errorMessage: message,
      state: "ACTIVE",
      creationTime: this.nowIso(),
      jobKey,
    };
    this.incidents.set(inc.key, inc);
    this.retryActions.set(inc.key, retry);
    s.incidentKey = inc.key;
    this.record("INCIDENT", "CREATED", inc.key, { errorType: type, errorMessage: message, jobKey }, s);
  }

  // helpers ---------------------------------------------------------------------------------------------------------

  private activeJob(jobKey: string): Job {
    const j = this.jobs.get(jobKey);
    if (!j || (j.state !== "ACTIVATED" && j.state !== "ACTIVATABLE")) throw new EngineError("NOT_FOUND", `no active job ${jobKey}`);
    return j;
  }

  private process(s: Scope): ProcessDef {
    return this.processes.get(s.processDefinitionKey) as ProcessDef;
  }

  private def(s: Scope): ElementDef {
    return this.process(s).elements.get(s.elementId) as ElementDef;
  }

  private addChild(parent: string, child: string): void {
    const set = this.children.get(parent) ?? new Set();
    set.add(child);
    this.children.set(parent, set);
  }

  private removeChild(s: Scope): void {
    if (s.parentKey) this.children.get(s.parentKey)?.delete(s.key);
  }

  private notifyJobs(): void {
    const w = this.jobWaiters;
    this.jobWaiters = [];
    for (const f of w) f();
  }

  private key(): string {
    const k = this.nextKey;
    this.nextKey += 1n;
    return k.toString();
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private record(
    valueType: EngineRecord["valueType"],
    intent: string,
    key: string,
    value: Record<string, unknown>,
    s?: { processInstanceKey: string; bpmnProcessId: string; elementId: string },
  ): void {
    const r: EngineRecord = {
      position: this.records.length + 1,
      timestamp: this.nowIso(),
      valueType,
      intent,
      key,
      processInstanceKey: s?.processInstanceKey,
      bpmnProcessId: s?.bpmnProcessId,
      elementId: s?.elementId,
      value,
    };
    this.records.push(r);
    for (const l of this.listeners) l(r);
  }
}

function setPath(target: Vars, path: string, value: unknown): void {
  const parts = path.split(".");
  let o: Vars = target;
  for (const p of parts.slice(0, -1)) {
    if (typeof o[p] !== "object" || o[p] === null || Array.isArray(o[p])) o[p] = {};
    o = o[p] as Vars;
  }
  o[parts.at(-1) as string] = value;
}
