# Publisher Connection UX Standard

This is a standing Publisher Factory product rule.

Every external connection screen must be a complete guided wizard, not a bare credential form.

## Required UX
1. Explain in plain language what the user is connecting and why.
2. State whether anything must be downloaded. If nothing must be installed, say so explicitly.
3. Give a numbered step-by-step path from zero knowledge to connected state.
4. Name the exact credentials/identifiers required and explain where each one is found.
5. Include direct links to the provider's official setup surface when appropriate.
6. Render callback/redirect URLs in a copyable field with a COPY action.
7. Show exact scopes/permissions required and what each permission does.
8. Show progress states: not started, provider configured, authenticated, destination selected, connected.
9. Explain what the user should expect after each external-provider redirect.
10. Include troubleshooting for the most likely failures and changed provider menu names.
11. Never assume the user knows developer terminology such as API key, OAuth, client secret, Page Access Token, project ID, or callback URL.
12. Keep setup visually integrated with the Publisher's own branding/theme.
13. Once connected, explain exactly what the automation will do next.
14. The same standard applies to Facebook, YouTube, Google Flow, and every future connection added by Publisher Factory.

## Facebook-specific invariant
The Facebook Page wizard must explain that no Meta mobile app is required, distinguish App ID and App Secret from an “API key,” guide Meta App creation, Facebook Login, Valid OAuth Redirect URI, required Page permissions, Page selection, and final connection verification.

## Safety invariant
Connection UX must not weaken the human approval gate: unapproved review media remains local-only. A publication platform receives media only after explicit APPROVE.
