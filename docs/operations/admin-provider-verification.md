# AI-service and model verification

This qualifies Agent settings: native sign-in, local/custom endpoints, explicit
model tests and choosing the agent's default. Controlled transport tests do not
prove every vendor's entitlement or OAuth flow, or certify the whole application.

## Automated checks

From the repository root:

```bash
bun test packages/lib/src/control-plane/opencode.test.ts
bun test packages/lib/src/control-plane/provider-settings.test.ts
bun test packages/electron/src/admin-providers.test.ts
bun run --cwd packages/electron test:providers:browser
bun run --cwd packages/electron test
```

The library tests use native-shaped OpenCode responses and a cached global
configuration fixture. Only a native global PATCH invalidates that fixture's
cache: a host file edit followed by instance disposal cannot falsely pass as a
settings reload. Tests cover narrow patches, managed-policy precedence, JSONC
preservation, disabled endpoints, private auth inventory, API/OAuth operations,
temporary session cleanup and honest saved-but-unconfirmed failures without
client-side rollback. Readiness rejects audio-only, embedding-only, non-tool
and deprecated models before creating a session; slash-containing IDs are exact.

Renderer tests exercise the actual account module. The browser test loads the
actual HTML, styles and ES modules in headless Chromium, mocking only desktop
IPC responses. It checks model-first navigation, common service shortcuts,
catalog/model search, saved sign-ins versus tested models, endpoint add/edit,
disable/re-enable, failed rechecks, provider-bound OAuth, cancellation and
explicit default selection. It writes a source hash manifest and full-page
screenshots, including a narrow viewport with 200% text. A missing browser is
not a passed browser test. These fixtures prove UI behavior, not vendor login.

For shipped-image qualification, run the opt-in
[native provider-settings regression](../../scripts/README.md#native-provider-settings-regression).
It uses a fresh normal CLI install, the shipped Assistant and a controlled
compatible HTTP server. It needs Docker and a freshly compiled CLI; it does not
patch the image, repair mounts or copy credentials from an existing home.

## Native test evidence

On 2026-10-06 the reusable regression passed against the published alpha.6
Assistant and a fresh CLI install. Four endpoint setups became effective
immediately. Only two explicit response tests made inference requests; listing,
saving, discovery and default selection made none. Exact model IDs, endpoint
edits, non-destructive disabling, separate auth removal and re-enabling passed.
The container ID and OpenCode PID stayed unchanged across saves and default
selection; no container restart was pending. A normal CLI restart preserved
preferences and auth bytes. Managed policy stayed read-only and unchanged;
exactly one native preference file was writable. All three optional Compose
profiles validated together. Generated stacks were stopped normally afterward.

The full source suite, typechecking and lint passed, including image-backed
native history tests. Admin's complete source suite passed 120 tests with 828
assertions; Chromium passed 99 assertions. Current-source screenshots were
approved by the design reviewer. CLI and Linux AppImage builds passed, including
the rebuilt AppImage's real packaged startup/preload/setup check. This
replaces the earlier stale static fixtures rather than skipping their checks.
Full-wizard live qualification remains a separate final UI-iteration gate.

The controlled server qualifies native OpenCode API/SDK behavior and compatible
HTTP transport, not actual Ollama, LM Studio or llama.cpp engines. The earlier
real OpenCode Go readiness check remains separate evidence; no live instance or
existing user credentials were changed for this regression.

## Repeat manually

Use a disposable named home and unused ports. Never test sign-in replacement,
invalid credentials or readiness failure against an operator's live account.
Start the selected instance normally and open it in the preview AppImage.

1. Open **Agent settings**. The main card must identify the actual configured
   default service/model. Saved sign-ins belong in the collapsed saved setups
   list, not a list of supposedly working accounts. No model request should run
   merely by opening the page. No JSON or memory/scheduler section should appear.
2. Choose **Add AI service**. Try a common shortcut, then catalog search for a
   service outside the shortcuts. Nonsense search must produce no unrelated
   choice. Saving an API key or completing native OAuth must lead to model
   selection, not a different application page or automatic default change.
3. Choose an exact model and **Test response**. Success must name that same
   model and remain visible. Only **Use this model** changes the default. Try a
   failure: it must replace any prior successful proof. Existing keys must never
   appear automatically in the input, logs or clipboard.
4. Add a local/custom server using its Assistant-reachable compatible URL. Load
   models or enter an exact model ID, then **Save setup & test response**. Test
   failure must distinguish a saved endpoint from a working response. Edit its
   URL/model and repeat. Saving alone must not select it as the default.
5. From saved setups, disable a non-default endpoint. Its definition and sign-in
   must remain available; editing and explicitly re-enabling it must work.
   **Remove saved sign-in** is separate and must leave endpoint settings and
   other services intact. The default service must be protected from either
   action until another model is chosen.
6. With an authorized OAuth test account, exercise cancellation and the native
   prompts. Pending flows must remain bound to the selected service and instance.
   A consumed callback must not be reused after a failed response test.
7. In new setup, test and explicitly use a model, then choose the separate
   continuation action. Testing must not navigate away or restart a container.
   An untouched Guardian moderator placeholder may produce the normal pending
   restart alert; native preference changes alone must not produce that alert.
8. Restart the disposable stack normally and reopen Admin. Confirm the exact
   default, endpoint and sign-in remain saved, without a stale verification
   badge. Repeat search and actions with Tab/Shift+Tab/Enter, narrow layout and
   enlarged text. Product navigation must not resize the window.

Native configuration reload may interrupt active OpenCode work, even though
the process/container stay running. Verification does not change native agent
permissions. Leave the disposable stack stopped and preserve any credential-
bearing evidence privately.
