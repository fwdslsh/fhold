// Canonical docs become generated pages; no copies are written into docs/.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sections = {
	guides: ['Guides', 'Install, manage, and build a lasting home for your personal AI.'],
	connect: ['Connect', 'Use fhold from your clients, messaging apps, and native agent tools.'],
	reference: ['Reference', 'Configuration and interfaces for using fhold.'],
	maintainers: [
		'Maintainers',
		'Development, testing, architecture, implementation reviews, and release procedures.'
	]
};
const referenceDocs = new Set([
	'managed-harness-configuration.md',
	'technical/api-spec.md',
	'technical/environment-and-mounts.md',
	'technical/opencode-configuration.md'
]);
const connectionDocs = new Set(['remote-mcp.md', 'claude-desktop.md', 'native-remote-access.md']);

export function routeFor(file) {
	if (file === 'README.md') return 'documentation/index.md';
	if (referenceDocs.has(file)) return `reference/${file.replace(/^technical\//, '')}`;
	if (connectionDocs.has(file) || file.startsWith('portals/')) {
		return `connect/${file.replace(/^portals\//, '')}`;
	}
	if (file.startsWith('technical/') || file.startsWith('operations/')) {
		return `maintainers/${file}`;
	}
	return `guides/${file}`;
}

function inventory(root, prefix = '') {
	return readdirSync(join(root, prefix), { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const file = prefix ? `${prefix}/${entry.name}` : entry.name;
			return entry.isDirectory() ? inventory(root, file) : file.endsWith('.md') ? [file] : [];
		});
}

const escapeHtml = (text) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const hrefFor = (route) => `/${route.replace(/\.md$/, '.html')}`;

export function rewriteLinks(markdown, source, routes, repo) {
	// Preserve examples in fences/code spans; only real Markdown links change.
	let fence = null;
	return markdown
		.split('\n')
		.map((line) => {
			const marker = line.match(/^\s*(`{3,}|~{3,})/);
			if (marker) {
				if (!fence) fence = marker[1];
				else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
				return line;
			}
			if (fence) return line;
			return line
				.split(/(`+[^`]*`+)/)
				.map((part, index) => {
					if (index % 2) return part;
					return part.replace(
						/(\]\()([^\s)]+)((?:\s+"[^"]*")?\))/g,
						(whole, open, target, close) => {
							if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) return whole;
							const split = target.search(/[?#]/);
							const pathname = split < 0 ? target : target.slice(0, split);
							const suffix = split < 0 ? '' : target.slice(split);
							const absolute = resolve(dirname(source), decodeURIComponent(pathname));
							const route = routes.get(absolute);
							const githubPath = relative(repo, absolute)
								.split(sep)
								.map(encodeURIComponent)
								.join('/');
							return `${open}${route ? hrefFor(route) : `https://github.com/fwdslsh/fhold/blob/main/${githubPath}`}${suffix}${close}`;
						}
					);
				})
				.join('');
		})
		.join('\n');
}

function descriptionOf(markdown, title) {
	const paragraph = markdown.split(/\n\s*\n/).find((text) => /^[A-Za-z]/.test(text.trim()));
	const flat = (paragraph || `${title}: fhold documentation.`)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[`*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	const sentence = flat.split(/(?<=\.)\s/)[0];
	return sentence.length > 240 ? `${sentence.slice(0, 237).replace(/\s+\S*$/, '')}…` : sentence;
}

function page(title, description, body) {
	return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

export function generateDocs({ docs, repo, output }) {
	const files = inventory(docs);
	const routes = new Map(files.map((file) => [resolve(docs, file), routeFor(file)]));
	const groups = Object.fromEntries(Object.keys(sections).map((section) => [section, []]));
	const write = (file, text) => {
		const destination = join(output, file);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, text);
	};
	for (const file of files) {
		if (file === 'README.md') continue; // The documentation map is grouped below.
		const source = resolve(docs, file);
		const markdown = readFileSync(source, 'utf8');
		const title = markdown.match(/^#\s+(.+)$/m)?.[1] || file.replace(/\.md$/, '');
		const route = routes.get(source);
		const description = descriptionOf(markdown, title);
		const section = route.split('/')[0];
		groups[section].push({ title, route, description });
		const sourcePath = relative(repo, source).split(sep).map(encodeURIComponent).join('/');
		write(
			route,
			page(
				title,
				description,
				`${rewriteLinks(markdown, source, routes, repo)}\n\n<p class="source-link"><a href="https://github.com/fwdslsh/fhold/blob/main/${sourcePath}">View this page on GitHub</a></p>`
			)
		);
	}
	const lists = {};
	for (const [section, entries] of Object.entries(groups)) {
		const [title, description] = sections[section];
		entries.sort((a, b) => a.title.localeCompare(b.title));
		lists[section] = entries
			.map(
				(entry) => `- [${entry.title}](${hrefFor(entry.route)}) — ${escapeHtml(entry.description)}`
			)
			.join('\n');
		write(
			`${section}/index.md`,
			page(title, description, `# ${title}\n\n${description}\n\n${lists[section]}`)
		);
	}
	write(
		'documentation/index.md',
		page(
			'Documentation',
			'Find user guides, connections, configuration reference, and maintainer documentation for fhold.',
			`# Documentation\n\n${Object.entries(sections)
				.map(
					([section, [title, description]]) => `## ${title}\n\n${description}\n\n${lists[section]}`
				)
				.join('\n\n')}`
		)
	);
	write(
		'_includes/docnav.html',
		`<nav class="docnav" id="docnav" aria-label="Documentation sections">${Object.entries(sections)
			.map(([section, [title]]) => {
				const links = `<ul><li><a href="/${section}/index.html">${escapeHtml(title)} overview</a></li>${groups[section]
					.map((entry) => `<li><a href="${hrefFor(entry.route)}">${escapeHtml(entry.title)}</a></li>`)
					.join('')}</ul>`;
				return section === 'maintainers'
					? `<details class="maintainer-nav"><summary>${escapeHtml(title)}</summary>${links}</details>`
					: `<div><p class="docnav-label">${escapeHtml(title)}</p>${links}</div>`;
			})
			.join('\n')}<p class="docnav-all"><a href="/all-pages.html">All pages →</a></p></nav>\n`
	);
	return files.length;
}

if (import.meta.main) {
	const repo = fileURLToPath(new URL('../../', import.meta.url));
	const count = generateDocs({ docs: join(repo, 'docs'), repo, output: process.argv[3] });
	console.log(`Generated ${count} documentation pages and section indexes.`);
}
