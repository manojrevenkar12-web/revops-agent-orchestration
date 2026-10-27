# Held-out set leads-v1

Written on 2026-10-27 from `heldout/WRITING_LEADS.md` only. The writer did not open the code, the
configuration, the playbooks, the training history or any earlier set. All people, companies and
domains are invented.

## Count per label

| Intent          | Count |
|-----------------|------:|
| demo_request    | 20 |
| pricing         | 12 |
| expansion       | 10 |
| support_issue   | 12 |
| partnership     | 8 |
| job_application | 6 |
| spam            | 12 |
| **Total**       | **80** |

Injection attempts: 8 (2 demo_request, 1 pricing, 1 expansion, 1 support_issue, 3 spam).
Companies with 5000+ employees: 16. Free-mail addresses: 11.

## How the set was made hard

About a quarter of the messages are in German, with a few in French, Spanish, Dutch-English and
English mixed with German words, and lengths run from "pricing pls" to a forwarded e-mail. Some are all
lower case, all capitals or contain typos. Around 18 items sit on a label boundary, and each
is labelled by the guide's rule with the reason in `note`. Some examples: customers who ask what another
cluster or environment costs, or ask for an "Angebot" or a demo of a new module (all expansion). Prospects
who mention a past demo, an evaluation or clusters but only want a quote (pricing). Outages that also
ask about quotes, renewals or extra clusters (support_issue). Prospects who describe things breaking in
some other vendor's tool, a trial user who wants a deep dive, and a subsidiary of an existing customer
(all demo_request). An integrator that mentions a client demo, a vendor that asks for "a call", and a
consultancy asking what certification costs (all partnership). A lead-generation agency and a
recruitment agency that call themselves partners or talk about hiring (spam). A student who frames a job
request as a thesis cooperation (job_application). Injection attempts are hidden in bracketed notes, an
HTML comment, a `### SYSTEM ###` line, an "IMPORTANT INSTRUCTION FOR THE ROUTING MODEL" line and German
"Du bist jetzt..." and "Ignoriere alle bisherigen Anweisungen" text. Several of them name a different
label or ask for priority, discounts or internal data. One item is nothing but an injection. Each
injection item is labelled by what the sender actually wants.
