/**
 * `tables/geometries.bin.zst`, the geometry table: one zstd frame around an `EFGE` v2 TLV container. its own
 * module, outside the asset modules the pack cache fingerprints, so a layout change leaves cached conversions
 * valid
 *
 * @module
 */

import { viewOf } from './binary.ts';
import { checkStride, decodeContainer, encodeContainer, fourcc, requireSection } from './container.ts';
import { EntryStatus, entryStatusCode, entryStatusName } from './entry-status.ts';
import { PackageFormatError } from './errors.ts';
import type { GeometryEntry } from './geometry.ts';

/** the decoded geometry table; a geometry's id is its index */
export interface GeometryTable {
	/** entries in the table; ids run `0…count - 1` */
	readonly count: number;
	/**
	 * @param id geometry id
	 * @returns the ready geometry's {@link BlobKind.Geometry} blob, or `null` when it isn't ready or isn't in
	 *   the table
	 */
	blob(id: number): number | null;
	/**
	 * @param id geometry id
	 * @returns the entry, decoded anew on each call
	 * @throws {RangeError} when `id` isn't in the table
	 */
	entry(id: number): GeometryEntry;
}

const MAGIC = fourcc('EFGE');
const MAJOR_VERSION = 2;
const TAG_GEOM = fourcc('GEOM');
const KNOWN_TAGS = new Set([TAG_GEOM]);

const GEOMETRY_RECORD_SIZE = 44;
const NO_TANGENT_UV = 0xff;
const NO_BLOB = 0xff_ff_ff_ff;

/**
 * encodes the geometry table as an `EFGE` v2 TLV container (before its zstd frame). an unconverted entry's
 * fields past its status are 0
 *
 * @param entries entries in id order
 * @returns the encoded table
 * @throws {RangeError} if a field doesn't fit its record, or an animation has no frames
 */
export const encodeGeometryTable = (entries: readonly GeometryEntry[]): Uint8Array => {
	const buf = new Uint8Array(entries.length * GEOMETRY_RECORD_SIZE);
	const view = viewOf(buf);
	for (const [id, entry] of entries.entries()) {
		const at = id * GEOMETRY_RECORD_SIZE;
		view.setUint8(at, entryStatusCode(entry.status));
		if (entry.status !== 'ready') {
			continue;
		}
		const { tangentUv, animationFrames } = entry;
		if (
			(tangentUv !== null && (tangentUv < 0 || tangentUv >= NO_TANGENT_UV)) ||
			entry.attributes > 0xff_ff ||
			entry.submeshCount > 0xff_ff ||
			(animationFrames !== null && (animationFrames < 1 || animationFrames > 0xff_ff))
		) {
			throw new RangeError(`geometry ${id} has a field out of its record's range`);
		}
		view.setUint8(at + 1, tangentUv ?? NO_TANGENT_UV);
		view.setUint16(at + 2, entry.attributes, true);
		view.setUint32(at + 4, entry.blob, true);
		view.setUint32(at + 8, entry.vertexCount, true);
		view.setUint32(at + 12, entry.indexCount, true);
		view.setUint16(at + 16, entry.submeshCount, true);
		view.setUint16(at + 18, animationFrames ?? 0, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 20 + i * 4, entry.bounds.min[i], true);
			view.setFloat32(at + 32 + i * 4, entry.bounds.max[i], true);
		}
	}
	return encodeContainer({
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_GEOM, required: true, data: buf, count: entries.length, stride: GEOMETRY_RECORD_SIZE },
		],
	});
};

/**
 * checks every record's status once, so the table's accessors never throw on content
 *
 * @param data the geometry table, inflated
 * @returns the table, reading records in place
 * @throws {PackageFormatError} on a bad header, length or status
 */
export const decodeGeometryTable = (data: Uint8Array): GeometryTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'geometry table',
	});
	const sec = requireSection(container, TAG_GEOM, 'geometry table');
	checkStride(sec, GEOMETRY_RECORD_SIZE, 'GEOM');
	const { count, stride } = sec;
	const view = viewOf(sec.data);
	const blobs = new Uint32Array(count);
	for (let id = 0; id < count; id++) {
		const at = id * stride;
		const status = view.getUint8(at);
		if (status > EntryStatus.Failed) {
			throw new PackageFormatError(`geometry ${id} has unknown status ${status}`);
		}
		blobs[id] = status === EntryStatus.Ready ? view.getUint32(at + 4, true) : NO_BLOB;
	}
	return {
		count,
		blob(id) {
			const blob = blobs[id];
			return blob === undefined || blob === NO_BLOB ? null : blob;
		},
		entry(id) {
			if (!(id >= 0 && id < count)) {
				throw new RangeError(`geometry ${id} isn't in the table`);
			}
			const at = id * stride;
			const status = entryStatusName(view.getUint8(at), `geometry ${id}`);
			if (status !== 'ready') {
				return { status };
			}
			const f = (offset: number): number => view.getFloat32(at + offset, true);
			const tangentUv = view.getUint8(at + 1);
			const animationFrames = view.getUint16(at + 18, true);
			return {
				status,
				blob: view.getUint32(at + 4, true),
				bounds: { min: [f(20), f(24), f(28)], max: [f(32), f(36), f(40)] },
				vertexCount: view.getUint32(at + 8, true),
				indexCount: view.getUint32(at + 12, true),
				submeshCount: view.getUint16(at + 16, true),
				attributes: view.getUint16(at + 2, true),
				tangentUv: tangentUv === NO_TANGENT_UV ? null : tangentUv,
				animationFrames: animationFrames === 0 ? null : animationFrames,
			};
		},
	};
};
