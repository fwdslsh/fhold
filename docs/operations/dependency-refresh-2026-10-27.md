# OpenCode 2.1 and AKM native setup upgrade

Reviewed October 27, 2026 for [issue57](https://github.com/fwdslsh/fhold/issues/57),
from main's native integration refactor in PR67. This is a focused compatibility
upgrade; it does not stamp a release or change an existing installation.

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261014-beta | 0.10.261015-beta (`next`) |
| All three AKM plugins | 0.10.261012-beta | 0.10.261013-beta |
| OpenCode CLI/client/plugin SDK | 2.0.32 | 2.1.4 |
| Effect | 4.0.1 | 4.0.1, required by both selected plugins |

The plugin's exact CLI requirement now agrees with the installed CLI, removing
the temporary Bun CLI override. AKM dropped Transformers.js and its installed
ONNX package, so the unused Transformers override and ONNX dependency-pruning
commands are removed. The now-unused adm-zip override and obsolete sprintf-js
audit ignore are also removed. No vendor code or installed package contents are patched.

## Published provenance and native acquisition

- [AKM PR1258](https://github.com/itlackey/akm/pull/1258) explains script-free
  installation, optional Node SQLite prebuilds, and native runtime/model acquisition.
- [Plugin PR141](https://github.com/itlackey/akm-plugins/pull/141) aligns the
  OpenCode 2 API and Effect peers, pins CLI015 and qualifies native model work.
- [Plugin release013](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261013-beta)
  is published on npm and supplies both native marketplaces. Its immutable commit
  is `62066b5d82c86c07b62e2e0a1fddec97b3182825`; the codeload archive SHA256 is
  `1d36e583aad4b124b46cd2c96fde003eaf6db8e9642182ce6685612dd28033f8`.
- [OpenCode comparison](https://github.com/anomalyco/opencode/compare/v2.0.32...v2.1.4)
  includes compaction continuation in message metadata, native configuration
  watching, permission/error handling and MCP lifecycle fixes. Guardian and fhold
  keep their native client/plugin integrations, verified against the selected SDK.

The image build runs AKM's own `ensureRuntimeBinary` acquisition export for its
private pinned OpenCode runtime. Linux x64 also runs native
`akm setup --yes --embedding local` and requires `semanticAssets: ready`.
Assets are baked under `/assistant-defaults/akm-cache`, outside Compose's bind
mount, and ordinary filesystem initialization copies only missing files into
the native `/opt/akm/cache` (or explicit `AKM_CACHE_DIR`). Existing operator files
and symlinks are preserved; no setup command or network acquisition runs at boot.
No generated build configuration, credentials or bundle is copied. The current seed remains keyword
search with the installed `opencode` harness; operator preferences are preserved.
The additional runtime cache lets operators choose native connection-based work
without a first-use binary installation. Linux ARM64 uses upstream-supported
keyword search or remote embeddings; no fhold fallback implementation is added.

The image smoke uses the normal entrypoint, a fresh home/configuration and an
empty writable cache bind mount with no network to verify native cache discovery
and actual local model availability where AKM supports it. A restart preserves
existing cache bytes and a native asset symlink. No native asset is supplied by a test.

## Continuation and integration evidence

The real-image transfer suite now seeds a compacted session under both the
published 2.0.32 image and the new 2.1 image. The current engine exports a private
snapshot, retaining native continuation metadata through import. A loopback
model then receives the restored summary and kept context, without the discarded
prefix. The 2.1 case explicitly retains `metadata.keepID` and unrelated message
metadata. Original source database hashes must remain unchanged. Upstream owns
2.0's stored `recent` conversion; fhold adds no historical configuration/history
converter.

Run locally with the pinned Bun and native Node on PATH:

```sh
FH_NATIVE_TEST_IMAGE=fhold/fhold-assistant:issue57 \
FH_HISTORY_SOURCE_IMAGE=fwdslsh/fhold-assistant:0.1.2610081904-beta.2 \
FH_HISTORY_V2_SOURCE_IMAGE=fwdslsh/fhold-assistant:0.3.261006-beta \
  bun test scripts/native-transfer.test.ts
```

Hosted native amd64/arm64 CI includes both source generations, all three AKM
harnesses, native settings/Guardian/scheduling, and runtime recovery/upgrade.
Final results and any unrun gates are recorded in the PR. Synthetic providers
do not qualify vendor sign-in, paid model behavior or a live restore drill.

Local Linux amd64 evidence:

- Type checks, CLI/Admin builds, shell syntax and all Compose profiles pass.
- Source suites: **1057 passed, 7 opt-in cases skipped, 0 failed**. The real-image
  history/provider cases are run separately rather than counted as source passes.
- Native history/credential transfer: **6 passed**, including both continuation
  cases above. Native provider/settings/Guardian/scheduled execution: **1 passed**.
- Assistant startup/security smoke passes, including offline asset discovery,
  all three real AKM harnesses, all five tools, native proposal extraction and
  optional-feature failure isolation.
- Lint passes with the existing226 warnings/14 informational diagnostics; docs
  checks and both docs tests pass. Frozen install and reviewed audit pass.
- Unfiltered Trivy0.76.1 scan reports exactly the three high advisories below,
  no criticals and no new high findings. This is not a clean scan claim.

Hosted final-SHA CI and the complete recovery matrix remain PR gates; local
amd64 evidence is not ARM64 execution evidence.

## Unresolved advisory acceptance

The three Assistant exceptions approved for PR67 are **not fixed by this
upgrade**. No exception is widened or extended:

| Chain | Verified remaining version | Why a supported fix is unavailable |
| --- | --- | --- |
| Azure Identity → MSAL Node | Identity4.14.0 → MSAL6.0.1 | Identity latest and4.15.0-beta.1 both declare MSAL `^6.0.0`; patched7.1.0 is outside that range. |
| AKM CLI → Zod | CLI015 → Zod3.25.76 | AKM declares `^3.23.0`; patched Zod4.6.6+ is a different major. MCPB's independent Zod3 chain also remains. |
| Global npm → Undici | npm12.2.1 → Undici6.29.0 | The official latest npm tarball still bundles6.29.0; a workspace override cannot replace npm's private bundle. |

Raw source audit and actual image scans remain visible. Existing source audit
exceptions also cover independent node-forge/MCPB chains; the prior sprintf-js
finding is no longer present. Supported upstream releases must resolve the
owning chains; no vendor edits, unsupported major override or scanner bypass is
used to claim a fix. The exact image exceptions expire **November6, 2026**.

Issue57 must remain open while its exception-removal acceptance is unresolved.
Merging or releasing with further deferral requires an explicit owner decision;
this implementation does not infer one from approval of PR67. Issue63 retains
the separate Azure/MSAL and MCPB dependency ownership. Other dependency updates
are deferred to a deliberate batch; this PR holds Effect at its required4.0.1
and leaves unrelated tools and desktop major-version decisions unchanged.
