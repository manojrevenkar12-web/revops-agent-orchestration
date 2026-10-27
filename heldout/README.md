# Held-out sets

A held-out set is written by someone who has not seen the code, from the writing guide only
(`WRITING_LEADS.md`), and is run once. Its first run (`reports/heldout/<set>/first_run.json`) is pinned by hash in
`reports/heldout/PINS` and never rewritten; CI checks the hashes.

If anyone studies a set's failures to change the classifier, prompts or thresholds, the set becomes a regression set
(write `regression` to `heldout/<set>/STATUS`) and a new set is written from the guide by someone else.

| Set | Written | Status | First run |
| --- | --- | --- | --- |
| leads-v1 | 2026-10-27, by a writer who read only the guide | held out | intent accuracy 0.513; 0 of 80 routed without a person |
