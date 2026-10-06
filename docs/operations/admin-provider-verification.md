# AI-account verification

This qualifies the Agent settings overhaul independently of the still-iterating
installation, Apps permissions and System screens. It is not a release gate
waiver or a claim that every provider's native OAuth flow has been exercised.

## Automated checks

From the repository root:

```bash
bun test packages/lib/src/control-plane/opencode.test.ts
bun test packages/electron/src/admin-providers.test.ts
bun run --cwd packages/electron test:providers:browser
bun test packages/electron/src/admin-static.test.ts --test-name-pattern 'provider|readiness|OAuth|account|key'
```

The library tests use native-shaped OpenCode responses. They cover private auth
inventory, API/OAuth operations, prompt preservation, no-tool real-response
criteria and temporary session cleanup. Readiness selection rejects audio-only,
embedding-only, non-tool and deprecated models before creating a session; it
preserves compatible native configuration and model IDs containing slashes.

Renderer tests exercise the actual account module. The browser test loads the
actual HTML, styles and ES modules in headless Chromium, mocking only desktop
IPC responses. It checks strict catalog search, honest saved/available/verified
states, add/replace actions, failed rechecks, provider-bound OAuth, cancellation,
explicit setup continuation and native keyboard navigation. It writes a source
hash manifest and full-page screenshots, including a narrow viewport with 200%
text. A missing browser is not a passed browser test. These fixtures prove UI
behavior, not a native vendor login or account entitlement.

## Native test evidence

On 2026-10-05, a separate fresh home was installed and started through the normal
CLI using unused loopback ports and the published Assistant image. An approved
private OpenCode Go key file was supplied through `provider key --key-file`;
neither the key nor any host login files were copied into reports. The updated
shared library selected `opencode-go/gpt-5.6-luna`, received a real readiness
response and removed the temporary readiness session. No production instance
was changed. This complements the renderer checks; it does not mean all catalog
providers have been tested live.

Both design reviewers approved the current full-page screenshots for account
clarity, errors, key handling, OAuth cancellation and setup continuation. This
is scoped visual/interaction review, not whole-application accessibility
certification. The existing whole-wizard E2E fixtures and unrelated historical
Apps/System renderer expectations still require final UI-iteration alignment.

The scoped run passed 17 library tests, 9 account-renderer tests, 19 affected
static/navigation tests, 30 Admin domain/instance tests and the Chromium test
with 50 assertions. Typechecking, lint and normal CLI/AppImage builds succeeded.
The broader static fixture file still has 21 failures in older wizard/access/
System expectations (53 passing); these are not hidden or counted as qualified
UI behavior. Full-wizard qualification remains deferred to the user's final
design iteration.
Additional shared-library regression coverage passed 166 tests with 6 explicitly
skipped native-history integration cases; all 67 CLI tests passed.

## Repeat manually

Use a disposable named home and unused ports. Never test sign-in replacement,
invalid credentials or readiness failure against an operator's live account.
Start the selected instance normally and open it in the preview AppImage.

1. Open **Agent settings**. Public/runtime provider availability must not appear
   as a saved sign-in or a verified account. Listing accounts must make no model
   request. Confirm that there is no JSON or memory/scheduling settings section.
2. Search for a provider by name or ID, including one outside the common list.
   Search for nonsense: there must be no unrelated selected provider, and the
   page must explain how to clear the search. Clear it and select a provider.
3. For an API-key provider, use **Add API key → Save key and verify**. After a
   successful real response, its saved account row and **Verified** status must
   agree. The page must remain visible. Existing keys must never appear in the
   input, logs or clipboard automatically.
4. Select its saved account. **Replace API key** must be a separate, explicit
   action. Reverify; a failed attempt must replace the previous successful status
   with **Last check failed**, not leave a green readiness claim. If sign-in was
   saved but the model request failed, that distinction must be stated.
5. Exercise a native OAuth provider with an authorized test account. While its
   browser flow is pending, unrelated provider changes must be disabled. Cancel
   sign-in and confirm controls become usable without claiming a saved login.
   Complete another attempt through the provider's actual native prompts. A
   consumed callback must not be reused after a failed model response.
6. On a newly installed instance, verify successfully. The page must stay on the
   result with **Continue to your agent**; only that action advances. Choosing an
   unverified account must hide Continue. A management verification must not
   jump to Overview or open a restart prompt. Pending Guardian configuration
   uses the existing deferred-restart alert.
7. Repeat selection, search, disclosure and buttons using Tab/Shift+Tab/Enter.
   Check a narrow window and enlarged text for clipping, overlaps and inaccessible
   controls. Product navigation must not resize the window.

Verification tests the selected provider; it does not change OpenCode's default
model or the native permissions of agent sessions. Leave the disposable stack
stopped and preserve any credential-bearing evidence privately.
