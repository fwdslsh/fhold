# Admin card navigation review

Implementation: `1477e1f`, based on merged main `77a8c80`.

The management screens now group tasks into cards with visible purpose text.
Apps keeps its existing app order and native disclosures; an expanded card
uses the full row. System starts with Backup and recovery, then deployment,
installation, logs, connection keys and experimental private task access.
Overview links directly to model settings, apps and the backup card without
starting an operation. The library, setup/import and Admin-wide settings use
the same surfaces, spacing and native controls.

Knowledge's header, embedded viewport, navigation identity and native lifecycle
are excluded. The extra selected-assistant label and Admin prefix disappear
there, preserving the original shell geometry.

## Rendered comparisons

These are actual Chromium renders of the shipped HTML/CSS/modules with
synthetic IPC responses. Names, hosts, statuses and paths are fixture data;
no live assistant or real credential was used. Images were visually inspected.

| Screen | Before | After |
| --- | --- | --- |
| Overview | [Before](before/overview-desktop.png) | [After](after/overview-desktop.png) |
| Agent settings | [Before](before/model-current-unverified.png) | [After](after/model-current-unverified.png) |
| Apps | [Before](before/apps-desktop.png) | [After](after/apps-desktop.png) |
| System | [Before](before/system-desktop.png) | [After](after/system-desktop.png) |
| Assistant library | [Before](before/instances-recents-desktop.png) | [After](after/instances-recents-desktop.png) |
| Admin settings | [Before](before/admin-settings-stable-desktop.png) | [After](after/admin-settings-stable-desktop.png) |
| Setup | [Before](before/instances-new-ssh-desktop.png) | [After](after/instances-new-ssh-desktop.png) |
| Import review | [Before](before/instances-import-review-desktop.png) | [After](after/instances-import-review-desktop.png) |

Full-page capture now preserves viewport width when Chromium removes the
scrollbar during composition, avoiding the previous right-edge crop.
The existing palette remains dark even with a light OS preference.

## Verification

- Browser walkthrough: 390 assertions passed, 130 captured states,
  [zero axe violations](after/accessibility.json). Includes keyboard operation,
  backup shortcut focus/expansion without an operation, unavailable capabilities,
  AI model selection, app configuration, host discovery, setup/import, recovery,
  dialogs, long paths, widths from 320 to 1440 CSS pixels, 200% text size and
  reduced motion. The [manifest](after/qa-manifest.json) records source hashes
  and keyboard events. The complete temporary screenshot set is
  `/tmp/fhold-provider-chromium-As43jv`.
- Knowledge shell: pixel-identical to baseline at 320×900, 768×900 and
  1280×900. These browser fixtures contain no native child view; they do not
  prove the embedded AKM browser is visible. Native composed-window evidence
  and lifecycle qualification are recorded separately in the PR.
- Repository tests: 1,292 passed; 24 existing opt-in tests skipped.
- Type checks, lint, CLI build and Admin bundle passed. Lint retains the
  repository's existing warnings. No dependency, container, native consent or
  credential ownership changes.

Automated accessibility checks and screenshots are complementary evidence,
not a declaration of complete WCAG conformance or live cloud readiness.
