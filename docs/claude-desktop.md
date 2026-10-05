# Claude Desktop

Use the fhold desktop extension to connect Claude Desktop to an fhold
agent running on the same computer. It is the correct local integration:
Claude's remote-connector form requires
`https://`, while a desktop extension runs locally and can reach a loopback
service. Anthropic documents the same distinction in
[When to use desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors).

The extension is a transparent MCP bridge. It adds no fhold service, tool,
policy, or permission. Guardian still authenticates the named credential,
filters the MCP catalog, screens input, owns sessions, and writes audit events.

## Install

Enable Guardian and create a dedicated credential. Start with `read` unless
Claude must modify the workspace or approve Assistant permissions:

```bash
fhold guardian enable
fhold credential add claude-desktop read
fhold connect claude --credential claude-desktop
```

Download `fhold-claude-desktop-<version>.mcpb` from the matching
[GitHub release](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610050714-alpha.6).
Admin's **Connections → Claude Desktop** panel provides the direct download;
`fhold connect claude` prints the same versioned URL. No source build is required.
In Claude Desktop:

1. Open **Settings → Extensions → Advanced settings**.
2. In **Extension Developer**, choose **Install Extension…**.
3. Select the `.mcpb` file.
4. In fhold Admin, open **Connections → Claude Desktop**. Enable protected
   access and save Connections if prompted.
5. Copy the displayed **Local fhold address** and the key for the selected
   access identity into the extension. Create a dedicated identity under
   **People & access** first when you do not want to reuse an existing one.
6. Restart Claude Desktop if the tools do not appear.

These are Anthropic's documented steps for
[installing a custom desktop extension](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop#h_6df82aa934).
The key field is marked sensitive in the MCPB manifest, so Claude Desktop uses
the operating system's secure credential storage.

Open the **+ → Connectors** menu in a conversation to enable fhold. The
credential policy determines the catalog Claude receives. A `read` credential
can run the guarded agent and inspect ordinary workspace files; a `full`
credential also receives session mutation and permission-approval operations.

## Limits and safety

- The extension accepts only `http://127.0.0.1/...`, `http://localhost/...`, or
  `http://[::1]/...` and requires the exact `/mcp` path. It cannot be pointed at
  a LAN or public host.
- The extension neither starts nor updates fhold. Guardian must already be
  healthy.
- Credential rotation requires updating the extension setting.
- Removing the named credential immediately revokes its key.
- Extension updates are installed manually from the matching release.

Build the artifact from source with:

```bash
bun install
bun run --cwd packages/claude-desktop pack
```

The result is written to `packages/claude-desktop/artifacts/`. The standard
unsigned pack bundles runtime dependencies and validates the MCPB manifest.
Release MCPB downloads are unsigned; see the reviewed build-tool
advisory in the [release runbook](operations/release.md).

For access from Claude web/mobile or from another computer, use the
[public remote MCP deployment](remote-mcp.md), not this extension.
