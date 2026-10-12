// Shared domain rules: local Admin and SSH host management use one implementation.
export {
	interruptionPrompt,
	confirmedAdminAction,
	isAdminPageUrl,
	externalAdminUrl,
	adminPortalTokens,
	installFromAdmin,
	saveAdminConfig,
	createAdminCredential,
	rotateAdminCredential,
	removeAdminCredential,
	mapAdminPortalUser,
	adminPortalMappings,
	backupFromAdmin,
	instanceRestoreFromAdmin,
	restoreFromAdmin
} from '@fhold/lib';
