# Operating the GTM automations

Who uses this: Revenue Operations, GTM Systems.

## Pausing an automation

Every automation can be paused without a deployment: set its share of automatic actions to zero in
config/automations.yaml (or the console's automation page), and every case goes to a person. In-flight process
instances finish their current step and then wait for a person.

## When a person disagrees with the automation

Every approval, edit and rejection is recorded with the automation's suggestion and its calibrated probability. The
weekly review looks at the override rate per automation and per segment. An override rate above 15 % for two weeks
means the threshold is too low or the model has drifted; raise the threshold first, then investigate.

## Salesforce API budget

Automations use at most 80 % of the org's daily API allowance. Below 20 % remaining, background work (resyncs, bulk
reads, enrichment) pauses; interactive work (a person is waiting) continues until 5 % remain. If the budget pauses
work, the console shows it and the work resumes the next day.

## Incidents

A failed step retries three times with backoff, then raises an incident in Camunda Operate with the error. Fix the
cause (a credential, a field validation rule in Salesforce), then retry the incident: the step is idempotent.
