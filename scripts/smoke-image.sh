#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: smoke-image.sh IMAGE assistant|guardian|portal}
kind=${2:?usage: smoke-image.sh IMAGE assistant|guardian|portal}
remote=${FH_SMOKE_REMOTE:-default}
case "$remote" in default|0|1) ;; *) echo 'FH_SMOKE_REMOTE must be default, 0 or 1' >&2; exit 1 ;; esac
sandbox=${FH_SMOKE_CODEX_SANDBOX:-workspace-write}
expected_bun=$(sed -nE 's/^FROM oven\/bun:([0-9.]+).*$/\1/p' "containers/$kind/Dockerfile" | head -n 1)
root=$(mktemp -d)
container="fhold-${kind}-smoke-$$"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	# Container-owned files may be intentionally inaccessible to the host user.
	# Retain fixtures for diagnosis; disposable CI runners reclaim their temp tree.
	printf 'Smoke fixtures retained at %s\n' "$root"
}
trap cleanup EXIT

verify_image_metadata() {
	local version
	test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.title"}}')" = "fhold ${kind^}"
	test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')" = 'https://github.com/fwdslsh/fhold'
	test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.url"}}')" = 'https://github.com/fwdslsh/fhold'
	test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" = 'MIT'
	version=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
	test -n "$version" && test "$version" != '<no value>'
}

wait_for_health() {
	local deadline=$((SECONDS + 90))
	while ((SECONDS < deadline)); do
		status=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
		case "$status" in
		healthy) return 0 ;;
		unhealthy | exited | dead)
			docker logs "$container" >&2
			return 1
			;;
		esac
		sleep 1
	done
	docker logs "$container" >&2
	echo "Timed out waiting for $kind image health" >&2
	return 1
}

verify_runtime_versions() {
	test "$(docker exec "$container" bun --version)" = "$expected_bun"
	if [ "$kind" = assistant ]; then
		local expected_node expected_tools
		expected_node=$(sed -nE 's/^FROM node:([0-9.]+).*$/\1/p' containers/assistant/Dockerfile)
		test "$(docker exec "$container" node --version)" = "v$expected_node"
		# OpenCode runs login shells whose /etc/profile replaces the image PATH.
		# Native CLIs must remain ordinary commands without an agent exporting PATH.
		docker exec --workdir /work "$container" bash --login -c \
			'for tool in opencode akm codex claude; do test "$(command -v "$tool")" = "/usr/local/bin/$tool" || exit 1; "$tool" --version || exit 1; done'
		docker exec "$container" node --input-type=module -e '
			import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync} from "node:fs";
			import {spawnSync} from "node:child_process";
			if (process.getuid() === 0) throw Error("npm smoke must be non-root");
			const version = JSON.parse(readFileSync("/usr/local/lib/node_modules/npm/package.json", "utf8")).version;
			for (const tool of ["npm", "npx"]) {
				const result = spawnSync(tool, ["--version"], {encoding:"utf8", timeout:10000});
				if (result.status !== 0 || result.stdout.trim() !== version) throw Error(`${tool} is not the bundled npm ${version}`);
			}
			const root = mkdtempSync("/tmp/fhold-npx-smoke-");
			mkdirSync(`${root}/node_modules/.bin`, {recursive:true});
			writeFileSync(`${root}/package.json`, JSON.stringify({name:"fhold-npx-smoke",version:"1.0.0",private:true}));
			writeFileSync(`${root}/server.cjs`, `#!/usr/bin/env node\nrequire("node:readline").createInterface({input:process.stdin}).once("line",line=>{const request=JSON.parse(line); process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{tools:[]}})+"\\n",()=>process.exit(0));});\n`, {mode:0o700});
			symlinkSync("../../server.cjs", `${root}/node_modules/.bin/fhold-mcp-smoke`);
			const result = spawnSync("npx", ["--offline", "--no-install", "--", "fhold-mcp-smoke"], {cwd:root, env:{...process.env,npm_config_cache:`${root}/cache`}, input:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n",encoding:"utf8",timeout:10000});
			if (result.status !== 0 || JSON.parse(result.stdout).id !== 1) throw Error(`npx stdio launch failed: ${result.stderr}`);
			console.log(`npm/npx ${version}: non-root offline stdio launcher passed`);'
		expected_tools=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.stringify(JSON.parse(readFileSync("containers/assistant/tools/package.json", "utf8")).dependencies));')
		docker exec -e EXPECTED_TOOLS="$expected_tools" "$container" bun -e \
			'for (const [name, expected] of Object.entries(JSON.parse(process.env.EXPECTED_TOOLS))) { const actual = (await Bun.file(`/opt/fhold/tools/node_modules/${name}/package.json`).json()).version; if (actual !== expected) throw Error(`${name}: expected ${expected}, got ${actual}`); console.log(`${name} ${actual}`); }'
	fi
}

