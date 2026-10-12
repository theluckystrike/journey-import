import { IMPORT_TEXT } from './copy';
import { htmlToMarkdown, normalizePath, stringifyYaml } from 'obsidian';
import { strFromU8, unzipSync } from 'fflate';

export interface ImportOptions {
	folder: string;
	attachments: string;
	merge: boolean;
	group: boolean;
	pattern: string;
}
export const DEFAULT_OPTIONS: ImportOptions = { folder: 'Journey', attachments: 'Journey/attachments', merge: false, group: false, pattern: '{date} {time}' };
export interface JourneyEntry {
	id: string;
	date: string;
	day: string;
	time: string;
	properties: Record<string, unknown>;
	body: string;
	photos: string[];
}
export interface Archive {
	entries: JourneyEntry[];
	files: Record<string, Uint8Array>;
	warnings: string[];
}
export interface ImportPlan {
	notes: { path: string; content: string; section: string; merge: boolean }[];
	attachments: { path: string; source: string }[];
	warnings: string[];
}
const MAX_ZIP = 128 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const PHOTO = /\.(?:jpe?g|png|gif|webp|heic)$/i;
const TAG = /<\/?[a-z][a-z0-9-]*(?=[\s/>])[^>]*>/gi;
const record = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;

export function safeFolder(value: string): string {
	value = value.trim();
	if (value.includes('\\') || value.startsWith('/') || Array.from(value).some((c) => c.charCodeAt(0) < 32) || /[:*?"<>|#^[\]]/.test(value)) throw new Error('Use a vault folder without reserved characters.');
	const parts = value.split('/');
	if (parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Use a vault folder without dot segments.');
	return normalizePath(value.trim());
}
export function safeName(value: string): string {
	let name = Array.from(value.normalize('NFC')).map((c) => c.charCodeAt(0) < 32 ? ' ' : c).join('').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 150);
	if (!name) name = 'Journey entry';
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
	return name;
}
const join = (folder: string, name: string) => normalizePath(folder ? `${folder}/${name}` : name);
/** Use the case of an existing parent folder. Case-insensitive file systems see one path. */
function vaultCase(path: string, known: Map<string, string>): string {
	const parts = path.split('/');
	for (let i = parts.length - 1; i > 0; i--) {
		const found = known.get(parts.slice(0, i).join('/').toLowerCase());
		if (found) return [found, ...parts.slice(i)].join('/');
	}
	return path;
}

/** Intl supplies the historical offset for the IANA timezone in the entry. */
export function entryDate(timestamp: number, timezone: string): { date: string; day: string; time: string } {
	const instant = new Date(timestamp);
	if (!Number.isFinite(timestamp) || Number.isNaN(instant.getTime()) || instant.getUTCFullYear() < 1900 || instant.getUTCFullYear() > 9999) throw new Error('Invalid entry date.');
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
	const get = (key: string) => parts.find((p) => p.type === key)!.value;
	const day = `${get('year')}-${get('month')}-${get('day')}`;
	const time = `${get('hour')}${get('minute')}`;
	const wall = `${day}T${get('hour')}:${get('minute')}:${get('second')}`;
	const offset = Math.round((Date.parse(`${wall}Z`) - Math.floor(timestamp / 1000) * 1000) / 60000);
	const abs = Math.abs(offset);
	const zone = `${offset >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
	return { date: `${wall}${zone}`, day, time };
}

/** Strip resource tags and attributes before DOMParser can construct them. */
export function textHtml(text: string): string {
	const allowed = new Set('p div span strong b em i u s del br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code a table thead tbody tr th td'.split(' '));
	const clean = text.replace(/<(script|style|iframe|object|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
	return clean.replace(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi, (tag: string, closing: string, rawName: string) => {
		const name = rawName.toLowerCase();
		if (!allowed.has(name)) return '';
		if (closing) return `</${name}>`;
		if (name !== 'a') return `<${name}>`;
		const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
		if (/^\s*(?:javascript|data|vbscript):/i.test(href)) return '<a>';
		const escaped = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		return `<a href="${escaped}">`;
	});
}

/** Remove active HTML and images. Photos come only from the archive attachment list. */
export function convertBody(text: string, type: string): string {
	if (type === 'markdown') {
		// Remove tags only. Autolinks such as <https://example.com> and text such as 1 < 2 > 0 stay.
		return text.replace(/<(script|style|iframe|object|video|audio)[\s\S]*?<\/\1\s*>/gi, '')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(TAG, '')
			.replace(/!\[[^\]]*\]\([^\n]*?\)/g, '')
			.replace(/!\[[^\]]*\](?:\[[^\]]*\])?/g, '').trim();
	}
	// Text without tags is plain text. HTML parsing would join its lines.
	if (!new RegExp(TAG.source, 'i').test(text)) return convertBody(text, 'markdown');
	const doc = new DOMParser().parseFromString(textHtml(text), 'text/html');
	doc.querySelectorAll('script,style,iframe,object,embed,img,video,audio,source,link,meta').forEach((el) => el.remove());
	// htmlToMarkdown writes text such as &lt;img&gt; as a raw tag. Mark it outside code, then write it as &lt;.
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.parentElement?.closest('pre,code')) node.nodeValue = (node.nodeValue ?? '').replace(/\uE000/g, '').replace(/<(?=[a-z/!?])/gi, '\uE000');
	}
	return htmlToMarkdown(doc.body).replace(/\uE000/g, '&lt;').trim().replace(/(^|[\s*])_([^\n]+?)_(?=$|[\s*.,!?])/g, '$1*$2*');
}

export function parseEntry(value: unknown, source: string, warnings: string[]): JourneyEntry | null {
	const raw = record(value);
	if (!raw || typeof raw.date_journal !== 'number' || typeof raw.text !== 'string') return null;
	let timezone = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'UTC';
	let stamp: ReturnType<typeof entryDate>;
	try { stamp = entryDate(raw.date_journal, timezone); }
	catch {
		try { stamp = entryDate(raw.date_journal, 'UTC'); }
		catch { warnings.push(`Skipped ${source}: invalid date.`); return null; }
		warnings.push(`${source}: unknown timezone; used UTC.`);
		timezone = 'UTC';
	}
	const id = typeof raw.id === 'string' && raw.id ? raw.id : source.replace(/\.json$/i, '');
	const properties: Record<string, unknown> = { date: stamp.date, timezone, journey_id: id };
	if (Array.isArray(raw.tags)) properties.tags = raw.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.replace(/^#/, '').trim());
	if (typeof raw.mood === 'number' && Number.isFinite(raw.mood) && Math.abs(raw.mood) <= 100) properties.mood = raw.mood;
	if (typeof raw.lat === 'number' && typeof raw.lon === 'number' && Number.isFinite(raw.lat) && Number.isFinite(raw.lon) && Math.abs(raw.lat) <= 90 && Math.abs(raw.lon) <= 180) {
		properties.location = [raw.lat, raw.lon];
		if (typeof raw.address === 'string' && raw.address.trim()) properties.address = raw.address.trim();
	}
	const weather = record(raw.weather);
	if (weather && typeof weather.description === 'string' && weather.description.trim()) {
		const degree = weather.degree_c;
		properties.weather = `${weather.description.trim()}${typeof degree === 'number' && Number.isFinite(degree) && Math.abs(degree) <= 150 ? `, ${degree} °C` : ''}`;
	}
	const photos = Array.isArray(raw.photos) ? raw.photos.filter((p): p is string => typeof p === 'string') : [];
	const type = raw.type === 'markdown' ? 'markdown' : 'html';
	return { id, ...stamp, properties, body: convertBody(raw.text, type), photos };
}

export function readZip(bytes: Uint8Array): Archive {
	if (bytes.length > MAX_ZIP) throw new Error(IMPORT_TEXT.tooLarge);
	let total = 0;
	let count = 0;
	const files = unzipSync(bytes, { filter: (file) => {
		if (++count > 10000) throw new Error('ZIP exceeds 10000 files.');
		if (!/\.json$/i.test(file.name) && !PHOTO.test(file.name)) return false;
		if (file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').some((p) => p === '..' || p === '.')) throw new Error('Unsafe ZIP path.');
		// A ZIP made again in macOS Finder adds __MACOSX/._name files. Skip them and other hidden files.
		if (file.name.split('/').some((p) => p.startsWith('.') || p === '__MACOSX')) return false;
		total += file.originalSize;
		if (total > MAX_EXPANDED) throw new Error('ZIP expands beyond 256 MiB.');
		if (/\.json$/i.test(file.name) && file.originalSize > 4 * 1024 * 1024) throw new Error('Entry JSON exceeds 4 MiB.');
		return true;
	} });
	return readArchive(files);
}

export function readArchive(files: Record<string, Uint8Array>): Archive {
	const warnings: string[] = [];
	const entries: JourneyEntry[] = [];
	for (const name of Object.keys(files).sort()) {
		if (!/\.json$/i.test(name)) continue;
		try {
			const parsed = parseEntry(JSON.parse(strFromU8(files[name]!)) as unknown, name, warnings);
			if (parsed) entries.push(parsed);
		} catch { warnings.push(`Skipped ${name}: invalid JSON or entry text.`); }
	}
	entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	return { entries, files, warnings };
}

function freePath(path: string, taken: Set<string>): string {
	const dot = path.lastIndexOf('.');
	const base = path.slice(0, dot);
	const ext = path.slice(dot);
	let candidate = path;
	for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}
export function planImport(archive: Archive, options: ImportOptions, existing: string[], pro: boolean): ImportPlan {
	const folder = safeFolder(options.folder);
	const attachmentsFolder = safeFolder(options.attachments);
	const merge = pro && options.merge;
	const group = pro && options.group;
	const pattern = pro ? options.pattern : DEFAULT_OPTIONS.pattern;
	if (pro && !merge && (!pattern.trim() || /\{(?!date\}|time\}|id\})[^}]*\}/.test(pattern))) throw new Error('Use {date}, {time} and {id} in the file name pattern.');
	const taken = new Set(existing.map((p) => p.toLowerCase()));
	const known = new Map(existing.map((p) => [p.toLowerCase(), p]));
	// Index archive photos by basename once. A scan for each photo is slow for a large backup.
	const byName = new Map<string, string[]>();
	for (const p of Object.keys(archive.files)) {
		if (!PHOTO.test(p)) continue;
		const file = p.split('/').pop()!;
		byName.set(file, [...(byName.get(file) ?? []), p]);
	}
	const warnings = [...archive.warnings];
	const attachments: ImportPlan['attachments'] = [];
	const resolvedPhotos = new Map<string, string>();
	const notes: ImportPlan['notes'] = [];
	for (const entry of archive.entries) {
		const embeds: string[] = [];
		for (const photo of entry.photos) {
			const direct = archive.files[photo] ? photo : undefined;
			const matches = byName.get(photo.split('/').pop()!) ?? [];
			const source = direct ?? (matches.length === 1 ? matches[0] : undefined);
			if (!source || !PHOTO.test(source)) { warnings.push(`${entry.id}: missing or ambiguous photo ${photo}.`); continue; }
			let path = resolvedPhotos.get(source);
			if (!path) {
				// Keep the extension when safeName shortens a long photo name.
				const file = source.split('/').pop()!;
				const ext = PHOTO.exec(file)![0];
				path = freePath(vaultCase(join(attachmentsFolder, `${safeName(file.slice(0, -ext.length))}${ext}`), known), taken);
				resolvedPhotos.set(source, path);
				attachments.push({ path, source });
			}
			embeds.push(`![[${path}]]`);
		}
		const body = [entry.body, ...embeds].filter(Boolean).join('\n\n');
		const content = `---\n${stringifyYaml(entry.properties).trimEnd()}\n---\n\n${body}\n`;
		const dir = group ? join(folder, `${entry.day.slice(0, 4)}/${entry.day.slice(5, 7)}`) : folder;
		const name = merge ? entry.day : safeName(pattern.replace(/\{(date|time|id)\}/g, (_, token: string) => token === 'date' ? entry.day : token === 'time' ? entry.time : entry.id));
		const base = vaultCase(join(dir, `${name}.md`), known);
		const path = merge ? known.get(base.toLowerCase()) ?? base : freePath(base, taken);
		// A daily section preserves entry properties without changing existing daily frontmatter.
		const section = `\n\n## ${entry.time.slice(0, 2)}:${entry.time.slice(2)} Journey entry\n\n\`\`\`yaml\n${stringifyYaml(entry.properties).trimEnd()}\n\`\`\`\n\n${body}\n`;
		notes.push({ path, content, section, merge });
	}
	return { notes, attachments, warnings };
}
