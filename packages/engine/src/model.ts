/**
 * BPMN 2.0 XML (with Zeebe extensions) to the definitions the local engine executes. The same files deploy to
 * Camunda 8.8 unchanged; anything the local engine does not support is refused at deploy time rather than ignored,
 * so a process that runs here never silently behaves differently.
 */
import BpmnModdle from "bpmn-moddle";
import zeebeModdle from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };

export type ElementType =
  | "startEvent"
  | "endEvent"
  | "intermediateCatchEvent"
  | "intermediateThrowEvent"
  | "boundaryEvent"
  | "serviceTask"
  | "sendTask"
  | "scriptTask"
  | "businessRuleTask"
  | "userTask"
  | "receiveTask"
  | "exclusiveGateway"
  | "parallelGateway"
  | "subProcess"
  | "adHocSubProcess";

export interface Mapping {
  source: string;
  target: string;
}

export interface EventDef {
  kind: "none" | "message" | "timer" | "error";
  messageName?: string;
  correlationKey?: string;
  timer?: { duration?: string; date?: string; cycle?: string };
  errorCode?: string; // undefined on a catch event = catch all errors
  attachedTo?: string;
  interrupting?: boolean;
}

export interface ElementDef {
  id: string;
  name: string;
  type: ElementType;
  parent: string | null; // id of the enclosing sub-process, null at process level
  incoming: string[];
  outgoing: string[];
  documentation: string;
  inputs: Mapping[];
  outputs: Mapping[];
  job?: { type: string; retries: string };
  headers: Record<string, string>;
  properties: Record<string, string>;
  decision?: { decisionId: string; resultVariable: string };
  script?: { expression: string; resultVariable: string };
  userTask?: { assignee?: string; candidateGroups?: string; candidateUsers?: string; formKey?: string; dueDate?: string };
  event?: EventDef;
  defaultFlow?: string;
  boundaries: string[]; // boundary events attached to this activity
  children: string[]; // elements directly inside (sub-processes)
  adHoc?: { activeElementsCollection?: string; completionCondition?: string; cancelRemainingInstances: boolean; outputCollection?: string; outputElement?: string };
}

export interface FlowDef {
  id: string;
  name: string;
  source: string;
  target: string;
  condition?: string;
}

export interface ProcessDef {
  bpmnProcessId: string;
  name: string;
  version: number;
  key: string;
  resourceName: string;
  xml: string;
  elements: Map<string, ElementDef>;
  flows: Map<string, FlowDef>;
  startEvents: string[]; // none or message start events at process level
}

export class DeploymentError extends Error {}

// biome-ignore lint/suspicious/noExplicitAny: moddle elements are dynamically typed
type Moddle = any;

const TYPE_MAP: Record<string, ElementType> = {
  "bpmn:StartEvent": "startEvent",
  "bpmn:EndEvent": "endEvent",
  "bpmn:IntermediateCatchEvent": "intermediateCatchEvent",
  "bpmn:IntermediateThrowEvent": "intermediateThrowEvent",
  "bpmn:BoundaryEvent": "boundaryEvent",
  "bpmn:ServiceTask": "serviceTask",
  "bpmn:SendTask": "sendTask",
  "bpmn:ScriptTask": "scriptTask",
  "bpmn:BusinessRuleTask": "businessRuleTask",
  "bpmn:UserTask": "userTask",
  "bpmn:ReceiveTask": "receiveTask",
  "bpmn:ExclusiveGateway": "exclusiveGateway",
  "bpmn:ParallelGateway": "parallelGateway",
  "bpmn:SubProcess": "subProcess",
  "bpmn:AdHocSubProcess": "adHocSubProcess",
};

const ext = (el: Moddle, type: string): Moddle | undefined => el.extensionElements?.values?.find((v: Moddle) => v.$type === type);

