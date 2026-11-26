# Synthesis candidate format

The synthesis caller omitted expectedFormat, so a selected HTML artifact registered as Markdown and received the Markdown format check. Infer the format hint only from the actual selected path extension (case normalized), leaving unknown extensions on the original default. Do not infer from arbitrary kind/type or path substrings. Existing containment, existence, contents and service hash validation remain authoritative; an enrichment call alone is not proof of a valid file.

Only the synthesis caller changes. Other callers' explicit expectedFormat, idempotency, PO/all-tasks-done gates and final user-only approval stay unchanged. Existing candidates are never rewritten. A newly generated HTML candidate has a distinct fingerprint; repeated identical new submissions reuse it. HTML validation remains the pre-existing coarse syntax check, not a new semantic or security validator.

Independent gpt-6-astra DESIGN APPROVE. Real isolated HTTP regression test/synthesis-final-format.test.js fails on baseline and passes on candidate. It covers HTML, Markdown, unknown defaults, plain text masquerading as HTML, missing/outside files, invalid PO, stable retry, historical candidate preservation and awaiting_user_approval. Child server is stopped and its temporary workspace removed. Full regression and final CODE review are recorded separately.
