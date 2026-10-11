# Future SSH instance management

Status: discovery, inspect/logs and lifecycle for existing SSH-Docker instances
are implemented through the shared host-side boundary. Remote installation,
settings/setup parity and automatic client tunnels remain deferred.

The [hosting-provider architecture](hosting-provider-architecture.md)
is the broader implementation direction for CLI and Admin. It retains the SSH
constraints below within a shared provider boundary. See the
[current supported workflow](../hosting.md) before using future ideas below.

A future local Admin could remember explicit SSH targets and dispatch host
operations through the remote fhold CLI using system OpenSSH. It must preserve
host-key verification, native SSH config and per-home locking, add no daemon,
service, key store or public management API, and never silently fall back to
local execution.

Keep target selection separate from operations; resolve remote paths remotely.
Validate remote product/config/CLI compatibility before mutation. Recent instance
preferences may contain host/home selection but no passwords, keys, provider or
MCP credentials. Switching clears transient state and waits for in-flight work.

Start with inspect/log/start/stop and existing shared configuration operations.
Defer provisioning, remote installs/upgrades, backup transfer, provider/browser
sign-in and interactive native worker setup until separately verified.
A local OpenCode tunnel must bind loopback, retain authentication, close on
switch/exit and not change remote stack lifecycle.

This is separate from Guardian MCP and vendor-native Codex/Claude remote sessions.
No SSH backend or management protocol is implemented in the Linux alpha.
