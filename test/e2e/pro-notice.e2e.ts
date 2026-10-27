import { browser, expect } from '@wdio/globals';
import { resolve } from 'node:path';
import type JourneyImportPlugin from '../../src/main';
import { pluginId } from './load';

const MERGE = 'Merge by date (Pro)';
const GROUP = 'Year and month folders (Pro)';
const PATTERN = 'File name pattern (Pro)';
const MERGE_LEAD = 'Merge by date needs Pro.';
const GROUP_LEAD = 'Year and month folders need Pro.';
const PATTERN_LEAD = 'A custom file name pattern needs Pro.';
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';

interface ModalState { options: { merge: boolean; group: boolean; pattern: string }; preview: string[]; toggles: Record<string, boolean>; pattern: string }

async function reset(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, JourneyImportPlugin> } }).plugins.plugins[id]!;
		p.pro!.signOut();
		p.settings = { folder: 'E2E Journey', attachments: 'E2E Journey/attachments', merge: false, group: false, pattern: '{date} {time}' };
		const folder = app.vault.getAbstractFileByPath('E2E Journey');
		if (folder) await app.vault.delete(folder, true);
		document.querySelectorAll<HTMLElement>('.modal-close-button').forEach((el) => el.click());
		document.querySelectorAll('.notice').forEach((n) => n.remove());
	}, pluginId);
}

async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, id, active) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, JourneyImportPlugin> } }).plugins.plugins[id]!;
		if (!active) { p.pro!.signOut(); return; }
		const reply = { status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } };
		(p.pro as unknown as { opts: { http: unknown } }).opts.http = async () => reply;
		app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
		await p.pro!.refreshNow();
		if (!p.pro!.isPro()) throw new Error('The simulated Sponsors check did not turn Pro on.');
	}, pluginId, on);
}

/** Opens the import window from the command and selects the fixture ZIP with the file picker. */
async function openWithFixture(): Promise<void> {
	await browser.executeObsidianCommand(`${pluginId}:import-zip`);
	const input = await browser.$('input[aria-label="Journey ZIP backup"]');
	await input.waitForExist();
	await input.setValue(resolve('test/e2e/vault/journey-fixture.zip'));
	await browser.waitUntil(async () => (await browser.$('.journey-counts').getText()).includes('2 entries'), { timeout: 15000, timeoutMsg: 'The ZIP preview did not finish.' });
}

/** Clicks the toggle of the named row in the import window, as a user does. */
async function clickToggle(name: string): Promise<void> {
	await browser.executeObsidian((_, row) => {
		const item = [...document.querySelectorAll('.journey-import-modal .setting-item')].find((s) => s.querySelector('.setting-item-name')?.textContent === row);
		const toggle = item?.querySelector<HTMLElement>('.checkbox-container');
		if (!toggle) throw new Error(`No toggle for ${row}`);
		toggle.click();
	}, name);
}

async function patternInput() {
	await browser.executeObsidian((_, row) => {
		const item = [...document.querySelectorAll('.journey-import-modal .setting-item')].find((s) => s.querySelector('.setting-item-name')?.textContent === row);
		item?.querySelector('input')?.setAttribute('data-e2e', 'pattern');
	}, PATTERN);
	return browser.$('[data-e2e="pattern"]');
}