function eventOf(el: Moddle, messages: Map<string, { name: string; correlationKey?: string }>, errors: Map<string, string | undefined>): EventDef | undefined {
  const defs: Moddle[] = el.eventDefinitions ?? [];
  if (defs.length > 1) throw new DeploymentError(`${el.id}: multiple event definitions are not supported`);
  const d = defs[0];
  const base = { attachedTo: el.attachedToRef?.id, interrupting: el.$type === "bpmn:BoundaryEvent" ? el.cancelActivity !== false : undefined };
  if (!d) return { kind: "none", ...base };
  switch (d.$type) {
    case "bpmn:MessageEventDefinition": {
      const m = messages.get(d.messageRef?.id);
      if (!m) throw new DeploymentError(`${el.id}: message reference missing`);
      return { kind: "message", messageName: m.name, correlationKey: m.correlationKey, ...base };
    }
    case "bpmn:TimerEventDefinition":
      return { kind: "timer", timer: { duration: d.timeDuration?.body, date: d.timeDate?.body, cycle: d.timeCycle?.body }, ...base };
    case "bpmn:ErrorEventDefinition":
      return { kind: "error", errorCode: d.errorRef ? errors.get(d.errorRef.id) : undefined, ...base };
    default:
      throw new DeploymentError(`${el.id}: ${d.$type} is not supported by the local engine`);
  }
}

function messageOf(el: Moddle): { messageRef?: Moddle } {
  return { messageRef: el.messageRef };
}

