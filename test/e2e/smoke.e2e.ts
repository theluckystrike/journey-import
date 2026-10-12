import { browser, expect } from '@wdio/globals';
import { resolve } from 'node:path';
import type JourneyImportPlugin from '../../src/main';
import { pluginId, reloadPlugin } from './load';

async function reset(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, JourneyImportPlugin> } }).plugins.plugins[id]!;
		p.pro!.signOut();
		p.settings = { folder: 'E2E Journey', attachments: 'E2E Journey/attachments', merge: false, group: false, pattern: '{date} {time}' };
		const folder = app.vault.getAbstractFileByPath('E2E Journey');
		if (folder) await app.vault.delete(folder, true);
		document.querySelectorAll<HTMLElement>('.modal-close-button').forEach((el) => el.click());
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
	}, pluginId, on);
}
async function importFixture(overrides: Record<string, unknown> = {}) {
	return browser.executeObsidian(async ({ app }, id, opts) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, JourneyImportPlugin> } }).plugins.plugins[id]!;
		const file = app.vault.getFileByPath('journey-fixture.zip')!;
		const archive = p.parseZip(new Uint8Array(await app.vault.readBinary(file)));
		return p.importArchive(archive, { ...p.settings, ...opts });
	}, pluginId, overrides);
}

describe('Journey real app import', function () {
	beforeEach(reset);
	it('loads and reloads without errors', async function () {
		expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
	});
	it('selects a ZIP with the file picker previews counts and imports', async function () {
		await browser.executeObsidianCommand(`${pluginId}:import-zip`);
		const input = await browser.$('input[aria-label="Journey ZIP backup"]');
		await input.waitForExist();
		await input.setValue(resolve('test/e2e/vault/journey-fixture.zip'));
		await browser.waitUntil(async () => (await browser.$('.journey-counts').getText()).includes('2 entries · 1 photos · 0 warnings'), { timeout: 15000 });
		await browser.$('.journey-import-modal').$('button=Import entries').click();
		await browser.waitUntil(async () => (await browser.$('.journey-preview').getText()).includes('Imported 2 entries and 1 photos.'), { timeout: 15000 });
		const content = await browser.executeObsidian(async ({ app }) => app.vault.read(app.vault.getFileByPath('E2E Journey/2021-07-01 1200.md')!));
		expect(content).toContain('2021-07-01T12:00:00+02:00');
		expect(content).toContain('**bold**');
		expect(content).toContain('*italic*');
		expect(content).toContain('![[E2E Journey/attachments/1625494049547-4BbDhzcByTFSg6MW-5bkOJACgIzl36wsU.jpg]]');
		const photoSize = await browser.executeObsidian(async ({ app }) => (await app.vault.readBinary(app.vault.getFileByPath('E2E Journey/attachments/1625494049547-4BbDhzcByTFSg6MW-5bkOJACgIzl36wsU.jpg')!)).byteLength);
		expect(photoSize).toBe(81680);
	});
	it('keeps existing notes and suffixes another import', async function () {
		await importFixture();
		const second = await importFixture();
		expect(second.paths).toContain('E2E Journey/2021-07-01 1200 (2).md');
		expect(second.attachments).toBe(1);
	});
	it('does not execute Pro options when signed out', async function () {
		const result = await importFixture({ merge: true, group: true, pattern: '{id}' });
		expect(result.paths).toContain('E2E Journey/2021-07-01 1200.md');
	});
	it('merges Pro entries while keeping daily frontmatter', async function () {
		await setPro(true);
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.createFolder('E2E Journey');
			await app.vault.create('E2E Journey/2021-07-01.md', '---\nkeep: yes\n---\n\n# Existing day\n');
		});
		const result = await importFixture({ merge: true });
		expect(result.paths).toContain('E2E Journey/2021-07-01.md');
		const text = await browser.executeObsidian(async ({ app }) => app.vault.read(app.vault.getFileByPath('E2E Journey/2021-07-01.md')!));
		expect(text).toContain('---\nkeep: yes\n---');
		expect(text).toContain('## 12:00 Journey entry');
		expect(text).toContain('journey_id: 1625494049547-4BbDhzcByTFSg6MW');
		await setPro(false);
	});
	it('groups Pro notes with a custom file name', async function () {
		await setPro(true);
		const result = await importFixture({ group: true, pattern: 'Diary {date} {time}' });
		expect(result.paths).toContain('E2E Journey/2021/07/Diary 2021-07-01 1200.md');
		await setPro(false);
	});
	it('shows the empty backup notice and makes no notes', async function () {
		const result = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, JourneyImportPlugin> } }).plugins.plugins[id]!;
			const file = app.vault.getFileByPath('empty-backup.zip')!;
			return p.importArchive(p.parseZip(new Uint8Array(await app.vault.readBinary(file))), p.settings);
		}, pluginId);
		expect(result.notes).toBe(0);
		expect(result.attachments).toBe(0);
		const found = await browser.executeObsidian(() => Array.from(document.querySelectorAll('.notice')).some((el) => el.textContent?.includes('No Journey entries found')));
		expect(found).toBe(true);
	});
});
