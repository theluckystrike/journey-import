import { IMPORT_TEXT } from './copy';
import { Modal, Notice, Setting } from 'obsidian';
import type JourneyImportPlugin from './main';
import { DEFAULT_OPTIONS, type Archive, type ImportOptions } from './importer';
import { PRO_GROUP, PRO_MERGE, PRO_PATTERN, isPro, onProChange, proNotice } from './pro';

export class JourneyImportModal extends Modal {
	private archive: Archive | null = null;
	private options: ImportOptions;
	private name: string;
	private stop: (() => void) | null = null;
	private writing = false;
	private message = '';
	/** True after a free user typed in the pattern field and saw the Pro notice, so the notice shows once for each window. */
	private patternNoticeShown = false;
	constructor(private plugin: JourneyImportPlugin, bytes?: Uint8Array, name = '') {
		super(plugin.app);
		this.options = { ...plugin.settings };
		this.name = name;
		if (bytes) this.archive = plugin.parseZip(bytes);
	}
	onOpen(): void {
		this.setTitle(IMPORT_TEXT.title);
		this.modalEl.addClass('journey-import-modal');
		this.stop = onProChange(() => { if (!this.writing) this.draw(); });
		this.draw();
	}
	onClose(): void { this.stop?.(); this.contentEl.empty(); this.plugin.closeImport(this); }
	private draw(): void {
		const el = this.contentEl;
		el.empty();
		el.createEl('p', { text: IMPORT_TEXT.description });
		const picker = el.createEl('input', { type: 'file', attr: { accept: '.zip,application/zip', 'aria-label': IMPORT_TEXT.fileLabel } });
		picker.disabled = this.writing;
		picker.addEventListener('change', () => {
			const file = picker.files?.[0];
			if (!file) return;
			if (file.size > 128 * 1024 * 1024) { new Notice(IMPORT_TEXT.tooLarge); return; }
			void file.arrayBuffer().then((bytes) => {
				this.archive = this.plugin.parseZip(new Uint8Array(bytes));
				this.name = file.name;
				this.message = '';
				if (!this.archive.entries.length) new Notice(IMPORT_TEXT.empty);
				this.draw();
			}).catch((error: unknown) => { this.archive = null; this.message = error instanceof Error ? error.message : String(error); this.draw(); });
		});
		new Setting(el).setName('Note folder').addText((c) => c.setValue(this.options.folder).onChange((v) => { this.options.folder = v; this.updatePreview(); }));
		new Setting(el).setName('Attachments folder').addText((c) => c.setValue(this.options.attachments).onChange((v) => { this.options.attachments = v; this.updatePreview(); }));
		// The Pro options stay enabled for a free user: a change shows what Pro adds and how to get it, and puts the control back.
		new Setting(el).setName(IMPORT_TEXT.merge).addToggle((c) => c.setValue(isPro() && this.options.merge).onChange((v) => {
			if (!isPro()) { if (v) { proNotice(PRO_MERGE); c.setValue(false); } return; }
			this.options.merge = v; this.updatePreview();
		}));
		new Setting(el).setName(IMPORT_TEXT.group).addToggle((c) => c.setValue(isPro() && this.options.group).onChange((v) => {
			if (!isPro()) { if (v) { proNotice(PRO_GROUP); c.setValue(false); } return; }
			this.options.group = v; this.updatePreview();
		}));
		new Setting(el).setName(IMPORT_TEXT.pattern).addText((c) => c.setValue(isPro() ? this.options.pattern : DEFAULT_OPTIONS.pattern).onChange((v) => {
			if (!isPro()) {
				if (v !== DEFAULT_OPTIONS.pattern && !this.patternNoticeShown) { this.patternNoticeShown = true; proNotice(PRO_PATTERN); }
				c.setValue(DEFAULT_OPTIONS.pattern);
				return;
			}
			this.options.pattern = v; this.updatePreview();
		}));
		el.createDiv({ cls: 'journey-preview', attr: { 'aria-live': 'polite' } });
		new Setting(el).addButton((b) => b.setButtonText('Import entries').setCta().setDisabled(this.writing || !this.archive?.entries.length).onClick(async () => {
			if (!this.archive || this.writing) return;
			this.writing = true;
			b.setDisabled(true);
			try {
				const result = await this.plugin.importArchive(this.archive, { ...this.options });
				this.archive = null;
				this.message = `Imported ${result.notes} entries and ${result.attachments} photos. Open the note folder to review them.`;
			} catch (error) { this.message = error instanceof Error ? error.message : String(error); new Notice(this.message); }
			finally { this.writing = false; this.draw(); }
		}));
		this.updatePreview();
	}
	private updatePreview(): void {
		const el = this.contentEl.querySelector<HTMLElement>('.journey-preview');
		if (!el) return;
		el.empty();
		if (this.message) el.createEl('p', { text: this.message });
		if (!this.archive) return;
		try {
			const plan = this.plugin.preview(this.archive, this.options);
			el.createEl('p', { cls: 'journey-counts', text: `${this.name}: ${plan.notes.length} entries · ${plan.attachments.length} photos · ${plan.warnings.length} warnings` });
			if (!plan.notes.length) el.createEl('p', { text: IMPORT_TEXT.empty });
			const list = el.createEl('ul');
			for (const note of plan.notes.slice(0, 8)) list.createEl('li', { text: `${note.merge ? 'Append: ' : 'Create: '}${note.path}` });
			if (plan.notes.length > 8) el.createEl('p', { text: `${plan.notes.length - 8} more entries.` });
			for (const warning of plan.warnings.slice(0, 5)) el.createEl('p', { cls: 'journey-warning', text: warning });
		} catch (error) { el.createEl('p', { cls: 'journey-warning', text: error instanceof Error ? error.message : String(error) }); }
	}
}
