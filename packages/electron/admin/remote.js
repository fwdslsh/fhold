import { state } from './state.js';
import { all, byId, message, notice, operation, setBadge, setBusy } from './ui.js';
import { refresh } from './snapshot.js';
import { offerRestart } from './restart.js';

let tool;
let running = false;
let timer;
let starting = false;
let connectionOnly = false;
let recallOnly = false;
let recallReview;
let reviewRequest = 0;

function renderSandboxHelp() {
	byId('remote-sandbox-help').textContent =
		byId('remote-sandbox').value === 'danger-full-access'
			? 'Use only when the container is your isolation boundary. Codex can access every file, credential and network connection available inside it. Task permissions follow the instance policy.'
			: 'Uses Codex’s native sandbox and the instance task permission policy. This requires host sandbox support.';
}

export function recallStatusLabel(review) {
	if (review?.managed)
		return review.status === 'ready'
			? 'Managed · ready'
			: review.status === 'installed'
				? 'Managed · disabled'
				: 'Managed · needs attention';
	return (
		{ installed: 'Installed', 'approval-needed': 'Approval needed', ready: 'Ready' }[
			review?.status
		] ?? 'Not checked'
	);
}

function renderRecallStatus(review, error) {
	setBadge(
		byId('codex-recall-status'),
		recallStatusLabel(review),
		review?.status === 'ready' ? 'success' : 'neutral'
	);
	byId('codex-recall-guidance').textContent =
		error ??
		(review?.managed
			? review.status === 'ready'
				? 'Controlled by the instance policy. No personal hook approval is required.'
				: 'Knowledge recall is not fully enabled. Review config/codex/requirements.toml on the host; personal approval cannot change managed hooks.'
			: review?.status === 'approval-needed'
				? 'AKM hooks need approval or are partly disabled. Review to enable complete automatic recall.'
				: review?.status === 'ready'
					? 'Native approval was verified in this explicit review. Review again after a restart or hook changes.'
					: 'Review AKM hooks here; no Codex command is needed. Start Assistant to check approval.');
}

export function renderRemoteStatus(snapshot) {
	// General inspection never invokes native hook inventory or preserves stale readiness.
	renderRecallStatus(snapshot.codexRecall, snapshot.codexRecallError);
	for (const name of ['claude', 'codex']) {
		const enabled = snapshot.config.assistant[`${name}Remote`] === true;
		setBadge(
			byId(`${name}-remote-status`),
			enabled ? 'Startup enabled · client connection not checked' : 'Startup off',
			'neutral'
		);
		for (const button of all(`[data-remote-connect="${name}"]`))
			button.disabled = state.operationInFlight || !enabled;
		for (const button of all(`[data-remote-disable="${name}"]`)) button.hidden = !enabled;
	}
}

async function loadRecall() {
	const request = ++reviewRequest;
	recallReview = undefined;
	renderRecallStatus(undefined);
	byId('remote-recall').checked = false;
	byId('remote-recall').disabled = true;
	byId('remote-begin').disabled = true;
	byId('remote-recall-status').textContent = 'Checking native hook approval…';
	byId('remote-recall-definitions').value = '';
	byId('remote-recall-disable').hidden = true;
	try {
		const review = await state.api.codexRecall({ action: 'review' });
		if (request !== reviewRequest || !byId('remote-dialog').open) return;
		recallReview = review;
		renderRecallStatus(review);
		byId('remote-recall-status').textContent =
			`${recallStatusLabel(review)}${review.hooks.some((h) => h.trust === 'modified') ? ' · definitions changed; review again' : ''}`;
		byId('remote-recall-definitions').value = review.hooks
			.map(
				(h) =>
					`${h.event} (${h.trust}${h.enabled ? '' : ', off'})\n${h.command}\nDefinition: ${h.sourcePath}\nHash: ${h.hash}`
			)
			.join('\n\n');
		byId('remote-recall').disabled = review.managed === true;
		byId('remote-recall').required = recallOnly && !review.managed;
		byId('remote-recall').checked = review.status === 'ready';
		byId('remote-recall-disable').hidden =
			review.managed || !recallOnly || !review.hooks.some((h) => h.enabled);
		byId('remote-begin').hidden = recallOnly && review.managed;
		if (review.managed) {
			byId('remote-guidance').textContent =
				review.status === 'ready'
					? 'The instance manages these hooks. No approval is needed.'
					: 'The instance policy must enable all AKM hooks for automatic recall to work.';
			if (recallOnly)
				byId('remote-stage').textContent =
					review.status === 'ready'
						? 'Managed hook configuration verified.'
						: 'Managed knowledge recall needs attention.';
		}
		byId('remote-begin').disabled = false;
	} catch (error) {
		if (request !== reviewRequest || !byId('remote-dialog').open) return;
		renderRecallStatus(undefined, message(error));
		byId('remote-recall-status').textContent = message(error);
		byId('remote-begin').disabled = recallOnly;
	}
}

