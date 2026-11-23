import { decodeContainer, encodeContainer, fourcc, requireSection, sectionU32 } from './container.ts';
import { PackageFormatError } from './errors.ts';

/** world metres covered by one irradiance archive along x and z */
export const IRRADIANCE_ARCHIVE_SIZE = 512;

/**
 * @param x world x (m) of a point in the archive's square
 * @param z world z (m)
 * @returns the stem (see `archiveName`) of the irradiance archive holding the cells over that point
 */
export const irradianceStem = (x: number, z: number): string =>
	`irradiance/${Math.floor(x / IRRADIANCE_ARCHIVE_SIZE)}_${Math.floor(z / IRRADIANCE_ARCHIVE_SIZE)}`;

/**
 * `tables/irradiance.bin`: the baked irradiance volume's cells, each a {@link BlobKind.Irradiance} blob: the
 * base bake's, and the scene-state bakes' copies of some of them. cell keys are the game's layout: `x | y <<
 * 8 | z << 16 | level << 24`, 8 bits per axis in 32 m units with 128 at world 0 for every scene (smaller
 * volumes' keys are shifted to it); a level-`n` cell spans `32 · 2^n` m (probes every `0.5 · 4^n` m) and its
 * coordinates are multiples of `2^n`.
 *
 * a key can repeat, once per bake that holds the cell. a viewer uses the first of a key's entries whose
 * visibility group shows: scene-state bakes come first, most states first, and the base bake last, in a group
 * that always shows
 */
export interface IrradianceTable {
	/** cell keys, ascending, repeated for each bake of the cell */
	keys: Uint32Array;
	/** blob index of each entry */
	blobs: Uint32Array;
	/** index into `StatesInfo.groups` of each entry: while it shows, the entry's bake applies */
	groups: Uint32Array;
}

/**
 * a room's own bake, which replaces the scene's finest probes inside its box while its group shows (Dijiang's
 * cabins, baked with the cabin built). its blob is a {@link BlobKind.Irradiance} blob of `size` 16-byte probes
 * laid out like a cell's, x fastest, then y, then z
 */
export interface IrradianceRegionInfo {
	/** the bake's name in the game's files, e.g. `regionIv_room_b_1_2` */
	name: string;
	/** index into `StatesInfo.groups`: the owning level and the conditions under which the bake applies */
	group: number;
	/** the first probe's position in 0.5 m probe units with world 0 at 0: probe `i` is at `(origin + i) · 0.5` m */
	origin: [x: number, y: number, z: number];
	/** probes per axis */
	size: [x: number, y: number, z: number];
	blob: number;
}

const MAGIC = fourcc('EFIV');
const MAJOR_VERSION = 2;
const TAG_KEYS = fourcc('KEYS');
const TAG_BLBS = fourcc('BLBS');
const TAG_GRPS = fourcc('GRPS');
const KNOWN_TAGS = new Set([TAG_KEYS, TAG_BLBS, TAG_GRPS]);

/**
 * encodes `tables/irradiance.bin` as an `EFIV` v2 TLV container
 *
 * @param table the cells
 * @returns the encoded table
 * @throws {RangeError} if the lists differ in length or the keys descend
 */
export const encodeIrradianceTable = (table: IrradianceTable): Uint8Array => {
	const count = table.keys.length;
	if (table.blobs.length !== count || table.groups.length !== count) {
		throw new RangeError('irradiance table: keys, blobs and groups differ in length');
	}
	for (let i = 1; i < count; i++) {
		if (table.keys[i] < table.keys[i - 1]) {
			throw new RangeError('irradiance table: keys must be ascending');
		}
	}
	const bytesOf = (a: Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	return encodeContainer({
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_KEYS, required: true, data: bytesOf(table.keys), count, stride: 4 },
			{ tag: TAG_BLBS, required: true, data: bytesOf(table.blobs), count, stride: 4 },
			{ tag: TAG_GRPS, required: true, data: bytesOf(table.groups), count, stride: 4 },
		],
	});
};

/**
 * decodes `tables/irradiance.bin` (`EFIV` v2 TLV container)
 *
 * @param data tables/irradiance.bin
 * @returns the cells
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeIrradianceTable = (data: Uint8Array): IrradianceTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'irradiance table',
	});
	const keysSec = requireSection(container, TAG_KEYS, 'irradiance table');
	const blobsSec = requireSection(container, TAG_BLBS, 'irradiance table');
	const groupsSec = requireSection(container, TAG_GRPS, 'irradiance table');
	const keys = sectionU32(keysSec);
	const blobs = sectionU32(blobsSec);
	const groups = sectionU32(groupsSec);
	if (keys.length !== blobs.length || keys.length !== groups.length) {
		throw new PackageFormatError('irradiance table sections differ in length');
	}
	return { keys, blobs, groups };
};
