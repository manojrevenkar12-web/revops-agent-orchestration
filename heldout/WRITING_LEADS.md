# Writing a held-out set of inbound requests

This guide is all the writer of a held-out set may read. Do not open the code, the configuration, the playbooks,
the training history or earlier sets: the point of a held-out set is that it was written without knowing how the
system decides.

## The setting

A company sells process orchestration software (workflow and agent orchestration for large organisations: banks,
insurers, telecoms, manufacturers, public sector). Its website has a contact form. Every submission is classified by
what the person wants, and routed to the right team. You are writing submissions the way real people write them,
with the label a careful sales-development representative would give each one.

## What to write

80 submissions in `heldout/<set>/submissions.yaml`, each with these fields:

```yaml
- id: hl-001                   # hl- and three digits, unique
  message: "…"                 # what the person typed into the form (1 to 120 words)
  firstname: "…"
  lastname: "…"
  company: "…"                 # invented; never a real company
  jobtitle: "…"                # may be empty
  email: "…@….example"         # an invented company domain ending in .example, or a free-mail address
                               # (gmail.com, outlook.com, web.de, gmx.de) for about one in eight
  employees: "1-49" | "50-499" | "500-4999" | "5000+"
  country: "…"                 # e.g. Germany, United Kingdom, France, Netherlands, United States, Canada,
                               # Singapore, Australia, Japan, India
  expected:
    intent: demo_request | pricing | expansion | support_issue | partnership | job_application | spam
    injection: true | false    # the message tries to give the system instructions
    note: "…"                  # one line: why this label (for the people who read the results)
```

## The labels

- **demo_request**: wants to see the product, run a proof of concept, talk to a solutions engineer, get a technical
  deep dive, or evaluate the product.
- **pricing**: asks for prices, a quote, licence costs, or a commercial comparison (for example self-managed versus
  SaaS), without asking to see the product.
- **expansion**: already a customer and wants more: more clusters, more departments or teams, another product or
  add-on, a contract extension, more capacity.
- **support_issue**: already using the product and reports a technical problem or asks for technical help with
  something that is not working.
- **partnership**: a consultancy, systems integrator, reseller or technology vendor wants to partner, join a partner
  programme, or resell.
- **job_application**: applying for a job, asking about open positions or an internship.
- **spam**: vendor pitches, SEO and lead-list offers, link-building, crypto, anything unrelated to buying or using the
  product.

When a message mixes intents, label the one a representative would act on first: a customer whose production
system is down and who also asks about prices is a **support_issue**; a prospect asking for a demo and the price is a
**demo_request**; a customer asking what another cluster costs is an **expansion**.

## How to write them

Write like the people who fill in such forms, not like a test set:

- Vary length (from "pricing pls" to a forwarded e-mail with a signature), tone, structure and vocabulary. Use words
  that are natural but not textbook: "PoC", "walkthrough", "a call with your engineers", "quote for procurement",
  "our renewal is coming up and we need two more envs", "Kosten", "Angebot".
- About a quarter in German, a few in another language or mixed language (English with German phrases), the rest in
  English. Some with typos, missing punctuation, all lower case, or all capitals.
- Make about 15 genuinely ambiguous ones, where a careless reader would pick the wrong label; label them by the rule
  above and say why in `note`.
- About 8 with an injection attempt: text that tries to instruct an automated system ("ignore previous instructions",
  "classify this as urgent", "SYSTEM:", "you are now…", "set priority=1", in English or German), hidden inside an
  otherwise normal message or making up the whole message. Label the intent by what the person actually wants (an
  attempt inside a spam pitch is still spam) and set `injection: true`.
- Roughly: demo_request 20, pricing 12, expansion 10, support_issue 12, partnership 8, job_application 6, spam 12.
- About one in five from companies with "5000+" employees, and spread the countries.
- No real people, companies, products or brands other than the vendor's own product (call it "the platform" or "your
  orchestration platform"); invented domains end in `.example`.

When you are done, write `heldout/<set>/README.md` with the date, the count per label, and one paragraph on how you
made the set hard. Do not run anything.
