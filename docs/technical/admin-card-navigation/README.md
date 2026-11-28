# Admin card navigation review

Branch: `feat/admin-card-navigation`, based on merged main `77a8c80`.

The management screens now group tasks into cards with visible purpose text.
Apps keeps its app order and navigates to a dedicated editor with Back to Apps.
System starts with Backup and recovery, then deployment,
installation, logs, connection keys and experimental private task access.
Overview links directly to model settings, apps and the backup card without
starting an operation. The library, setup/import and Admin-wide settings use
the same surfaces, spacing and native controls. Recent assistants and locations
use cards. The sidebar assistant button opens location browsing without discarding
drafts. Management, setup and settings use the available width with left-aligned
headers. Backup categories are pages; ordinary app settings and saved AI setups
are visible instead of hidden in nested accordions.

The native Knowledge interface and its lifecycle remain unchanged. The shared
header now follows the requested full-width layout; earlier pixel-identical
Knowledge-shell claims do not apply to this revision.

## Rendered comparisons

These are actual Chromium renders of the shipped HTML/CSS/modules with
synthetic IPC responses. Names, hosts, statuses and paths are fixture data;
no live assistant or real credential was used. Images were visually inspected.

| Screen | Before | After |
| --- | --- | --- |
| Overview | [Before](before/overview-desktop.png) | [After](after/overview-desktop.png) |
| Agent settings | [Before](before/model-current-unverified.png) | [After](after/model-current-unverified.png) |
| Apps | [Before](before/apps-desktop.png) | [After](after/apps-desktop.png) |
| App editor | — | [Discord page](after/app-discord-desktop.png) |
| System | [Before](before/system-desktop.png) | [After](after/system-desktop.png) |
| Backup settings | — | [Dedicated page](after/system-runtime-recovery-desktop.png) |
| Assistant library | [Before](before/instances-recents-desktop.png) | [After](after/instances-recents-desktop.png) |
| Admin settings | [Before](before/admin-settings-stable-desktop.png) | [After](after/admin-settings-stable-desktop.png) |
| Setup | [Before](before/instances-new-ssh-desktop.png) | [After](after/instances-new-ssh-desktop.png) |
| Import review | [Before](before/instances-import-review-desktop.png) | [After](after/instances-import-review-desktop.png) |

Full-page capture now preserves viewport width when Chromium removes the
scrollbar during composition, avoiding the previous right-edge crop.
The existing palette remains dark even with a light OS preference.

## Verification

- Browser walkthrough: 398 assertions passed, 130 captured states,
  [zero axe violations](after/accessibility.json). Includes keyboard operation,
  backup shortcut navigation without an operation, Back focus restoration,
  draft retention across return/reopening/refresh, unavailable capabilities,
  AI model selection, app configuration, host discovery, setup/import, recovery,
  dialogs, long paths, widths from 320 to 1440 CSS pixels, 200% text size and
  reduced motion. The [manifest](after/qa-manifest.json) records source hashes
  and keyboard events. The complete temporary screenshot set is
  `/tmp/fhold-provider-chromium-bXKj0c`.
- Native Electron smoke passed with real IPC and an isolated profile against a
  disposable stopped assistant: location cards, app editors, unsaved fields,
  Back focus, backup pages and return to the selected assistant. No live instance
  or saved credential was changed. This revision did not repeat the earlier
  full native installation/recovery suite; that remains pre-merge qualification.
- Repository tests: 1,292 passed; 24 existing opt-in tests skipped.
- Type checks, lint, CLI build and Admin bundle passed. Lint retains the
  repository's existing warnings. No dependency, container, native consent or
  credential ownership changes.

Existing tests that asserted native disclosure expansion or select-option markup
were updated because those controls are now navigation pages/buttons. The browser
tests exercise the replacement controls and verify observable state and focus.

Automated accessibility checks and screenshots are complementary evidence,
not a declaration of complete WCAG conformance or live cloud readiness.
