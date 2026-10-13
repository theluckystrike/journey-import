import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian-test-mocks/obsidian';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import JourneyImportPlugin from '../src/main';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { bindPro, isPro, resetPro, SPONSORS } from '../src/pro';
import { readZip, readArchive, planImport, DEFAULT_OPTIONS, textHtml, convertBody } from '../src/importer';
import manifest from '../manifest.json';

afterEach(() => resetPro());
const fixture = () => readZip(new Uint8Array(readFileSync('tests/fixtures/journey-fixture.zip')));
function setup(files: Record<string, string> = {}) {
	const app = App.createConfigured__({ files });
	const plugin = new JourneyImportPlugin(app as never, manifest as never);
	return { app, plugin };
}
function pro(value: boolean) { bindPro({ isPro: () => value, onChange: () => () => undefined } as never); }

describe('Journey import against a vault', () => {
	it('loads defaults and repairs bad saved data', async () => {
		const { plugin } = setup();
		await plugin.loadSettings();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ folder: 5 as never, merge: 'yes' as never })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
	it('writes the fixture notes and exact photo bytes', async () => {
		const { app, plugin } = setup();
		const archive = fixture();
		const result = await plugin.importArchive(archive, DEFAULT_OPTIONS);
		expect(result.notes).toBe(2);
		expect(result.attachments).toBe(1);
		const note = app.vault.getAbstractFileByPath('Journey/2021-07-01 1200.md') as TFile;
		expect(await app.vault.read(note)).toContain('date: 2021-07-01T12:00:00+02:00');
		const photo = app.vault.getAbstractFileByPath('Journey/attachments/1625494049547-4BbDhzcByTFSg6MW-5bkOJACgIzl36wsU.jpg') as TFile;
		expect(new Uint8Array(await app.vault.readBinary(photo))).toEqual(archive.files['1625494049547-4BbDhzcByTFSg6MW-5bkOJACgIzl36wsU.jpg']);
	});
	it('keeps an existing note and suffixes the second import', async () => {
		const { app, plugin } = setup({ 'Journey/2021-07-01 1200.md': 'Keep me' });
		const result = await plugin.importArchive(fixture(), DEFAULT_OPTIONS);
		expect(result.paths).toContain('Journey/2021-07-01 1200 (2).md');
		expect(await app.vault.read(app.vault.getAbstractFileByPath('Journey/2021-07-01 1200.md') as TFile)).toBe('Keep me');
	});
	it('appends Pro sections without changing existing daily properties', async () => {
		pro(true);
		const original = '---\nproject: Keep\n---\n\n# Today\n';
		const { app, plugin } = setup({ 'Daily/2021-07-01.md': original });
		await plugin.importArchive(fixture(), { ...DEFAULT_OPTIONS, folder: 'Daily', merge: true });
		const text = await app.vault.read(app.vault.getAbstractFileByPath('Daily/2021-07-01.md') as TFile);
		expect(text).toContain(original.trimEnd());
		expect(text).toContain('## 12:00 Journey entry');
		expect(text).toContain('```yaml\ndate: 2021-07-01T12:00:00+02:00');
	});
	it('creates one daily file for two same-day entries', async () => {
		pro(true);
		const { app, plugin } = setup();
		const entry = { date_journal: 1625133600000, timezone: 'Europe/Vienna', text: '<p>Hello</p>' };
		const archive = readArchive({ 'a.json': strToU8(JSON.stringify({ ...entry, id: 'a' })), 'b.json': strToU8(JSON.stringify({ ...entry, id: 'b' })) });
		await plugin.importArchive(archive, { ...DEFAULT_OPTIONS, merge: true });
		const text = await app.vault.read(app.vault.getAbstractFileByPath('Journey/2021-07-01.md') as TFile);
		expect(text.match(/## 12:00 Journey entry/g)).toHaveLength(2);
	});
	it('turns off Pro at execution after a preview', async () => {
		pro(true);
		const { plugin } = setup();
		const opts = { ...DEFAULT_OPTIONS, group: true, merge: true, pattern: '{id}' };
		expect(plugin.preview(fixture(), opts).notes[0]!.path).toBe('Journey/2021/06/2021-06-27.md');
		pro(false);
		const result = await plugin.importArchive(fixture(), opts);
		expect(result.paths).toContain('Journey/2021-07-01 1200.md');
	});
	it('writes to the vault root when the folders are empty', async () => {
		const { app, plugin } = setup();
		await plugin.importArchive(fixture(), { ...DEFAULT_OPTIONS, folder: '', attachments: '' });
		expect(app.vault.getAbstractFileByPath('2021-07-01 1200.md')).toBeInstanceOf(TFile);
		expect(app.vault.getAbstractFileByPath('1625494049547-4BbDhzcByTFSg6MW-5bkOJACgIzl36wsU.jpg')).toBeInstanceOf(TFile);
	});
	it('creates nothing when there is no Journey JSON', async () => {
		const { app, plugin } = setup();
		const result = await plugin.importArchive(readZip(zipSync({ 'settings.json': strToU8('{}') })), DEFAULT_OPTIONS);
		expect(result.notes).toBe(0);
		expect(app.vault.getFiles()).toHaveLength(0);
	});
	it('rejects a parent file before copying photos', async () => {
		const { app, plugin } = setup({ 'Journey': 'A file' });
		await expect(plugin.importArchive(fixture(), DEFAULT_OPTIONS)).rejects.toThrow('Folder path is a file');
		expect(app.vault.getFiles()).toHaveLength(1);
	});
	it('reports partial writes and permits a later import', async () => {
		const { plugin, app } = setup();
		const write = vi.spyOn(app.vault, 'create').mockRejectedValueOnce(new Error('Disk full'));
		await expect(plugin.importArchive(fixture(), DEFAULT_OPTIONS)).rejects.toThrow('Import stopped after 0 entries and 1 photos. Disk full');
		write.mockRestore();
		expect((await plugin.importArchive(fixture(), DEFAULT_OPTIONS)).notes).toBe(2);
	});
});

describe('ZIP limits and Sponsors terms', () => {
	it('removes resource tags before HTML parsing and keeps safe links', () => {
		const html = '<p style="background:url(https://example.invalid/x)">Walk <a href="https://example.invalid/story">story</a><img src="https://example.invalid/a"><iframe src="https://example.invalid/frame"></iframe></p>';
		expect(textHtml(html)).toBe('<p>Walk <a href="https://example.invalid/story">story</a></p>');
		expect(convertBody(html, 'html')).toContain('[story](https://example.invalid/story)');
	});

	it('skips macOS resource files in a ZIP made again in Finder', () => {
		const entry = { id: 'a', date_journal: 1625133600000, timezone: 'Europe/Vienna', text: '<p>Hi</p>' };
		const archive = readZip(zipSync({ 'a.json': strToU8(JSON.stringify(entry)), '__MACOSX/._a.json': new Uint8Array(8), '__MACOSX/._b.jpg': new Uint8Array(8) }));
		expect(archive.entries).toHaveLength(1);
		expect(archive.warnings).toEqual([]);
	});
	it('keeps the lines of plain text and Markdown autolinks', () => {
		expect(convertBody('Line one\nLine two\n\nPara two', 'html')).toBe('Line one\nLine two\n\nPara two');
		expect(convertBody('See <https://example.com> and 1 < 2 > 0 <b>x</b><img/src=y>', 'markdown')).toBe('See <https://example.com> and 1 < 2 > 0 x');
	});
	it('keeps the photo extension when a long name is shortened', () => {
		const name = `${'x'.repeat(160)}.jpg`;
		const entry = { id: 'a', date_journal: 1625133600000, timezone: 'UTC', text: 'Hi', photos: [name] };
		const plan = planImport(readArchive({ 'a.json': strToU8(JSON.stringify(entry)), [name]: new Uint8Array(3) }), DEFAULT_OPTIONS, [], false);
		expect(plan.attachments[0]!.path).toMatch(/x\.jpg$/);
	});
	it('keeps escaped tag text as text and not as a raw HTML tag', () => {
		const html = '<p>a &lt;img src=https://example.invalid/x&gt; b, 1 &lt; 2 <code>&lt;b&gt;</code></p>';
		expect(convertBody(html, 'html')).toBe('a &lt;img src=https://example.invalid/x> b, 1 < 2 `<b>`');
	});
	it('plans a large photo backup in bounded time', () => {
		const files: Record<string, Uint8Array> = {};
		for (let i = 0; i < 4000; i++) {
			files[`photos/p${i}.jpg`] = new Uint8Array(1);
			files[`e${i}.json`] = strToU8(JSON.stringify({ id: `e${i}`, date_journal: 1625133600000 + i * 60000, timezone: 'UTC', text: 'x', photos: [`p${i}.jpg`] }));
		}
		const archive = readArchive(files);
		const start = performance.now();
		const plan = planImport(archive, DEFAULT_OPTIONS, [], false);
		expect(plan.attachments).toHaveLength(4000);
		expect(performance.now() - start).toBeLessThan(20000);
	}, 60000);
	it('uses the vault case of an existing folder and daily note', () => {
		const archive = readArchive({ 'a.json': strToU8(JSON.stringify({ id: 'a', date_journal: 1625133600000, timezone: 'UTC', text: 'x', photos: ['p.jpg'] })), 'p.jpg': new Uint8Array(1) });
		const merged = planImport(archive, { ...DEFAULT_OPTIONS, folder: 'Daily', attachments: 'Daily/Files', merge: true }, ['daily', 'daily/2021-07-01.md', 'daily/files'], true);
		expect(merged.notes[0]!.path).toBe('daily/2021-07-01.md');
		expect(merged.attachments[0]!.path).toBe('daily/files/p.jpg');
		const free = planImport(archive, DEFAULT_OPTIONS, ['journey', 'journey/2021-07-01 1000.md'], false);
		expect(free.notes[0]!.path).toBe('journey/2021-07-01 1000 (2).md');
	});
	it('appends to a daily note whose folder differs in case', async () => {
		pro(true);
		const { app, plugin } = setup({ 'daily/2021-07-01.md': '# Day\n' });
		await plugin.importArchive(fixture(), { ...DEFAULT_OPTIONS, folder: 'Daily', merge: true });
		expect(await app.vault.read(app.vault.getAbstractFileByPath('daily/2021-07-01.md') as TFile)).toContain('## 12:00 Journey entry');
		expect(app.vault.getAbstractFileByPath('Daily/2021-07-01.md')).toBeNull();
	});
	it('rejects invalid ZIP bytes', () => { expect(() => readZip(strToU8('not zip'))).toThrow(); });
	it('rejects archive traversal', () => { expect(() => readZip(zipSync({ '../a.json': strToU8('{}') }))).toThrow('Unsafe ZIP path'); });
	it('rejects oversized expanded JSON before parsing', () => { expect(() => readZip(zipSync({ 'a.json': new Uint8Array(4 * 1024 * 1024 + 1) }))).toThrow('Entry JSON exceeds 4 MiB'); });
	it('is free by default and uses reference Sponsors terms', () => {
		expect(isPro()).toBe(false);
		expect(SPONSORS).toMatchObject({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' });
	});
});
