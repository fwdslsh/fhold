/** Release-owned and seed-once assets shared by host tools and image builds. */
// Retire only exact, previously published product bytes. Modified/unknown files
// remain operator-owned; no directory sweep or native syntax converter exists.
export const RETIRED_MANAGED_FILES: Readonly<Record<string, readonly string[]>> = {
	'system/assistant/agents/memory.md': ['58e03aad55d2899103f43d11c432881adab59d42ea7705f57607f95bb1ff047c'],
	'system/assistant/agents/scheduled.md': [
		'47873278faa10c8f129662056af27af4e505fce253d3172b52882ba6905d64bc',
		'167f1135ddeaeda2369c27f316250a16b53217ec99999b3534d59ab777205f91'
	],
	'system/assistant/lib/memory.js': [
		'c7d8c4e6f9de4aa1a2c10b63e1a9a10530e5c54d4faaf28e916b69685bd17fb4',
		'f1b7a37218015a23bd865fd1d3ef051c511d28a029fef5aa41d0af4cba2b0ad4',
		'0323edd045328e325bdf8486a972ddc79020f62ee99ffee29a592fce5f4ff1af',
		'd241d0b8e6e79bd3b0c75a74da4168e5b50bde37cc9dedd0becd94d8f3a9c2bc'
	]
};

export const MANAGED_FILES = [
	'system/stack/stack.compose.yml',
	'system/assistant/.gitignore',
	'system/assistant/opencode.jsonc',
	'system/assistant/opencode.json',
	'system/codex/config.toml',
	'system/codex/requirements.toml',
	'system/claude/managed-settings.json',
	'system/assistant/AGENTS.md',
	'system/assistant/agents/remote.md',
	'system/assistant/agents/remote-read.md',
	'system/assistant/agents/remote-full.md',
	'system/assistant/plugins/akm.js',
	'system/assistant/plugins/fhold.js',
	'system/assistant/skills/claude-code-login/SKILL.md',
	'system/assistant/skills/claude-code-login/scripts/login.sh',
	'system/assistant/skills/claude-code-login/scripts/remote.sh',
	'system/assistant/skills/codex-remote-setup/SKILL.md',
	'system/assistant/skills/codex-remote-setup/scripts/setup.sh',
	'system/assistant/skills/fhold-admin/SKILL.md',
	'system/assistant/skills/fhold-admin/scripts/session.sh',
	'system/assistant/skills/fhold-admin/scripts/status.mjs'
] as const;

export const SEEDED_FILES = [
	'config/stack/custom.compose.yml',
	'config/recovery/include.json',
	'config/assistant/.gitignore',
	'config/assistant/opencode.json',
	'config/assistant/persona.md',
	'config/assistant/user-profile.md',
	'config/akm/config.json',
	'config/guardian/.gitignore',
	'config/guardian/opencode.json',
	'config/guardian/oauth.json',
	'config/guardian/oauth-identities.json',
	'config/portal/discord/credentials.json',
	'config/portal/slack/credentials.json',
	'knowledge/env/user.env'
] as const;
