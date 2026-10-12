import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { strToU8 } from 'fflate';
import vectors from './vectors/journey-import.json';
import { DEFAULT_OPTIONS, planImport, readArchive, readZip, type ImportOptions } from '../src/importer';

describe('golden Journey cases', () => {
	for (const c of vectors.cases) it(c.name, () => {
		const [input, overrides, existing, pro] = c.args as [string | Record<string, unknown>, Partial<ImportOptions>, string[], boolean];
		const expected = c.expected as Record<string, unknown>;
		const archive = typeof input === 'string' ? readZip(new Uint8Array(readFileSync(`tests/fixtures/${input}`))) : readArchive(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, strToU8(typeof v === 'string' ? v : JSON.stringify(v))])));
		if (expected.error) {
			expect(() => planImport(archive, { ...DEFAULT_OPTIONS, ...overrides }, existing, pro)).toThrow(String(expected.error));
			return;
		}
		const plan = planImport(archive, { ...DEFAULT_OPTIONS, ...overrides }, existing, pro);
		if (expected.paths) expect(plan.notes.map((n) => n.path)).toEqual(expected.paths);
		if (expected.properties) (expected.properties as Record<string, unknown>[]).forEach((p, i) => expect(archive.entries[i]!.properties).toMatchObject(p));
		if (expected.absentProperties) for (const p of expected.absentProperties as string[]) expect(archive.entries[0]!.properties).not.toHaveProperty(p);
		if (expected.bodies) expect(archive.entries.map((e) => e.body)).toEqual(expected.bodies);
		if (expected.bodyIncludes) (expected.bodyIncludes as string[]).forEach((text) => expect(plan.notes[0]!.content).toContain(text));
		if (expected.attachments) expect(plan.attachments.map((a) => a.path)).toEqual(expected.attachments);
		if ('attachmentCount' in expected) expect(plan.attachments).toHaveLength(expected.attachmentCount as number);
		if (expected.warnings) expect(plan.warnings).toEqual(expected.warnings);
		if (expected.merge) expect(plan.notes.map((n) => n.merge)).toEqual(expected.merge);
	});
});
