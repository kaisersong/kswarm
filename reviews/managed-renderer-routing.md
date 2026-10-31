# Auto routing for managed renderers

Defect: auto delivery_review selects a sealed task workflow with read/write/edit only, which cannot invoke the managed renderer. Use the existing capable direct project worker for an unambiguous initial managed HTML delivery. Do not expand the sealed registry or reroute active tasks.

Only consider this exception when inferWorkflowReasonCode originally returns delivery_review. Preserve higher-priority rework, retry and blocked reasons and every existing explicit quality request (all booleans, executionContract flags and evidence/adversarial/reviewer text). Include string acceptanceCriteria in taskText so these requests cannot be lost.

A structured report_html/slide_html output (including canonical aliases) proves the current HTML requirement. Otherwise require supported renderer identifier, HTML and a render/generate/output action in the current title, without preparation or downstream-use language. Brief-only co-occurrence is insufficient; explicit Markdown/IR-only requiredOutputs retain the original strategy. Ambiguous tasks, manual overrides and project direct/workflow_preferred modes retain their original selection.

The selected reason is managed_renderer_direct. Existing HTML file/type validation, PO review and final user approval are unchanged. Submission is never automatic done. Explicit artifact-only workflows still cannot invoke renderers; this change does not claim otherwise.

Independent gpt-6-astra design review initially BLOCKed broader matching; revised design APPROVE covers only the rules above. Regression test/managed-renderer-routing.test.js covers positive and negative routing, all explicit quality flags and string/array criteria, recovery priority, overrides, real Hub dispatch, missing HTML rejection, submitted state and a real PO rejection. Initial RED: 5/6 failures. Full validation and final CODE review are recorded below.
