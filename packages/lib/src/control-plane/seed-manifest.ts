/** Release-owned and seed-once assets shared by host tools and image builds. */
export const MANAGED_FILES = [
	'system/stack/stack.compose.yml',
	'system/assistant/.gitignore',
	'system/assistant/opencode.jsonc',
	'system/assistant/AGENTS.md',
	'system/assistant/agents/remote.md',
	'system/assistant/agents/remote-read.md',
	'system/assistant/agents/remote-full.md',
	'system/assistant/agents/scheduled.md',
	'system/assistant/agents/memory.md',
	'system/assistant/lib/memory.js',
	'system/assistant/plugins/akm.js',
	'system/assistant/plugins/fhold.js',
	'system/assistant/skills/claude-code-login/SKILL.md',
	'system/assistant/skills/claude-code-login/scripts/login.sh',
	'system/assistant/skills/claude-code-login/scripts/remote.sh',
	'system/assistant/skills/codex-remote-setup/SKILL.md',
	'system/assistant/skills/codex-remote-setup/scripts/setup.sh',
	'system/assistant/skills/fhold-admin/SKILL.md',
	'system/assistant/skills/fhold-admin/scripts/session.sh',
	'system/assistant/skills/fhold-admin/scripts/status.mjs',
	'system/guardian/.gitignore',
	'system/guardian/opencode.jsonc',
	'system/guardian/instructions/moderation.md'
] as const;

export const SEEDED_FILES = [
	'config/stack/custom.compose.yml',
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