export function remoteStageText(progress) {
	if (progress.error) return progress.error;
	if (progress.enabled) return 'Startup enabled. Connect your client and verify a real request.';
	return (
		{
			starting: 'Preparing your agent…',
			sandbox: 'Checking that this computer can safely run Codex…',
			'container-isolation': 'Using your explicitly selected container isolation…',
			'sign-in': 'Finish account sign-in in your browser.',
			account: 'Checking your account…',
			'trust-and-consent': 'Review the workspace and remote-access prompts below.',
			enabling: 'Enabling remote startup…',
			pairing: 'Getting your connection details…',
			connection: 'Your private connection details are below.',
			failed: 'Setup did not finish. Remote startup is off.'
		}[progress.stage] ?? 'Preparing remote access…'
	);
}

function showProgress(progress) {
	running = progress.running;
	byId('remote-stage').textContent = remoteStageText(progress);
	const answering =
		running &&
		tool === 'claude' &&
		['sign-in', 'trust-and-consent'].includes(progress.stage) &&
		Boolean(progress.output.trim());
	byId('remote-answer-field').hidden = !answering;
	byId('remote-answer-label').textContent =
		progress.stage === 'trust-and-consent'
			? 'Your answer, as requested in the native prompt'
			: 'Sign-in code, if requested';
	byId('remote-guidance').textContent =
		progress.stage === 'trust-and-consent'
			? 'Read the native prompts before answering. fhold will not approve workspace trust or remote access for you.'
			: progress.stage === 'sign-in'
				? 'Complete sign-in in the browser. If Claude asks for a code, paste it below. Codex device codes are entered in the browser.'
				: 'Keep connection details private. Startup alone does not confirm that your client is connected.';
	const step = ['starting', 'sandbox', 'container-isolation'].includes(progress.stage)
		? 'access'
		: ['sign-in', 'account', 'trust-and-consent'].includes(progress.stage)
			? 'sign-in'
			: 'connect';
	for (const item of all('[data-remote-step]'))
		item.setAttribute('aria-current', item.dataset.remoteStep === step ? 'step' : 'false');
	byId('remote-begin').hidden = running || progress.enabled;
	byId('remote-output').value = progress.output;
	if (answering || progress.enabled || progress.error || progress.stage === 'connection')
		byId('remote-output-details').open = true;
	byId('remote-output').scrollTop = byId('remote-output').scrollHeight;
	byId('remote-send').disabled = !answering;
	byId('remote-send').hidden = !answering;
	byId('remote-cancel').textContent = running ? 'Cancel setup' : 'Close';
	if (!running) {
		clearTimeout(timer);
		setBusy(false);
		byId('remote-begin').disabled = false;
		byId('remote-trust').disabled = false;
		byId('remote-sandbox').disabled = false;
		byId('remote-recall').disabled = !recallReview || recallReview.managed === true;
		byId('remote-answer').value = '';
		void refresh();
	} else {
		timer = setTimeout(async () => {
			try {
				showProgress(await state.api.remote({ action: 'progress', tool }));
			} catch (error) {
				byId('remote-stage').textContent =
					message(error); /* Keep Cancel available; never report success. */
			}
		}, 1000);
	}
}

