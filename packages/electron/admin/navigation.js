// Local view navigation: keep the existing form nodes (and unsaved drafts)
// mounted while moving between a card index and its editors.
function pages(scope) {
	return [...scope.children].filter((element) => element.hasAttribute('data-detail-page'));
}

function display(scope, selected) {
	for (const page of pages(scope)) page.hidden = page !== selected;
	scope.querySelector(':scope > [data-navigation-index]').hidden = !!selected;
}

export function openDetail(id, { focus = true } = {}) {
	const page = document.getElementById(id);
	if (!page?.hasAttribute('data-detail-page')) return;
	const scope = page.parentElement;
	const parent = scope.closest('[data-detail-page]');
	if (parent) openDetail(parent.id, { focus: false });
	display(scope, page);
	if (focus) {
		page.querySelector('h2').focus();
		page.scrollIntoView({ block: 'start' });
	}
}

export function resetDetails(view) {
	for (const scope of document.querySelectorAll(`#${view.id}[data-navigation], #${view.id} [data-navigation]`))
		display(scope, null);
}

export function bindDetailNavigation() {
	for (const scope of document.querySelectorAll('[data-navigation]')) {
		const index = document.createElement('nav');
		index.dataset.navigationIndex = '';
		index.className = 'navigation-cards';
		index.setAttribute('aria-label', scope.dataset.navigation);
		for (const page of pages(scope)) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'navigation-card';
			button.dataset.detailTarget = page.id;
			const title = document.createElement('strong');
			title.textContent = page.dataset.title;
			const description = document.createElement('span');
			description.textContent = page.dataset.description;
			button.append(title, description);
			button.addEventListener('click', () => openDetail(page.id));
			index.append(button);
			const back = document.createElement('button');
			back.type = 'button';
			back.className = 'text-button detail-back';
			back.textContent = `← Back to ${scope.dataset.navigation}`;
			back.addEventListener('click', () => {
				display(scope, null);
				button.focus();
			});
			page.prepend(back);
		}
		scope.prepend(index);
	}
}