/** Puts a whole value in the pattern field and sends the input event that a typed key sends. */
async function typePattern(value: string): Promise<void> {
	await browser.executeObsidian((_, row, text) => {
		const item = [...document.querySelectorAll('.journey-import-modal .setting-item')].find((s) => s.querySelector('.setting-item-name')?.textContent === row);
		const input = item?.querySelector('input');
		if (!input) throw new Error(`No text field for ${row}`);
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, PATTERN, value);
}

/** Waits until the preview lines pass the check. On a timeout the error shows the last state. */
async function waitPreview(check: (lines: string[]) => boolean, message: string): Promise<void> {
	let last: ModalState | null = null;
	try {
		await browser.waitUntil(async () => { last = await modalState(); return check(last.preview); }, { timeout: 5000 });
	} catch {
		throw new Error(`${message} State: ${JSON.stringify(last)}`);
	}
}

async function modalState(): Promise<ModalState> {
	return browser.executeObsidian(({ app }, id, names) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, JourneyImportPlugin> } }).plugins.plugins[id]!;
		const modal = [...(p as unknown as { modals: Set<{ options: ModalState['options'] }> }).modals][0];
		if (!modal) throw new Error('No open import window.');
		const rows = [...document.querySelectorAll('.journey-import-modal .setting-item')];
		const row = (name: string) => rows.find((s) => s.querySelector('.setting-item-name')?.textContent === name);
		const toggles: Record<string, boolean> = {};
		for (const name of names.slice(0, 2)) toggles[name] = !!row(name)?.querySelector('.checkbox-container')?.classList.contains('is-enabled');
		return {
			options: { merge: modal.options.merge, group: modal.options.group, pattern: modal.options.pattern },
			preview: [...document.querySelectorAll('.journey-preview li')].map((li) => li.textContent ?? ''),
			toggles,
			pattern: row(names[2]!)?.querySelector('input')?.value ?? '',
		};
	}, pluginId, [MERGE, GROUP, PATTERN]);
}

async function notices(): Promise<{ text: string; buttons: number }[]> {
	return browser.executeObsidian(() => [...document.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', buttons: n.querySelectorAll('.pf-pro-notice-sponsor').length })));
}

async function waitNotice(lead: string): Promise<{ text: string; buttons: number }> {
	await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes(lead)), { timeout: 5000, timeoutMsg: `No Pro notice with "${lead}".` });
	return (await notices()).find((n) => n.text.includes(lead))!;
}

describe('Journey Pro options in the import window', function () {
	beforeEach(reset);
	after(reset);

	it('a free user who selects a Pro option gets a Pro notice with a Sponsor button and no Pro import', async function () {
		await openWithFixture();
		const before = await modalState();
		expect(before.preview.every((line) => line.startsWith('Create: '))).toBe(true);

		await clickToggle(MERGE);
		const merge = await waitNotice(MERGE_LEAD);
		expect(merge.text).toContain(`${MERGE_LEAD} ${PITCH}`);
		expect(merge.buttons).toBe(1);

		await clickToggle(GROUP);
		const group = await waitNotice(GROUP_LEAD);
		expect(group.text).toContain(`${GROUP_LEAD} ${PITCH}`);
		expect(group.buttons).toBe(1);

		const input = await patternInput();
		await input.click();
		await input.addValue('x');
		await input.addValue('y');
		const pattern = await waitNotice(PATTERN_LEAD);
		expect(pattern.text).toContain(`${PATTERN_LEAD} ${PITCH}`);
		expect(pattern.buttons).toBe(1);
		// One notice for the pattern field, not one for each key.
		expect((await notices()).filter((n) => n.text.includes(PATTERN_LEAD)).length).toBe(1);

		const after = await modalState();
		expect(after.options).toEqual(before.options);
		expect(after.options).toEqual({ merge: false, group: false, pattern: '{date} {time}' });
		expect(after.toggles).toEqual({ [MERGE]: false, [GROUP]: false });
		expect(after.pattern).toBe('{date} {time}');
		expect(after.preview).toEqual(before.preview);
	});

	it('a Pro user who selects the same options gets them in the preview and no notice', async function () {
		await setPro(true);
		try {
			await openWithFixture();
			await clickToggle(GROUP);
			await typePattern('Diary {date} {time}');
			await waitPreview((lines) => lines.some((line) => line.includes('E2E Journey/2021/07/Diary 2021-07-01 1200.md')), 'The preview did not use the Pro folders and pattern.');
			await clickToggle(MERGE);
			await waitPreview((lines) => lines.some((line) => line.startsWith('Append: ')), 'The preview did not use Merge by date.');
			const state = await modalState();
			expect(state.options).toEqual({ merge: true, group: true, pattern: 'Diary {date} {time}' });
			expect(state.toggles).toEqual({ [MERGE]: true, [GROUP]: true });
			expect((await notices()).some((n) => n.text.includes('needs Pro') || n.text.includes('need Pro'))).toBe(false);
		} finally {
			await setPro(false);
		}
	});
});