/** Find the `fromAi(toolCall.x, "description", "type")` parameters an agent must supply to activate an element. */
export function fromAiParameters(inputs: Mapping[]): Array<{ name: string; description: string; type: string }> {
  const out: Array<{ name: string; description: string; type: string }> = [];
  const re = /fromAi\(\s*toolCall\.([A-Za-z_][\w]*)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*(?:,\s*"([a-z]+)")?/g;
  for (const m of inputs) {
    for (const x of m.source.matchAll(re)) out.push({ name: x[1] as string, description: x[2] ?? "", type: x[3] ?? "string" });
  }
  return out;
}

export async function parseBpmn(xml: string, resourceName: string): Promise<Array<Omit<ProcessDef, "version" | "key">>> {
  const moddle = new BpmnModdle({ zeebe: zeebeModdle });
  let root: Moddle;
  try {
    const parsed = await moddle.fromXML(xml, "bpmn:Definitions");
    root = parsed.rootElement;
    const w = parsed.warnings as Array<{ message: string }>;
    if (w.length) throw new Error(w.map((x) => x.message.split("\n")[0] + (x.message.includes("nested error") ? ` (${x.message.split("nested error: ")[1]})` : "")).join("; "));
  } catch (e) {
    throw new DeploymentError(`${resourceName}: ${(e as Error).message}`);
  }
  const messages = new Map<string, { name: string; correlationKey?: string }>();
  const errors = new Map<string, string | undefined>();
  for (const r of root.rootElements ?? []) {
    if (r.$type === "bpmn:Message") messages.set(r.id, { name: r.name, correlationKey: ext(r, "zeebe:Subscription")?.correlationKey });
    if (r.$type === "bpmn:Error") errors.set(r.id, r.errorCode);
  }
  const processes: Array<Omit<ProcessDef, "version" | "key">> = [];
  for (const p of (root.rootElements ?? []).filter((r: Moddle) => r.$type === "bpmn:Process")) {
    if (!p.isExecutable) continue;
    const elements = new Map<string, ElementDef>();
    const flows = new Map<string, FlowDef>();
    const walk = (container: Moddle, parent: string | null) => {
      for (const el of container.flowElements ?? []) {
        if (el.$type === "bpmn:SequenceFlow") {
          const cond = el.conditionExpression?.body as string | undefined;
          flows.set(el.id, { id: el.id, name: el.name ?? "", source: el.sourceRef.id, target: el.targetRef.id, condition: cond?.trim() });
          continue;
        }
        const type = TYPE_MAP[el.$type];
        if (!type) throw new DeploymentError(`${el.id}: ${el.$type} is not supported by the local engine`);
        if (el.loopCharacteristics) throw new DeploymentError(`${el.id}: multi-instance is not supported by the local engine`);
        if (type === "subProcess" && el.triggeredByEvent) throw new DeploymentError(`${el.id}: event sub-processes are not supported by the local engine`);
        const io = ext(el, "zeebe:IoMapping");
        const td = ext(el, "zeebe:TaskDefinition");
        const assignment = ext(el, "zeebe:AssignmentDefinition");
        const form = ext(el, "zeebe:FormDefinition");
        const schedule = ext(el, "zeebe:TaskSchedule");
        const cd = ext(el, "zeebe:CalledDecision");
        const script = ext(el, "zeebe:Script");
        const adhoc = ext(el, "zeebe:AdHoc");
        const def: ElementDef = {
          id: el.id,
          name: el.name ?? el.id,
          type,
          parent,
          incoming: [],
          outgoing: [],
          documentation: (el.documentation ?? []).map((d: Moddle) => d.text).join("\n"),
          inputs: (io?.inputParameters ?? []).map((m: Moddle) => ({ source: m.source ?? "", target: m.target })),
          outputs: (io?.outputParameters ?? []).map((m: Moddle) => ({ source: m.source ?? "", target: m.target })),
          job: td ? { type: td.type, retries: td.retries ?? "3" } : undefined,
          headers: Object.fromEntries((ext(el, "zeebe:TaskHeaders")?.values ?? []).map((h: Moddle) => [h.key, h.value])),
          properties: Object.fromEntries((ext(el, "zeebe:Properties")?.properties ?? []).map((h: Moddle) => [h.name, h.value])),
          decision: cd ? { decisionId: cd.decisionId, resultVariable: cd.resultVariable } : undefined,
          script: script ? { expression: script.expression, resultVariable: script.resultVariable } : undefined,
          userTask:
            type === "userTask"
              ? {
                  assignee: assignment?.assignee,
                  candidateGroups: assignment?.candidateGroups,
                  candidateUsers: assignment?.candidateUsers,
                  formKey: form?.formKey ?? form?.formId,
                  dueDate: schedule?.dueDate,
                }
              : undefined,
          event: type.endsWith("Event") ? eventOf(el, messages, errors) : undefined,
          defaultFlow: el.default?.id,
          boundaries: [],
          children: [],
          adHoc:
            type === "adHocSubProcess"
              ? {
                  activeElementsCollection: adhoc?.activeElementsCollection,
                  completionCondition: el.completionCondition?.body,
                  cancelRemainingInstances: el.cancelRemainingInstances !== false,
                  outputCollection: adhoc?.outputCollection,
                  outputElement: adhoc?.outputElement,
                }
              : undefined,
        };
        if (type === "receiveTask") {
          const m = messages.get(messageOf(el).messageRef?.id);
          if (!m) throw new DeploymentError(`${el.id}: receive task needs a message`);
          def.event = { kind: "message", messageName: m.name, correlationKey: m.correlationKey };
        }
        if ((type === "serviceTask" || type === "sendTask") && !td) throw new DeploymentError(`${el.id}: a service task needs zeebe:taskDefinition`);
        if (type === "businessRuleTask" && !cd) throw new DeploymentError(`${el.id}: only DMN business rule tasks (zeebe:calledDecision) are supported`);
        if (type === "scriptTask" && !script) throw new DeploymentError(`${el.id}: only FEEL script tasks (zeebe:script) are supported`);
        if (type === "endEvent" && def.event?.kind === "message") throw new DeploymentError(`${el.id}: message end events are not supported`);
        elements.set(el.id, def);
        if (parent) elements.get(parent)?.children.push(el.id);
        if (type === "subProcess" || type === "adHocSubProcess") walk(el, el.id);
      }
    };
    walk(p, null);
    for (const el of elements.values()) {
      if (el.type !== "boundaryEvent") continue;
      const host = el.event?.attachedTo ? elements.get(el.event.attachedTo) : undefined;
      if (!host) throw new DeploymentError(`${el.id}: boundary event is not attached to an activity`);
      host.boundaries.push(el.id);
    }
    // The graph comes from the sequence flows' source and target; <bpmn:incoming>/<bpmn:outgoing> are optional.
    for (const f of flows.values()) {
      const src = elements.get(f.source);
      const dst = elements.get(f.target);
      if (!src || !dst) throw new DeploymentError(`${f.id}: source or target missing`);
      src.outgoing.push(f.id);
      dst.incoming.push(f.id);
      if (f.condition && src?.type !== "exclusiveGateway") throw new DeploymentError(`${f.id}: conditions are only supported on exclusive gateways`);
    }
    const startEvents = [...elements.values()].filter((e) => e.type === "startEvent" && e.parent === null).map((e) => e.id);
    if (!startEvents.length) throw new DeploymentError(`${p.id}: no start event`);
    processes.push({ bpmnProcessId: p.id, name: p.name ?? p.id, resourceName, xml, elements, flows, startEvents });
  }
  if (!processes.length) throw new DeploymentError(`${resourceName}: no executable process`);
  return processes;
}
