import { IMPORT_TEXT } from './copy';
import { Notice, Plugin, TFile, TFolder, normalizePath } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { DEFAULT_SETTINGS, JourneyImportSettingTab, normalizeSettings, type JourneyImportSettings } from './settings';
import { bindPro, isPro, resetPro, SPONSORS } from './pro';
import { planImport, readZip, type Archive, type ImportOptions } from './importer';
import { JourneyImportModal } from './modal';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

export default class JourneyImportPlugin extends Plugin {
	settings: JourneyImportSettings = { ...DEFAULT_SETTINGS };
	pro: SponsorsManager | null = null;
	private busy = false;
	private readonly modals = new Set<JourneyImportModal>();
	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		const tab = new JourneyImportSettingTab(this.app, this);
		this.addSettingTab(tab);
		this.register(pro.onChange(() => tab.update()));
		this.addCommand({ id: 'import-zip', name: IMPORT_TEXT.title, callback: () => this.openImport() });
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}
	onunload(): void {
		for (const modal of this.modals) modal.close();
		this.modals.clear();
		resetPro();
	}
	openImport(bytes?: Uint8Array, name?: string): JourneyImportModal {
		const modal = new JourneyImportModal(this, bytes, name);
		this.modals.add(modal);
		modal.open();
		return modal;
	}
	closeImport(modal: JourneyImportModal): void { this.modals.delete(modal); }
	async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData() as Partial<JourneyImportSettings> | null); }
	async saveSettings(): Promise<void> { await this.saveData(this.settings); }
	parseZip(bytes: Uint8Array): Archive { return readZip(bytes); }
	preview(archive: Archive, options: ImportOptions) {
		// Include folders as well as files to catch name conflicts before writing.
		return planImport(archive, options, this.app.vault.getAllLoadedFiles().map((f) => f.path), isPro());
	}
	private async ensureFolder(path: string): Promise<void> {
		if (!path) return;
		const parts = path.split('/');
		for (let i = 1; i <= parts.length; i++) {
			const folder = normalizePath(parts.slice(0, i).join('/'));
			const found = this.app.vault.getAbstractFileByPath(folder);
			if (found && !(found instanceof TFolder)) throw new Error(`Folder path is a file: ${folder}`);
			if (!found) await this.app.vault.createFolder(folder);
		}
	}
	async importArchive(archive: Archive, options: ImportOptions): Promise<{ notes: number; attachments: number; paths: string[]; warnings: string[] }> {
		if (this.busy) throw new Error('An import is in progress.');
		if (!archive.entries.length) { new Notice(IMPORT_TEXT.empty); return { notes: 0, attachments: 0, paths: [], warnings: archive.warnings }; }
		this.busy = true;
		let completed = 0;
		let copied = 0;
		try {
			const plan = this.preview(archive, options);
			// Validate note and attachment parent paths before the first write.
			for (const item of [...plan.notes, ...plan.attachments]) {
				const parts = item.path.split('/');
				for (let i = 1; i < parts.length; i++) {
					const found = this.app.vault.getAbstractFileByPath(parts.slice(0, i).join('/'));
					if (found && !(found instanceof TFolder)) throw new Error(`Folder path is a file: ${found.path}`);
				}
				if ('merge' in item && item.merge) {
					const found = this.app.vault.getAbstractFileByPath(item.path);
					if (found && !(found instanceof TFile)) throw new Error(`Daily note path is a folder: ${item.path}`);
				}
			}
			for (const photo of plan.attachments) {
				await this.ensureFolder(photo.path.split('/').slice(0, -1).join('/'));
				const bytes = archive.files[photo.source]!;
				await this.app.vault.createBinary(photo.path, bytes.slice().buffer);
				copied++;
			}
			for (const note of plan.notes) {
				await this.ensureFolder(note.path.split('/').slice(0, -1).join('/'));
				const found = this.app.vault.getAbstractFileByPath(note.path);
				if (note.merge && found instanceof TFile) await this.app.vault.process(found, (text) => `${text.trimEnd()}${note.section}`);
				else await this.app.vault.create(note.path, note.merge ? `# ${note.path.split('/').pop()!.replace(/\.md$/, '')}${note.section}` : note.content);
				completed++;
			}
			new Notice(`Imported ${completed} entries and ${copied} photos.`);
			return { notes: completed, attachments: copied, paths: plan.notes.map((n) => n.path), warnings: plan.warnings };
		} catch (error) {
			throw new Error(`Import stopped after ${completed} entries and ${copied} photos. ${error instanceof Error ? error.message : String(error)}`);
		} finally { this.busy = false; }
	}
}
