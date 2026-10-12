import { IMPORT_TEXT } from './copy';
import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { DEFAULT_OPTIONS, type ImportOptions } from './importer';
import { PRO_UI } from './pro';
import type JourneyImportPlugin from './main';

export type JourneyImportSettings = ImportOptions;
export const DEFAULT_SETTINGS = DEFAULT_OPTIONS;
export function normalizeSettings(saved: Partial<JourneyImportSettings> | null | undefined): JourneyImportSettings {
	const s = saved ?? {};
	return {
		folder: typeof s.folder === 'string' ? s.folder : DEFAULT_SETTINGS.folder,
		attachments: typeof s.attachments === 'string' ? s.attachments : DEFAULT_SETTINGS.attachments,
		pattern: typeof s.pattern === 'string' ? s.pattern : DEFAULT_SETTINGS.pattern,
		merge: s.merge === true,
		group: s.group === true,
	};
}
export class JourneyImportSettingTab extends PluginSettingTab {
	declare plugin: JourneyImportPlugin;
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Note folder', desc: 'Vault folder for imported notes.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder } },
			{ name: 'Attachments folder', desc: 'Vault folder for copied photos.', control: { type: 'text', key: 'attachments', defaultValue: DEFAULT_SETTINGS.attachments } },
			{ name: IMPORT_TEXT.merge, desc: 'Append entries to YYYY-MM-DD.md in the note folder. Existing frontmatter stays in place.', control: { type: 'toggle', key: 'merge', defaultValue: false } },
			{ name: IMPORT_TEXT.group, desc: 'Put notes under YYYY/MM within the note folder.', control: { type: 'toggle', key: 'group', defaultValue: false } },
			{ name: IMPORT_TEXT.pattern, desc: 'Use {date}, {time} and {id}. Merge by date uses the date instead.', control: { type: 'text', key: 'pattern', defaultValue: DEFAULT_SETTINGS.pattern } },
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}
}