verify_workspace_runtime_boundary() {
	# Exercise installed helper entrypoints and AKM, not only a Bun eval. The
	# hostile files are present before startup, reconciliation and native hooks.
	docker exec --workdir /work "$container" bun -e \
		'if (process.env.FH_PLUGIN_ENV_SENTINEL) throw Error("Workspace .env loaded"); if (await Bun.file("/tmp/fhold-bun-preload-executed").exists()) throw Error("Workspace bunfig preload executed");'
	docker exec --workdir /work "$container" akm --version
	docker exec --workdir /work "$container" fhold-task list >/dev/null
	docker exec --workdir /work "$container" fhold-remote codex status >/dev/null
	local output status=0
	output=$(docker exec --workdir /work "$container" fhold-remote-setup invalid 2>&1) || status=$?
	test "$status" = 1
	[[ "$output" == *'Choose codex or claude'* ]]
	# Read-only native hook inventory; never approve trust or use vendor accounts.
	docker exec --workdir /work "$container" fhold-codex-recall.mjs review >/dev/null
	docker exec --workdir /work "$container" bun -e \
		'if (await Bun.file("/tmp/fhold-bun-preload-executed").exists()) throw Error("A helper executed workspace bunfig preload");'
	printf '%s\n' 'Workspace Bun dotenv/preload boundary passed for helpers and AKM'
}

verify_builtin_skills() {
	# Native discovery must see the same release-owned bytes that were baked,
	# including when the installed stack mounts its managed configuration.
	docker exec "$container" opencode debug skill | docker exec -i "$container" bun -e '
		const skills = await Bun.stdin.json();
		for (const name of ["claude-code-login", "codex-remote-setup", "fhold-admin"]) {
			const skill = skills.find(item => item.name === name);
			const target = `/etc/opencode/skills/${name}/SKILL.md`;
			if (skill?.location !== target) throw Error(`Native ${name} skill is not discoverable`);
			const baked = `/assistant-defaults/system/assistant/skills/${name}/SKILL.md`;
			if (await Bun.file(target).text() !== await Bun.file(baked).text()) throw Error(`Mounted and baked ${name} skills differ`);
			console.log(`OpenCode discovered the image-baked ${name} skill`);
		}'
	docker exec "$container" bun /etc/opencode/skills/fhold-admin/scripts/status.mjs | docker exec -i "$container" bun -e '
		const result = await Bun.stdin.json();
		if (result.uid === 0 || result.workspace !== "/work" || result.knowledge !== "/stash" || !result.version) throw Error("Built-in fhold-admin status failed");'
	docker exec "$container" bash -c 'for script in /etc/opencode/skills/*/scripts/*.sh; do bash -n "$script" || exit 1; done'
}

