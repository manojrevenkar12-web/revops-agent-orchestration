# 0004 A local engine for tests, checked against Camunda's client and lint

Status: accepted

Zeebe could not run in the build environment (no container images, no Maven). Rather than mocking job workers, the
processes run on a local engine for the subset they use, which refuses unsupported BPMN at deploy time. Its REST API
is exercised by Camunda's generated 8.8 client with strict response validation (which caught missing and null
fields), and the BPMN passes Camunda's 8.8 compatibility lint (which caught the missing tool-container marker on the
agent's ad-hoc sub-process). Production runs on Camunda 8.8 SaaS; the workers use the same client there.
