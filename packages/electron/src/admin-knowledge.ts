import { type BrowserWindow, WebContentsView, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { externalAdminUrl } from './admin-domain.js';

/** The native AKM page owns its UI and cookie. Admin only hosts its browser view. */
export class AdminKnowledge {
	private readonly view: WebContentsView;
	private layoutGeneration = 0;
	private closed = false;
	private readonly resize = () => {
		void this.sync();
	};
	private readonly navigating = () => {
		this.layoutGeneration++;
		this.view.setVisible(false);
	};
	private readonly ownerClosed = () => this.close();
	constructor(
		private readonly owner: BrowserWindow,
		private readonly origin: string
	) {
		this.view = new WebContentsView({
			webPreferences: {
				partition: `fhold-akm-${randomUUID()}`,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true
			}
		});
		const contents = this.view.webContents;
		contents.session.setPermissionRequestHandler((requester, permission, callback) =>
			callback(
				permission === 'clipboard-sanitized-write' &&
					requester === contents &&
					this.allowed(requester.getURL())
			)
		);
		contents.session.setPermissionCheckHandler(
			(requester, permission, requestingOrigin) =>
				permission === 'clipboard-sanitized-write' &&
				requester === contents &&
				this.allowed(requestingOrigin)
		);
		contents.setWindowOpenHandler(({ url }) => {
			// Native same-origin target=_blank links remain inside this browser.
			if (this.allowed(url)) void contents.loadURL(url).catch(() => undefined);
			else {
				try {
					// AKM's explicit external docs/auth links use the existing OS
					// web-link boundary, never a second privileged guest window.
					void shell.openExternal(externalAdminUrl(url)).catch(() => undefined);
				} catch {
					/* Reject non-web schemes and embedded credentials. */
				}
			}
			return { action: 'deny' };
		});
		contents.on('will-navigate', (event, url) => {
			if (!this.allowed(url)) event.preventDefault();
		});
		contents.on('will-redirect', (event, url) => {
			if (!this.allowed(url)) event.preventDefault();
		});
		contents.on('will-attach-webview', (event) => event.preventDefault());
		this.view.setVisible(false);
		owner.contentView.addChildView(this.view);
		owner.on('resize', this.resize);
		owner.once('closed', this.ownerClosed);
		owner.webContents.on('did-start-navigation', this.navigating);
	}
	private allowed(value: string): boolean {
		try {
			const url = new URL(value);
			return url.origin === this.origin && !url.username && !url.password;
		} catch {
			return false;
		}
	}
	async open(url: string): Promise<void> {
		if (this.closed || !this.allowed(url)) throw new Error('AKM UI is unavailable.');
		try {
			await this.view.webContents.loadURL(url);
			await this.sync();
		} catch {
			this.close();
			// Chromium errors can contain the private bootstrap URL.
			throw new Error(
				'Could not load this Assistant’s AKM UI. Check the connection and try again.'
			);
		}
	}
	async sync(): Promise<void> {
		const generation = ++this.layoutGeneration;
		if (this.closed || this.owner.isDestroyed()) return;
		// No renderer-supplied URL or bounds. Measure our own fixed placeholder,
		// and clip to the actual window so embedded content cannot cover chrome.
		const rect = (await this.owner.webContents
			.executeJavaScript(`(() => {
			const slot = document.getElementById('knowledge-viewport');
			if (!slot || !slot.checkVisibility() || slot.closest('[inert]') || document.body.dataset.phase !== 'ready' ||
				document.body.dataset.busy === 'true' || document.querySelector('dialog[open]')) return null;
			const {x,y,width,height} = slot.getBoundingClientRect();
			return {x,y,width,height};
		})()`)
			.catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
		if (this.closed || generation !== this.layoutGeneration || this.owner.isDestroyed()) return;
		if (!rect || !Object.values(rect).every(Number.isFinite)) {
			this.view.setVisible(false);
			return;
		}
		const [width, height] = this.owner.getContentSize();
		const zoom = this.owner.webContents.getZoomFactor();
		const x = Math.min(width, Math.max(0, Math.ceil(rect.x * zoom)));
		const y = Math.min(height, Math.max(0, Math.ceil(rect.y * zoom)));
		const bounds = {
			x,
			y,
			width: Math.max(0, Math.min(width, Math.floor((rect.x + rect.width) * zoom)) - x),
			height: Math.max(0, Math.min(height, Math.floor((rect.y + rect.height) * zoom)) - y)
		};
		this.view.setBounds(bounds);
		this.view.setVisible(bounds.width > 0 && bounds.height > 0);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.layoutGeneration++;
		this.owner.removeListener('resize', this.resize);
		this.owner.removeListener('closed', this.ownerClosed);
		if (!this.owner.isDestroyed() && !this.owner.webContents.isDestroyed())
			this.owner.webContents.removeListener('did-start-navigation', this.navigating);
		if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(this.view);
		if (!this.view.webContents.isDestroyed()) {
			const storage = this.view.webContents.session;
			this.view.webContents.close();
			void storage.clearStorageData().catch(() => undefined);
		}
	}
}
