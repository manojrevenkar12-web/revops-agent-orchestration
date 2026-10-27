/**
 * The Orchestration Cluster REST API (v2) subset that the workers and the console use, over the local engine.
 * Workers are written against @camunda8/sdk's CamundaRestClient; pointed at this server they run locally, pointed
 * at a Camunda 8.8 cluster (with OAuth) they run unchanged. Errors are RFC 9457 problem details, as in Camunda.
 */
import multipart from "@fastify/multipart";
import { ManualClock } from "@revops/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Engine, EngineError, type Scope } from "./engine";
import { DeploymentError } from "./model";

const TENANT = "<default>";

function problem(reply: FastifyReply, status: number, title: string, detail: string) {
  return reply.code(status).type("application/problem+json").send({ type: "about:blank", title, status, detail, instance: reply.request.url });
}

/** Camunda's schema has optional fields, not nullable ones: leave out what is unknown. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}

function page<T>(items: T[], body: { page?: { from?: number; limit?: number } } | undefined) {
  const from = body?.page?.from ?? 0;
  const limit = body?.page?.limit ?? 100;
  return { items: items.slice(from, from + limit), page: { totalItems: items.length } };
}

const STATUS: Record<EngineError["code"], number> = { NOT_FOUND: 404, INVALID_ARGUMENT: 400, INVALID_STATE: 409, ALREADY_EXISTS: 409 };

export function registerEngineRest(app: FastifyInstance, engine: Engine): void {
  app.register(multipart, { limits: { fileSize: 5_000_000, files: 50 } });
  // Camunda clients send commands such as incident resolution with a JSON content type and no body.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof EngineError) return problem(reply, STATUS[err.code], err.code, err.message);
    if (err instanceof DeploymentError) return problem(reply, 400, "INVALID_ARGUMENT", err.message);
    if ((err as { statusCode?: number }).statusCode === 400) return problem(reply, 400, "INVALID_ARGUMENT", err.message);
    return problem(reply, 500, "INTERNAL_ERROR", err.message);
  });

  const piView = (s: Scope) => {
    const def = engine.processes.get(s.processDefinitionKey);
    return compact({
      processInstanceKey: s.key,
      processDefinitionId: s.bpmnProcessId,
      processDefinitionName: def?.name ?? s.bpmnProcessId,
      processDefinitionVersion: def?.version ?? 1,
      processDefinitionKey: s.processDefinitionKey,
      startDate: s.startDate,
      endDate: s.endDate ?? null,
      state: s.state,
      hasIncident: [...engine.incidents.values()].some((i) => i.processInstanceKey === s.key && i.state === "ACTIVE"),
      tenantId: TENANT,
    });
  };

  app.get("/v2/topology", async () => ({
    brokers: [{ nodeId: 0, host: "localhost", port: 26501, partitions: [{ partitionId: 1, role: "leader", health: "healthy" }], version: "8.8.0-local" }],
    clusterSize: 1,
    partitionsCount: 1,
    replicationFactor: 1,
    gatewayVersion: "8.8.0-local",
    lastCompletedChangeId: "-1",
  }));

  app.post("/v2/deployments", async (req) => {
    const resources: Array<{ name: string; content: string }> = [];
    for await (const part of req.parts()) {
      if (part.type === "file") resources.push({ name: part.filename, content: (await part.toBuffer()).toString("utf8") });
    }
    if (!resources.length) throw new EngineError("INVALID_ARGUMENT", "no resources in the deployment");
    const d = await engine.deploy(resources);
    return {
      deploymentKey: d.key,
      tenantId: TENANT,
      deployments: [
        ...d.processes.map((p) => ({
          processDefinition: {
            processDefinitionId: p.bpmnProcessId,
            processDefinitionVersion: p.version,
            processDefinitionKey: p.processDefinitionKey,
            resourceName: p.resourceName,
            tenantId: TENANT,
          },
        })),
        ...d.decisions.map((x) => ({
          decisionDefinition: {
            decisionDefinitionId: x.decisionId,
            version: x.version,
            decisionDefinitionKey: x.decisionKey,
            name: x.name,
            tenantId: TENANT,
            decisionRequirementsId: x.decisionRequirementsId,
            decisionRequirementsKey: x.decisionKey,
          },
        })),
      ],
    };
  });

  app.post<{
    Body: { processDefinitionId?: string; processDefinitionKey?: string; variables?: Record<string, unknown>; awaitCompletion?: boolean; requestTimeout?: number; fetchVariables?: string[] };
  }>("/v2/process-instances", async (req) => {
    const b = req.body ?? {};
    const s = engine.createProcessInstance({ bpmnProcessId: b.processDefinitionId, processDefinitionKey: b.processDefinitionKey, variables: b.variables });
    let variables: Record<string, unknown> = {};
    if (b.awaitCompletion) {
      const done = await Promise.race([engine.awaitCompletion(s.key), new Promise<null>((r) => setTimeout(() => r(null), b.requestTimeout || 10_000))]);
      if (!done) throw new EngineError("INVALID_STATE", "the process instance did not complete within the request timeout");
      variables = b.fetchVariables?.length ? Object.fromEntries(Object.entries(done.vars).filter(([k]) => b.fetchVariables?.includes(k))) : done.vars;
    }
    const v = piView(s);
    return {
      processDefinitionKey: v.processDefinitionKey,
      processDefinitionId: v.processDefinitionId,
      processDefinitionVersion: v.processDefinitionVersion,
      processInstanceKey: s.key,
      tenantId: TENANT,
      variables,
    };
  });

  app.post<{ Params: { key: string } }>("/v2/process-instances/:key/cancellation", async (req, reply) => {
    engine.cancelProcessInstance(req.params.key);
    return reply.code(204).send();
  });

  app.post<{ Body: { filter?: { processDefinitionId?: string; state?: string; processInstanceKey?: string; hasIncident?: boolean }; page?: { from?: number; limit?: number } } }>(
    "/v2/process-instances/search",
    async (req) => {
      const f = req.body?.filter ?? {};
      const items = [...engine.scopes.values()]
        .filter((s) => s.elementType === "process")
        .map(piView)
        .filter(
          (s) =>
            (!f.processDefinitionId || s.processDefinitionId === f.processDefinitionId) &&
            (!f.state || s.state === f.state) &&
            (!f.processInstanceKey || s.processInstanceKey === f.processInstanceKey) &&
            (f.hasIncident === undefined || s.hasIncident === f.hasIncident),
        )
        .reverse();
      return page(items, req.body);
    },
  );

  app.get<{ Params: { key: string } }>("/v2/process-instances/:key", async (req) => {
    const s = engine.scopes.get(req.params.key);
    if (!s || s.elementType !== "process") throw new EngineError("NOT_FOUND", `no process instance ${req.params.key}`);
    return piView(s);
  });

  app.post<{ Body: { filter?: { processInstanceKey?: string; elementId?: string; state?: string } } & { page?: { from?: number; limit?: number } } }>("/v2/element-instances/search", async (req) => {
    const f = req.body?.filter ?? {};
    const items = [...engine.scopes.values()]
      .filter((s) => s.elementType !== "process" && s.elementType !== "adHocInner")
      .filter((s) => (!f.processInstanceKey || s.processInstanceKey === f.processInstanceKey) && (!f.elementId || s.elementId === f.elementId) && (!f.state || s.state === f.state))
      .map((s) =>
        compact({
          elementInstanceKey: s.key,
          processInstanceKey: s.processInstanceKey,
          processDefinitionId: s.bpmnProcessId,
          processDefinitionKey: s.processDefinitionKey,
          elementId: s.elementId,
          elementName: s.elementName,
          type: s.elementType.replace(/([A-Z])/g, "_$1").toUpperCase(),
          state: s.state,
          startDate: s.startDate,
          endDate: s.endDate ?? null,
          hasIncident: !!s.incidentKey,
          incidentKey: s.incidentKey ?? null,
          tenantId: TENANT,
        }),
      );
    return page(items, req.body);
  });

  app.post<{ Body: { filter?: { processInstanceKey?: string; scopeKey?: string; name?: string } } & { page?: { from?: number; limit?: number } } }>("/v2/variables/search", async (req) => {
    const f = req.body?.filter ?? {};
    const items = [...engine.scopes.values()]
      .filter((s) => (!f.processInstanceKey || s.processInstanceKey === f.processInstanceKey) && (!f.scopeKey || s.key === f.scopeKey))
      .flatMap((s) =>
        Object.entries(s.vars).map(([name, value]) => ({
          variableKey: `${s.key}-${name}`,
          name,
          value: JSON.stringify(value),
          scopeKey: s.key,
          processInstanceKey: s.processInstanceKey,
          tenantId: TENANT,
          isTruncated: false,
        })),
      )
      .filter((v) => !f.name || v.name === f.name);
    return page(items, req.body);
  });

  app.post<{ Body: { type: string; worker?: string; timeout?: number; maxJobsToActivate?: number; fetchVariable?: string[]; requestTimeout?: number } }>("/v2/jobs/activation", async (req) => {
    const b = req.body;
    const ask = () =>
      engine.activateJobs({ type: b.type, worker: b.worker ?? "default", maxJobsToActivate: Number(b.maxJobsToActivate ?? 10), timeout: Number(b.timeout ?? 300_000), fetchVariable: b.fetchVariable });
    let jobs = ask();
    const until = Date.now() + Math.min(Number(b.requestTimeout ?? 0), 30_000);
    while (!jobs.length && Date.now() < until) {
      await engine.waitForJobs(until - Date.now());
      jobs = ask();
    }
    return {
      jobs: jobs.map((j) => ({
        jobKey: j.key,
        type: j.type,
        processInstanceKey: j.processInstanceKey,
        processDefinitionId: j.bpmnProcessId,
        processDefinitionVersion: j.processDefinitionVersion,
        processDefinitionKey: j.processDefinitionKey,
        elementId: j.elementId,
        elementInstanceKey: j.elementInstanceKey,
        customHeaders: j.customHeaders,
        worker: j.worker,
        retries: j.retries,
        deadline: j.deadlineMs,
        variables: j.variables,
        tenantId: TENANT,
        kind: j.kind === "adHoc" ? "AD_HOC_SUB_PROCESS" : "BPMN_ELEMENT",
        listenerEventType: "UNSPECIFIED",
      })),
    };
  });

  app.post<{ Params: { key: string }; Body: { variables?: Record<string, unknown> | null; result?: { type: "adHocSubProcess" | "userTask" } | null } | null }>(
    "/v2/jobs/:key/completion",
    async (req, reply) => {
      engine.completeJob(req.params.key, req.body?.variables ?? {}, (req.body?.result as never) ?? null);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { key: string }; Body: { retries?: number; errorMessage?: string; retryBackOff?: number; variables?: Record<string, unknown> } }>("/v2/jobs/:key/failure", async (req, reply) => {
    engine.failJob(req.params.key, {
      retries: Number(req.body?.retries ?? 0),
      errorMessage: req.body?.errorMessage,
      retryBackOff: Number(req.body?.retryBackOff ?? 0),
      variables: req.body?.variables,
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { key: string }; Body: { errorCode: string; errorMessage?: string; variables?: Record<string, unknown> } }>("/v2/jobs/:key/error", async (req, reply) => {
    engine.throwError(req.params.key, { errorCode: req.body.errorCode, errorMessage: req.body.errorMessage, variables: req.body.variables });
    return reply.code(204).send();
  });

  app.patch<{ Params: { key: string }; Body: { changeset: { retries?: number; timeout?: number } } }>("/v2/jobs/:key", async (req, reply) => {
    const c = req.body?.changeset ?? {};
    engine.updateJob(req.params.key, { retries: c.retries === undefined ? undefined : Number(c.retries), timeout: c.timeout === undefined ? undefined : Number(c.timeout) });
    return reply.code(204).send();
  });

  app.post<{ Body: { name: string; correlationKey?: string; timeToLive?: number; messageId?: string; variables?: Record<string, unknown> } }>("/v2/messages/publication", async (req) => {
    const r = engine.publishMessage({ ...req.body, timeToLive: Number(req.body.timeToLive ?? 0) });
    return { messageKey: r.messageKey, tenantId: TENANT };
  });

  app.post<{ Body: { name: string; correlationKey?: string; variables?: Record<string, unknown> } }>("/v2/messages/correlation", async (req) => {
    const r = engine.correlateMessage(req.body);
    return { messageKey: r.messageKey, tenantId: TENANT, processInstanceKey: r.processInstanceKey };
  });

  const taskView = (t: import("./engine").UserTask) =>
    compact({
      userTaskKey: t.key,
      name: t.name,
      state: t.state,
      assignee: t.assignee,
      elementId: t.elementId,
      elementInstanceKey: t.elementInstanceKey,
      candidateGroups: t.candidateGroups,
      candidateUsers: t.candidateUsers,
      processDefinitionId: t.bpmnProcessId,
      processDefinitionKey: t.processDefinitionKey,
      processInstanceKey: t.processInstanceKey,
      formKey: t.formKey,
      creationDate: t.creationDate,
      completionDate: t.completionDate ?? null,
      dueDate: t.dueDate,
      priority: 50,
      tenantId: TENANT,
    });

  app.post<{ Body: { filter?: { state?: string; assignee?: string; processInstanceKey?: string; elementId?: string; candidateGroup?: string } } & { page?: { from?: number; limit?: number } } }>(
    "/v2/user-tasks/search",
    async (req) => {
      const f = req.body?.filter ?? {};
      const items = [...engine.userTasks.values()]
        .filter(
          (t) =>
            (!f.state || t.state === f.state) &&
            (!f.assignee || t.assignee === f.assignee) &&
            (!f.processInstanceKey || t.processInstanceKey === f.processInstanceKey) &&
            (!f.elementId || t.elementId === f.elementId) &&
            (!f.candidateGroup || t.candidateGroups.includes(f.candidateGroup)),
        )
        .map(taskView);
      return page(items, req.body);
    },
  );

  app.get<{ Params: { key: string } }>("/v2/user-tasks/:key", async (req) => {
    const t = engine.userTasks.get(req.params.key);
    if (!t) throw new EngineError("NOT_FOUND", `no user task ${req.params.key}`);
    return taskView(t);
  });

  app.post<{ Params: { key: string }; Body: { variables?: Record<string, unknown>; action?: string } | null }>("/v2/user-tasks/:key/completion", async (req, reply) => {
    engine.completeUserTask(req.params.key, req.body?.variables ?? {});
    return reply.code(204).send();
  });

  app.post<{ Params: { key: string }; Body: { assignee: string } }>("/v2/user-tasks/:key/assignment", async (req, reply) => {
    engine.assignUserTask(req.params.key, req.body.assignee);
    return reply.code(204).send();
  });

  app.post<{ Body: { filter?: { processInstanceKey?: string; state?: string; errorType?: string } } & { page?: { from?: number; limit?: number } } }>("/v2/incidents/search", async (req) => {
    const f = req.body?.filter ?? {};
    const items = [...engine.incidents.values()]
      .filter((i) => (!f.processInstanceKey || i.processInstanceKey === f.processInstanceKey) && (!f.state || i.state === f.state) && (!f.errorType || i.errorType === f.errorType))
      .map((i) =>
        compact({
          incidentKey: i.key,
          processInstanceKey: i.processInstanceKey,
          processDefinitionId: i.bpmnProcessId,
          errorType: i.errorType,
          errorMessage: i.errorMessage,
          elementId: i.elementId,
          elementInstanceKey: i.elementInstanceKey,
          creationTime: i.creationTime,
          state: i.state,
          jobKey: i.jobKey ?? null,
          tenantId: TENANT,
        }),
      );
    return page(items, req.body);
  });

  app.post<{ Params: { key: string } }>("/v2/incidents/:key/resolution", async (req, reply) => {
    engine.resolveIncident(req.params.key);
    return reply.code(204).send();
  });

  app.post<{ Body: { decisionDefinitionId: string; variables?: Record<string, unknown> } }>("/v2/decision-definitions/evaluation", async (req) => {
    const d = engine.latestDecision(req.body.decisionDefinitionId);
    if (!d) throw new EngineError("NOT_FOUND", `no decision ${req.body.decisionDefinitionId}`);
    const r = engine.evaluateDecision(req.body.decisionDefinitionId, req.body.variables ?? {});
    return {
      decisionDefinitionId: d.decisionId,
      decisionDefinitionKey: d.key,
      decisionDefinitionName: d.name,
      decisionDefinitionVersion: d.version,
      output: JSON.stringify(r.output),
      matchedRules: r.matchedRules,
      evaluatedDecisions: r.evaluated.map((e) => ({ decisionDefinitionId: e.decisionId, output: JSON.stringify(e.output), matchedRules: e.matchedRules })),
      tenantId: TENANT,
    };
  });

  app.put<{ Body: { timestamp: number } }>("/v2/clock", async (req, reply) => {
    if (!(engine.clock instanceof ManualClock)) throw new EngineError("INVALID_STATE", "the engine clock is not controlled; start the engine with a manual clock");
    const ts = Number(req.body.timestamp);
    if (ts < engine.clock.now().getTime()) throw new EngineError("INVALID_ARGUMENT", "the local engine clock only moves forward");
    engine.clock.set(new Date(ts));
    engine.tick();
    return reply.code(204).send();
  });

  // Local-only: the record stream for the console's instance history.
  app.get<{ Querystring: { processInstanceKey?: string; after?: string; limit?: string } }>("/local/records", async (req) => {
    const after = Number(req.query.after ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 500), 5000);
    return { records: engine.records.filter((r) => r.position > after && (!req.query.processInstanceKey || r.processInstanceKey === req.query.processInstanceKey)).slice(0, limit) };
  });

  app.get<{ Params: { key: string } }>("/local/process-definitions/:key/xml", async (req, reply) => {
    const p = engine.processes.get(req.params.key) ?? engine.latestProcess(req.params.key);
    if (!p) throw new EngineError("NOT_FOUND", `no process definition ${req.params.key}`);
    return reply.type("text/xml").send(p.xml);
  });
}
