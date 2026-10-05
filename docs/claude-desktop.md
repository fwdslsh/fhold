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
Admin's **Connections → Claude → Claude Desktop** section provides the direct download;
`fhold connect claude` prints the same versioned URL. No source build is required.
In Claude Desktop:

1. Open **Settings → Extensions → Advanced settings**.
2. In **Extension Developer**, choose **Install Extension…**.
3. Select the `.mcpb` file.
4. In fhold Admin, open **Connections → Claude → Claude Desktop** and choose
   **Enable access for Claude Desktop** if needed. Confirm whether to restart
   now or apply the saved change later.
5. Under **What can Claude Desktop do?**, choose Chat only, Read files or Full
   access and select **Save permissions**. Use Full access only for a trusted app
   needing agent tools and file changes; granting it requires confirmation.
   To resume an existing setup, choose **Use saved access** rather than creating
   another identity. fhold does not detect the extension's saved assignment.
6. In the connection instructions, copy **Local address** and select **Copy
   access key**, then paste them into the extension's address and **fhold access
   key** fields. Keys appear here because the extension needs a pasted credential,
   not as a separate Admin management destination.
7. Restart Claude Desktop if the tools do not appear.

The revised Admin workflow is a design preview, not live-verified client setup.
Changing saved permissions affects all apps using that identity and requires
confirmation; its key and conversations stay attached to the same identity.
Choosing separate or different saved access requires updating the extension and
starts separate conversations. **Connections → Advanced access** retains saved
access maintenance. Claude Code's native sign-in and permissions are independent
of this Desktop MCP connection.

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
