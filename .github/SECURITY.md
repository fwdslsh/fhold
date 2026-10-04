# Security policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/fwdslsh/fhold/security/advisories/new).
Do not include credentials, user data or undisclosed exploit details in a public
issue. Public source availability is not a claim that binaries/images are published
or that experimental native workers are generally qualified.

Include affected version/component, sanitized reproduction, impact and suggested
mitigation. The normative boundary is
[core principles](../docs/technical/core-principles.md).

In scope: authentication/policy/ownership bypass, moderation failures, path escapes,
secret leakage, privileged mounts, unsafe network publication and supply-chain
flaws. Native trusted agent capabilities are intentionally distinct from
Guardian policy. Upstream-only reports should go to their owning maintainers.

The first independent release line is 0.1 with timestamped prereleases.
There is no inherited historical-version support matrix or foreign-home upgrade.