export function bindRemoteEvents() {
	byId('remote-sandbox').addEventListener('change', renderSandboxHelp);
	for (const button of all(
		'[data-remote-enable], [data-remote-connect], [data-codex-recall-review]'
	))
		button.addEventListener('click', () => {
			reviewRequest++;
			recallOnly = Object.hasOwn(button.dataset, 'codexRecallReview');
			connectionOnly = Boolean(button.dataset.remoteConnect);
			tool = recallOnly ? 'codex' : (button.dataset.remoteEnable ?? button.dataset.remoteConnect);
			byId('remote-heading').textContent = recallOnly
				? 'Automatic knowledge recall for Codex'
				: connectionOnly
					? tool === 'claude'
						? 'Open Claude remote session (experimental)'
						: 'Get Codex pairing code (experimental)'
					: tool === 'claude'
						? 'Enable Claude Remote Control (experimental)'
						: 'Enable Codex remote (experimental)';
			byId('remote-trust-field').hidden = connectionOnly || recallOnly;
			byId('remote-trust').required = !connectionOnly && !recallOnly;
			byId('remote-begin').textContent = recallOnly
				? 'Save knowledge recall approval'
				: connectionOnly
					? 'Get connection details'
					: 'Continue';
			byId('remote-begin').hidden = false;
			byId('remote-begin').disabled = false;
			byId('remote-advanced').hidden = connectionOnly || recallOnly || tool !== 'codex';
			byId('remote-advanced').open = false;
			byId('remote-sandbox-field').hidden = connectionOnly || recallOnly || tool !== 'codex';
			byId('remote-recall-field').hidden = connectionOnly || tool !== 'codex';
			byId('remote-recall-heading').hidden = recallOnly;
			byId('remote-recall').required = recallOnly;
			byId('remote-sandbox').value =
				state.currentConfig?.assistant.codexSandbox ?? 'workspace-write';
			renderSandboxHelp();
			byId('remote-trust').checked = false;
			byId('remote-stage').textContent = recallOnly
				? 'Review the AKM commands, then save your choice. Remote startup is unchanged.'
				: connectionOnly
					? 'Get fresh private connection details from the running agent.'
					: 'Ready to begin. Existing remote startup is paused during setup.';
			byId('remote-output').value = '';
			byId('remote-prompts').hidden = true;
			byId('remote-output-details').open = false;
			byId('remote-answer-field').hidden = true;
			byId('remote-send').hidden = true;
			byId('remote-guidance').textContent = recallOnly
				? 'Approve only the commands you want Codex to run. No account sign-in is needed for this review.'
				: connectionOnly
					? 'Use these details in a supported client. Do not share pairing codes or links.'
					: 'Sign in through your browser, then approve any account or workspace prompts yourself.';
			for (const item of all('[data-remote-step]'))
				item.setAttribute(
					'aria-current',
					!connectionOnly && item.dataset.remoteStep === 'access' ? 'step' : 'false'
				);
			byId('remote-steps').hidden = connectionOnly || recallOnly;
			byId('remote-answer').value = '';
			byId('remote-send').disabled = true;
			byId('remote-cancel').textContent = 'Cancel';
			byId('remote-dialog').showModal();
			if (!connectionOnly && tool === 'codex') void loadRecall();
		});
	byId('remote-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (running) {
			byId('remote-send').click();
			return;
		}
		if (
			starting ||
			(recallOnly && recallReview?.managed) ||
			byId('remote-begin').disabled ||
			(!connectionOnly && !recallOnly && !byId('remote-trust').checked) ||
			(recallOnly && !byId('remote-recall').checked)
		)
			return;
		starting = true;
		const recallRequested = byId('remote-recall').checked;
		byId('remote-recall').disabled = true;
		setBusy(true);
		byId('remote-prompts').hidden = recallOnly;
		byId('remote-stage').textContent = 'Preparing Assistant…';
		try {
			if (!connectionOnly && !recallOnly && !(await state.api.confirmRestart('remote-setup'))) {
				byId('remote-stage').textContent = 'Setup postponed. No containers were restarted.';
				return;
			}
			if (!connectionOnly && tool === 'codex' && recallRequested && !recallReview?.managed) {
				if (!recallReview) throw new Error('Review current AKM hooks first.');
				{
					const review = await state.api.codexRecall({
						action: 'approve',
						digest: recallReview.digest,
						confirmed: true
					});
					if (review.status !== 'ready')
						throw new Error('Native hook approval did not become ready.');
					recallReview = review;
				}
				byId('remote-recall-status').textContent = 'Ready · native approval saved';
			}
			if (
				!connectionOnly &&
				!recallOnly &&
				tool === 'codex' &&
				!recallRequested &&
				!recallReview?.managed &&
				recallReview?.status === 'ready'
			) {
				await state.api.codexRecall({
					action: 'disable',
					digest: recallReview.digest,
					confirmed: true
				});
			}
			if (recallOnly) {
				byId('remote-stage').textContent =
					'Knowledge recall is ready for new Codex sessions. No remote connection was enabled.';
				byId('remote-begin').hidden = true;
				byId('remote-recall-disable').hidden = false;
				setBusy(false);
				await refresh();
				renderRecallStatus(recallReview);
				return;
			}
			const progress = await state.api.remote(
				connectionOnly
					? { action: 'connection', tool }
					: {
							action: 'enable',
							tool,
							trusted: true,
							restartConfirmed: true,
							...(tool === 'codex' ? { sandbox: byId('remote-sandbox').value } : {})
						}
			);
			byId('remote-trust').disabled = true;
			byId('remote-sandbox').disabled = true;
			byId('remote-cancel').disabled = false;
			showProgress(progress);
		} catch (error) {
			setBusy(false);
			byId('remote-stage').textContent = message(error);
			byId('remote-cancel').disabled = false;
			if (tool === 'codex' && !connectionOnly) {
				byId('remote-recall').checked = false;
				await loadRecall();
			}
		} finally {
			starting = false;
			if (!running) setBusy(false);
			if (!running) byId('remote-recall').disabled = !recallReview || recallReview.managed === true;
		}
	});
	byId('remote-send').addEventListener('click', async () => {
		const answer = byId('remote-answer').value;
		byId('remote-answer').value = '';
		try {
			await state.api.remote({ action: 'input', tool, input: answer });
		} catch (error) {
			byId('remote-stage').textContent = message(error);
		}
	});
	const cancel = async () => {
		if (starting) return;
		clearTimeout(timer);
		if (running) {
			byId('remote-cancel').disabled = true;
			byId('remote-stage').textContent = 'Cancelling setup and leaving startup off…';
			try {
				showProgress(await state.api.remote({ action: 'cancel', tool }));
			} catch (error) {
				notice(message(error), 'error', { persist: true });
			} finally {
				byId('remote-cancel').disabled = false;
			}
		}
		if (running) return;
		reviewRequest++;
		recallReview = undefined;
		byId('remote-answer').value = '';
		byId('remote-output').value = '';
		byId('remote-dialog').close();
	};
	byId('remote-cancel').addEventListener('click', cancel);
	byId('remote-dialog').addEventListener('cancel', (event) => {
		event.preventDefault();
		void cancel();
	});
	byId('remote-recall-disable').addEventListener('click', async () => {
		if (starting || running || !recallOnly || !recallReview || recallReview.managed) return;
		starting = true;
		setBusy(true);
		try {
			await state.api.codexRecall({
				action: 'disable',
				digest: recallReview.digest,
				confirmed: true
			});
			byId('remote-stage').textContent =
				'Automatic knowledge recall is off. Native approval is retained; remote startup is unchanged.';
			byId('remote-begin').hidden = false;
			await refresh();
			await loadRecall();
		} catch (error) {
			byId('remote-stage').textContent = message(error);
			await loadRecall();
		} finally {
			starting = false;
			setBusy(false);
		}
	});
	for (const button of all('[data-remote-disable]'))
		button.addEventListener('click', async () => {
			const name = button.dataset.remoteDisable;
			const result = await operation(
				'Disabling remote startup',
				() => state.api.remote({ action: 'disable', tool: name }),
				'Remote startup setting saved. Apply it with a restart; account sign-in is retained.'
			);
			if (result) {
				await refresh();
				await offerRestart();
			}
		});
}
