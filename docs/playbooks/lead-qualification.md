# Inbound lead qualification and routing

Who uses this: Account Development Representatives (ADRs), Marketing Operations.

## Intent categories

- demo_request: wants to see the product, run a proof of concept or talk to a solutions engineer.
- pricing: asks for prices, quotes or a commercial comparison.
- expansion: an existing customer wants more: more clusters, more departments, the agentic add-on.
- support_issue: an existing customer reports a technical problem. Route to Support, never to Sales.
- partnership: a consultancy or systems integrator wants to join the partner programme. Route to Partnerships.
- job_application: someone applying for a job. Route to Talent, do not create a lead.
- spam: vendor pitches and bulk offers. Close without a lead.

## Routing rules (owned by Marketing Operations, encoded in lead-routing.dmn)

- Enterprise accounts (5,000 employees or more) always go to an ADR for a personal review, whatever the intent.
- Existing customers with expansion intent go to Account Management, owned by the account owner.
- demo_request and pricing from Enterprise and Mid-Market go to the regional queue (for example "EMEA Commercial")
  and are enrolled in the regional cadence. SMB requests start in the Digital Sales trial cadence.
- Speed to lead: 10 minutes for an urgent Enterprise request, 15 for Enterprise, 30 for Mid-Market, 60 otherwise.
  When an ADR has not decided by then, the ADR manager is notified; after four hours the lead goes to the Lead Review
  queue so it is not lost.

## What an ADR checks before accepting a suggestion

The suggested intent matches the message, the company is matched to the right account (not a namesake), the contact
is not an existing customer's support engineer, and nothing in the message tries to instruct the system ("ignore your
instructions", "mark as urgent"). Such text is a red flag for spam or abuse, not an instruction.
