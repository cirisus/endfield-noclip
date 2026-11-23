import { checkedEnum, enumGuard, viewOf } from './binary.ts';
import { BlobCodec, BlobKind } from './blobs.ts';
import { checkStride, decodeContainer, encodeContainer, fourcc, requireSection } from './container.ts';

/** a blob's storage */
export interface BlobRecord {
	kind: BlobKind;
	codec: BlobCodec;
	/** index into {@link PackageManifest.archives} */
	archive: number;
	/**
	 * byte offset of the member from its archive's data section ({@link ArchiveInfo.dataOffset}, or for the
	 * core the position of its first member), so a reader can range-read a blob without its archive's JSON
	 * header
	 */
	offset: number;
	/** stored byte length */
	length: number;
	/** byte length after undoing the codec */
	rawLength: number;
}

const MAGIC = fourcc('EFBX');
const MAJOR_VERSION = 2;
const TAG_BLBS = fourcc('BLBS');
const KNOWN_TAGS = new Set([TAG_BLBS]);

const BLOB_SIZE = 16;

const isBlobCodec = enumGuard(BlobCodec);
const isBlobKind = enumGuard(BlobKind);

/**
 * encodes `tables/blobs.bin` as an `EFBX` v2 TLV container
 *
 * @param blobs records in index order
 * @returns the encoded table
 * @throws {RangeError} if an offset or length exceeds 32 bits, or an archive index 16 bits
 */
export const encodeBlobTable = (blobs: readonly BlobRecord[]): Uint8Array => {
	const buf = new Uint8Array(blobs.length * BLOB_SIZE);
	const view = viewOf(buf);
	let at = 0;
	for (const [index, blob] of blobs.entries()) {
		if (blob.offset > 0xff_ff_ff_ff || blob.length > 0xff_ff_ff_ff || blob.rawLength > 0xff_ff_ff_ff) {
			throw new RangeError(`blob ${index} doesn't fit 32-bit offsets; archives must stay below 4 GiB`);
		}
		if (blob.archive > 0xff_ff) {
			throw new RangeError(`blob ${index} is in archive ${blob.archive}, past what 16 bits index`);
		}
		view.setUint8(at, blob.kind);
		view.setUint8(at + 1, blob.codec);
		view.setUint16(at + 2, blob.archive, true);
		view.setUint32(at + 4, blob.offset, true);
		view.setUint32(at + 8, blob.length, true);
		view.setUint32(at + 12, blob.rawLength, true);
		at += BLOB_SIZE;
	}
	return encodeContainer({
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [{ tag: TAG_BLBS, required: true, data: buf, count: blobs.length, stride: BLOB_SIZE }],
	});
};

/**
 * decodes `tables/blobs.bin` (`EFBX` v2 TLV container)
 *
 * @param data tables/blobs.bin
 * @returns the blob records
 * @throws {PackageFormatError} on a bad header, length, kind or codec
 */
export const decodeBlobTable = (data: Uint8Array): BlobRecord[] => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'blob table',
	});
	const sec = requireSection(container, TAG_BLBS, 'blob table');
	checkStride(sec, BLOB_SIZE, 'BLBS');
	const view = viewOf(sec.data);
	const blobs: BlobRecord[] = [];
	for (let i = 0; i < sec.count; i++) {
		const at = i * sec.stride;
		blobs.push({
			kind: checkedEnum(isBlobKind, view.getUint8(at), 'blob kind'),
			codec: checkedEnum(isBlobCodec, view.getUint8(at + 1), 'blob codec'),
			archive: view.getUint16(at + 2, true),
			offset: view.getUint32(at + 4, true),
			length: view.getUint32(at + 8, true),
			rawLength: view.getUint32(at + 12, true),
		});
	}
	return blobs;
};