verify_image_metadata
case "$kind" in
assistant)
	mkdir -p \
		"$root/data/.cache/opencode" \
		"$root/data/.config/opencode" \
		"$root/data/.local/share/opencode" \
		"$root/data/.local/state/opencode" \
		"$root/knowledge/secrets" \
		"$root/workspace" \
		"$root/config"
	cp -R packages/skeleton/system/assistant "$root/system"
	cp -R packages/skeleton/config/assistant/. "$root/config/"
	cp packages/skeleton/config/akm/config.json "$root/akm.json"
	printf '%s\n' 'assistant-smoke-password-0000000000000000' >"$root/password"
	printf '%s\n' '{}' >"$root/knowledge/secrets/auth.json"
	# Untrusted workspace configuration must not become Bun startup authority.
	# Keep it throughout native-harness and restart tests so legitimate vendor
	# configuration remains functional while Bun project config stays disabled.
	printf '%s\n' 'FH_PLUGIN_ENV_SENTINEL=must-not-load' >"$root/workspace/.env"
	printf '%s\n' 'preload = ["./fhold-bun-preload-probe.mjs"]' >"$root/workspace/bunfig.toml"
	printf '%s\n' \
		'import { writeFileSync } from "node:fs";' \
		'writeFileSync("/tmp/fhold-bun-preload-executed", "unsafe");' \
		'process.exit(73);' >"$root/workspace/fhold-bun-preload-probe.mjs"
	chmod -R a+rwX "$root/data" "$root/knowledge" "$root/workspace"
	remote_env=()
	if [ "$remote" != default ]; then
		remote_env=(-e FH_CODEX_REMOTE="$remote" -e FH_CLAUDE_REMOTE="$remote")
	fi
	docker run -d --name "$container" \
		--init --cap-drop=ALL --security-opt no-new-privileges:true \
		"${remote_env[@]}" \
		-e FH_CODEX_SANDBOX="$sandbox" \
		-e OPENCODE_SERVER_PASSWORD_FILE=/run/fhold/password \
		-v "$root/data:/home/opencode" \
		-v "$root/system:/etc/opencode:ro" \
		-v "$root/config:/home/opencode/.config/opencode:ro" \
		-v "$root/akm.json:/etc/akm/config.json:ro" \
		-v "$root/knowledge:/stash" \
		-v "$root/knowledge/secrets/auth.json:/home/opencode/.local/share/opencode/auth.json" \
		-v "$root/workspace:/work" \
		-v "$root/password:/run/fhold/password:ro" \
		"$image" >/dev/null
	wait_for_health
	verify_runtime_versions
	verify_workspace_runtime_boundary
	verify_builtin_skills
	docker exec "$container" curl -sf -u 'opencode:assistant-smoke-password-0000000000000000' http://127.0.0.1:4096/config >/dev/null
	docker exec "$container" sh -c \
		'command -v akm >/dev/null && command -v opencode >/dev/null && command -v supercronic >/dev/null && codex --version && claude --version && test -x /usr/local/bin/fhold-remote && test -x /usr/local/bin/fhold-remote-setup && test -x /usr/local/bin/fhold-task && test -r /opt/fhold/tools/node_modules/akm-opencode/dist/index.js'
	docker exec "$container" bun -e \
		'const { setupCommands } = await import("/usr/local/bin/fhold-remote-setup"); if (typeof Bun.Terminal !== "function" || setupCommands("codex", "read-only")[0][0] !== "sandbox") throw Error("Guided native setup is unavailable");'
	docker exec "$container" bun -e \
		'const { remoteCommand } = await import("/usr/local/bin/fhold-remote.mjs"); const { setupCommands } = await import("/usr/local/bin/fhold-remote-setup"); const args = remoteCommand("codex", "danger-full-access"); if (!args.includes("approval_policy=\"on-request\"") || !args.includes("sandbox_mode=\"danger-full-access\"") || args.some(a => a.includes("bypass")) || setupCommands("codex", "danger-full-access").some(([stage]) => stage === "sandbox")) throw Error("Explicit container isolation contract failed");'
	docker exec "$container" claude plugin validate /akm-marketplace/claude --strict
	docker exec "$container" claude plugin list --json | docker exec -i "$container" bun -e \
		'const plugins = await Bun.stdin.json(); const version = (await Bun.file("/opt/fhold/tools/package.json").json()).dependencies["akm-opencode"]; if (!plugins.some(p => p.id === "akm@akm-plugins" && p.enabled && p.version === version)) throw Error("Claude AKM plugin not loaded");'
	docker exec "$container" claude plugin details akm
	docker exec "$container" codex plugin list --json | docker exec -i "$container" bun -e \
		'const plugins = await Bun.stdin.json(); const version = (await Bun.file("/opt/fhold/tools/package.json").json()).dependencies["akm-opencode"]; if (!plugins.installed.some(p => p.pluginId === "akm@akm-plugins" && p.enabled && p.version === version)) throw Error("Codex AKM plugin not installed/enabled");'
	docker cp scripts/smoke-akm-harnesses.mjs "$container:/tmp/smoke-akm-harnesses.mjs"
	docker exec "$container" bun /tmp/smoke-akm-harnesses.mjs
	# An image upgrade refreshes only untouched native installer output. A native
	# user's settings and hook-trust state must survive without merging formats.
	docker exec "$container" bun -e '
		const {readFileSync, writeFileSync, cpSync} = await import("node:fs");
		const home = "/home/opencode";
		const registry = `${home}/.claude/plugins/installed_plugins.json`;
		const previous = `${home}/.fhold-native-defaults/claude/plugins/installed_plugins.json`;
		const installed = JSON.parse(readFileSync(registry, "utf8"));
		installed.plugins["akm@akm-plugins"][0].version = "0.0.0";
		writeFileSync(registry, JSON.stringify(installed)); cpSync(registry, previous);
		const settings = `${home}/.claude/settings.json`;
		const value = JSON.parse(readFileSync(settings, "utf8")); value.language = "English";
		writeFileSync(settings, JSON.stringify(value));
		const config = `${home}/.codex/config.toml`;
		writeFileSync(config, `${readFileSync(config, "utf8")}\n# user hook-trust preferences retained\n`);
		writeFileSync("/tmp/native-user-settings.json", JSON.stringify([readFileSync(settings,"utf8"), readFileSync(config,"utf8")]));'
	docker restart "$container" >/dev/null
	wait_for_health
	docker exec "$container" bun -e '
		const {readFileSync} = await import("node:fs");
		const home = "/home/opencode";
		const [claude, codex] = JSON.parse(readFileSync("/tmp/native-user-settings.json", "utf8"));
		if (claude !== readFileSync(`${home}/.claude/settings.json`, "utf8") || codex !== readFileSync(`${home}/.codex/config.toml`, "utf8")) throw Error("Native user settings overwritten");
		if (readFileSync(`${home}/.claude/plugins/installed_plugins.json`, "utf8") !== readFileSync("/native-defaults/claude/plugins/installed_plugins.json", "utf8")) throw Error("Untouched native plugin defaults did not refresh");'
	verify_workspace_runtime_boundary
	verify_builtin_skills
	if [ "$remote" != 0 ]; then
		# Codex's foreground app-server stays available without an account. Its
		# native Unix pairing socket must exist; enrollment is a separate stage.
		docker exec "$container" test -S /home/opencode/.codex/app-server-control/app-server-control.sock
		docker exec "$container" test ! -e /home/opencode/.codex/packages/app-server-daemon
		[[ "$(docker exec "$container" fhold-remote codex status)" == *process-running* ]]
		for tool in claude; do
			deadline=$((SECONDS + 45))
			while [[ "$(docker exec "$container" fhold-remote "$tool" status)" != *waiting-to-retry* ]]; do
				if ((SECONDS >= deadline)); then echo "$tool did not fail safely without login" >&2; exit 1; fi
				sleep 1
			done
			docker exec "$container" fhold-remote "$tool" status
		done
		docker exec "$container" fhold-healthcheck
		logs=$(docker logs "$container" 2>&1)
		if [[ "$logs" =~ (claude\.(ai|com)/code|pairingCode|manualPairingCode) ]]; then
			echo 'Native pairing output reached Docker logs' >&2; exit 1
		fi
	else
		for tool in codex claude; do
			[[ "$(docker exec "$container" fhold-remote "$tool" status)" == *not-started* ]]
		done
	fi
	;;
