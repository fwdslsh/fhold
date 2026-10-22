# Admin interface standards

Admin is a productive desktop utility, not a marketing site or an enterprise
identity console. Its screens should feel like one application. Apply these
rules to the entire screen and to empty, busy, disabled, error and success states.

## Standards and scope

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies accessibility requirements:
  keyboard operation, visible/unobscured focus, meaningful labels, text contrast,
  200% text resize and reflow at 320 CSS pixels. Automated checks are not a
  declaration of complete WCAG conformance.
- [Carbon's grid](https://www.carbondesignsystem.com/building-blocks/foundations/2x-grid/overview),
  [button hierarchy](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines)
  and [field anatomy](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines)
  inform consistent alignment, action emphasis, labels, helpers and paired
  control sizing. fhold does not install Carbon or copy its enterprise patterns.
- The scale, density, colors and layout below are fhold design conventions,
  not WCAG requirements. The AA target-size minimum is 24px with defined
  exceptions, not 44px. fhold uses 40px ordinary desktop controls and 44px for
  coarse pointers. Native checkbox/radio marks stay small inside labeled targets.

## One visual source

[`design-tokens.css`](../../packages/electron/admin/design-tokens.css) owns the
palette, typography, spacing, control height, corners and motion. The existing
[`admin.css`](../../packages/electron/admin/admin.css) owns components and page
composition. Do not add a parallel token JSON, theme service, component runtime,
icon package or per-screen palette. Instrument Sans and its OFL license ship
locally; there is no remote font dependency.

| Role | Treatment |
| --- | --- |
| Page identity | 28px / 600, one visible primary heading |
| Section | 16px / 600; dialog or model emphasis may use 20px |
| Body and actions | 14px / 400 or 500, 1.5 line height |
| Field label and helper | 13px, label 500, helper 400 |
| Metadata | 12px; never use it for the main instruction |
| Spacing | 4, 8, 12, 16, 24, 32, 48, 64px relationship scale |
| Corners | 4px controls, 8px modal/editor surfaces; no decorative capsules |
| Color | Neutral graphite surfaces; green for the main action and positive state |
| Icons | 16px / 1.5px outline, optional and subordinate to a text label |

Use type size, proximity and alignment together. Do not simulate hierarchy with
many near-identical font sizes, very heavy text, random green panels or nested
card outlines. Paths and exact model/image IDs may use monospace; ordinary
instructions and editable prose do not.

## Components

| Component | Rule |
| --- | --- |
| Button | Primary for the main action; outlined secondary or padded ghost for supporting actions. Related actions share size and 8px spacing. Never render adjacent action words with no hit-area padding. |
| Field | Persistent visible label, full-width control within its form, helper below, common height with its adjacent button. A placeholder is not a label. |
| Checkbox/radio | 16px native mark and a generous clickable label. Never turn ordinary options into oversized colored switches or policy cards. |
| Navigation | Same icon/text alignment and neutral selected surface; `aria-current` identifies the active page. The agent picker has no brand mark or path. |
| Disclosure | Explicit chevron, consistent hit area and open/hover/focus states. Apps/System are separator-based inventories, not stacks of independent cards. Nested advanced settings use the same smaller disclosure component. |
| Status | Concise text, optionally a small decorative dot. Running is not authenticated or paired. Color alone never carries meaning. |
| Feedback | Shared bordered notice/callout, contextual error and next action. Keep pending restart in the sidebar and preserve explicit restart confirmation. |
| Dialog | Named native dialog, bounded width/height, ordinary form components and separated footer. Cancel precedes the final primary action. Escape and native focus containment remain available. |
| Data row | Align service / observed image / status on desktop; wrap metadata under identity at narrow sizes. Never substitute desired state for observed state. |
| Provider choice | Compact name/description list control, not a repeated promotional tile. Choosing a service must not change the active model. |

Hover may clarify the surface but must not reveal an otherwise unavailable
action. Keyboard focus uses one neutral, high-contrast ring, not a permanent
colored border. Required input boundaries and focus indicators meet 3:1;
normal text and placeholders meet 4.5:1. Disabled controls retain explanatory
context; active work must never appear completed optimistically.

## Screen composition

- **Assistant library:** stable location/task rail and named recent/discovered
  rows. Empty recents do not mean no instances exist. New/import are separate.
- **Overview:** named assistant, observed status/location/path, one OpenCode
  action and one service inventory. Update/version information stays together.
- **Agent settings:** current model first; native service/model editing uses
  the same fields, list choices and action hierarchy. Never imply saved sign-in
  proves readiness.
- **Apps:** one inventory ordered OpenCode, Claude, Codex, Discord, Slack, MCP.
  Settings and permissions stay with the app, with advanced actions subordinate.
- **System:** installation, logs, key maintenance, import/export and ephemeral
  support use the same disclosure inventory. Keep the two backup formats and
  stopped-writer/sensitive-data consequences explicit. Instructions must name
  actual current controls, not retired Welcome/import toggles.
- **Admin Settings:** connection rows, bounded editor and update-preference
  rows. Do not visually turn host connections into agent Apps or AI accounts.
- **Setup/import:** stable top anchor, compact task identity, one step at a
  time, a visible exit and shared field/action components. Do not restore the
  removed Welcome/Create headings.
- **Loading/error:** calm status or actionable error, not a decorative hero.

At small widths, reduce margins and change composition before shrinking text.
Do not resize the app window, hide required actions, truncate error guidance or
fix widths that force horizontal document scrolling. Reduced motion suppresses
non-essential animation; it does not hide busy or focus states.

## Verification

The real Chromium walkthrough in `admin-providers-browser.test.ts` renders the
actual modules/CSS, records screenshots and axe findings, traverses controls with
native keyboard events, and checks the four management pages at 320, 360, 375,
414, 480, 640, 768, 1024, 1280 and 1440px. It also covers individual Apps,
System disclosures, provider states, first-use/recents/discovery, Settings,
new/import and native dialogs. Representative states use 200% text size.

`admin-static.test.ts` checks the token/contrast contract and existing behavior.
Review screenshots as well as automated results: a clean accessibility scan
does not establish good visual hierarchy or successful live management. IPC is
synthetic in this walkthrough; native AppImage startup and real SSH/Azure/provider
readiness are separate qualifications. Build and smoke the final AppImage, and
keep its exact commit identity with the rendered evidence.
