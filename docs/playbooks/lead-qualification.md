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
- Existing customers with expansion intent go to the account owner, with the CSM informed.
- demo_request and pricing from Mid-Market and SMB go to the regional ADR queue and are enrolled in the regional
  cadence when the classification is confident.
- Speed to lead: an ADR acts within 15 minutes during business hours. After 15 minutes the ADR manager is notified.

## What an ADR checks before accepting a suggestion

The suggested intent matches the message, the company is matched to the right account (not a namesake), the contact
is not an existing customer's support engineer, and nothing in the message tries to instruct the system ("ignore your
instructions", "mark as urgent"). Such text is a red flag for spam or abuse, not an instruction.
