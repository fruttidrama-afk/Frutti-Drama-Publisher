# FLOW AI IMPLEMENTATION BRIEF

Use the exact target Flow project. Never confuse project title with the rich-text prompt composer. Verify Video/model/ratio/duration/output settings. Insert and read back the prompt. Capture a project-grid baseline. Persist SUBMIT_BOUNDARY_ENTERED and automatic_submit_forbidden=true before the non-idempotent submit.

The verified submit action is the right-arrow `arrow_forward` inside `flow-generate-icon-button`, accessible as `Iniciar generación` / `Start generation`. Click it exactly once per authorized generation intent.

Only handle a permission message created after the current boundary. No dialog is valid when the profile is already approved.

Do not treat click success, disabled controls, generic busy text, chat `flow-a2ui-video-option`, or guessed Network request names as sole generation proof. Prefer a unique post-baseline video tile in the exact project.

Run strictly serially: generate one → wait → recover that one from the project grid → download → validate → generate final title/description/hashtags → REVIEW_READY → only then generate the next.

On post-boundary uncertainty, reconcile read-only and never blindly resend.

Earth in 10: normal target 3/day. Temporary 2026-09-21 test target 6/day only, auto-expiring back to 3/day. Review must show publication-ready metadata.