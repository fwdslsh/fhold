// Shared domain rules: local Admin and SSH host management use one implementation.
export {
	interruptionPrompt,
	confirmedAdminAction,
	isAdminPageUrl,
	externalAdminUrl,
	installFromAdmin
} from '@fhold/lib';