guardian)
	mkdir -p "$root/credentials/owner" "$root/config" "$root/logs" "$root/workspace" "$root/auth"
	cp -R packages/skeleton/system/guardian "$root/system"
	cp -R packages/skeleton/config/guardian/. "$root/config/"
	printf '%s\n' 'guardian-smoke-password-0000000000000000' >"$root/password"
	printf '%s\n' 'guardian-smoke-handle-key-000000000000000' >"$root/handle"
	printf '%s\n' 'guardian-smoke-credential-000000000000000' >"$root/credentials/owner/key"
	printf '%s\n' '{"version":1,"credentials":[{"username":"owner","id":"owner","policy":"read"}]}' >"$root/credentials/registry.json"
	printf '%s\n' '{}' >"$root/auth/auth.json"
	chmod -R a+rwX "$root/logs"
	docker run -d --name "$container" \
		-e GUARDIAN_AUTH_DIR=/run/fhold-credentials \
		-e GUARDIAN_HANDLE_KEY_FILE=/run/fhold/handle \
		-e OPENCODE_SERVER_PASSWORD_FILE=/run/fhold/password \
		-e GUARDIAN_OAUTH_CONFIG_FILE=/opt/fhold/guardian/.config/opencode/oauth.json \
		-e GUARDIAN_OAUTH_IDENTITIES_FILE=/opt/fhold/guardian/.config/opencode/oauth-identities.json \
		-v "$root/credentials:/run/fhold-credentials:ro" \
		-v "$root/system:/opt/fhold/moderator-config:ro" \
		-v "$root/config:/opt/fhold/guardian/.config/opencode:ro" \
		-v "$root/auth/auth.json:/opt/fhold/guardian/.local/share/opencode/auth.json:ro" \
		-v "$root/logs:/opt/fhold/logs" \
		-v "$root/workspace:/work:ro" \
		-v "$root/password:/run/fhold/password:ro" \
		-v "$root/handle:/run/fhold/handle:ro" \
		"$image" >/dev/null
	wait_for_health
	verify_runtime_versions
	docker exec "$container" curl -sf http://127.0.0.1:8080/health >/dev/null
	status=$(docker exec "$container" curl -sS -o /dev/null -w '%{http_code}' -X POST \
		http://127.0.0.1:8080/mcp -H 'content-type: application/json' \
		--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
	test "$status" = 401
	docker exec "$container" curl -sf -X POST http://127.0.0.1:8080/mcp \
		-H 'content-type: application/json' \
		-H 'accept: application/json, text/event-stream' \
		-H 'authorization: Bearer guardian-smoke-credential-000000000000000' \
		--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' >/dev/null
	;;
portal)
	test "$(docker run --rm --entrypoint bun "$image" --version)" = "$expected_bun"
	docker run --rm --entrypoint sh "$image" -c \
		'test "$(id -u)" != 0 && test -r /app/src/index.ts && command -v bun >/dev/null && command -v curl >/dev/null'
	if docker run --name "$container" "$image" >/dev/null 2>&1; then
		echo 'Portal image started without selecting a guarded adapter' >&2
		exit 1
	fi
	;;
*)
	echo "Unknown image kind: $kind" >&2
	exit 1
	;;
esac
