/**
 * `tables/luts.bin.zst` (`EFLU` TLV container): baked 1D curve LUTs, 1D linear-RGBA gradient LUTs, and binary
 * particle shape meshes with precomputed triangle/edge area CDFs
 *
 * @module
 */

import { viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	sectionF32,
	sectionU16,
	sectionU32,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';

/** one baked 1D curve LUT (unorm16 samples mapped to `[minVal, maxVal]`) */
export interface CurveLut {
	minVal: number;
	maxVal: number;
	flags: number;
	samples: Uint16Array;
}

/** gradient LUT sample storage format */
export const GradientLutFormat = {
	/** 4 bytes per sample: linear RGBA8 */
	Rgba8: 0,
	/** 16 bytes per sample: linear f32 RGBA (for HDR gradients) */
	Rgba32f: 1,
} as const;

export type GradientLutFormat = (typeof GradientLutFormat)[keyof typeof GradientLutFormat];

/** one baked 1D linear-RGBA gradient LUT */
export interface GradientLut {
	format: GradientLutFormat;
	sampleCount: number;
	/** packed linear RGBA bytes (`sampleCount × 4` for Rgba8, `sampleCount × 16` for Rgba32f) */
	samples: Uint8Array;
}

/** one binary particle emitter shape mesh with precomputed cumulative area weights */
export interface ParticleShapeMeshLut {
	/** 2 = edges, 3 = triangles */
	primSize: 2 | 3;
	hasColor: boolean;
	/** `vertexCount × 3` f32 positions */
	positions: Float32Array;
	/** `vertexCount × 3` f32 unit normals */
	normals: Float32Array;
	/** `vertexCount × 4` linear RGBA8 colors when `hasColor`, else `null` */
	colors: Uint8Array | null;
	/** `primCount × primSize` vertex indices */
	primitives: Uint32Array;
	/** `primCount` ascending cumulative probabilities ending at 1.0 */
	areaCdf: Float32Array;
}

/** decoded `tables/luts.bin.zst` */
export interface LutsTable {
	curves: CurveLut[];
	gradients: GradientLut[];
	shapeMeshes: ParticleShapeMeshLut[];
}

const MAGIC = fourcc('EFLU');
const MAJOR_VERSION = 2;

const TAG_CRVH = fourcc('CRVH');
const TAG_CRVS = fourcc('CRVS');
const TAG_GRDH = fourcc('GRDH');
const TAG_GRDS = fourcc('GRDS');
const TAG_PMSH = fourcc('PMSH');
const TAG_PMPO = fourcc('PMPO');
const TAG_PMNM = fourcc('PMNM');
const TAG_PMCL = fourcc('PMCL');
const TAG_PMPR = fourcc('PMPR');
const TAG_PMCD = fourcc('PMCD');

const KNOWN_TAGS = new Set([
	TAG_CRVH,
	TAG_CRVS,
	TAG_GRDH,
	TAG_GRDS,
	TAG_PMSH,
	TAG_PMPO,
	TAG_PMNM,
	TAG_PMCL,
	TAG_PMPR,
	TAG_PMCD,
]);

const CRVH_SIZE = 16;
const GRDH_SIZE = 8;
const PMSH_SIZE = 24;

/**
 * encodes a {@link LutsTable} into an `EFLU` TLV container
 *
 * @param table curves, gradients and particle shape meshes
 * @returns encoded bytes (before outer zstd)
 */
export const encodeLutsTable = (table: LutsTable): Uint8Array => {
	const sections: ContainerSectionInput[] = [];

	if (table.curves.length > 0) {
		const total = table.curves.reduce((sum, c) => sum + c.samples.length, 0);
		const headers = new Uint8Array(table.curves.length * CRVH_SIZE);
		const hv = viewOf(headers);
		const samples = new Uint16Array(total);
		let at = 0;
		for (const [i, curve] of table.curves.entries()) {
			const h = i * CRVH_SIZE;
			hv.setUint32(h, at, true);
			hv.setUint16(h + 4, curve.samples.length, true);
			hv.setUint16(h + 6, curve.flags, true);
			hv.setFloat32(h + 8, curve.minVal, true);
			hv.setFloat32(h + 12, curve.maxVal, true);
			samples.set(curve.samples, at);
			at += curve.samples.length;
		}
		sections.push(
			{ tag: TAG_CRVH, data: headers, count: table.curves.length, stride: CRVH_SIZE },
			{ tag: TAG_CRVS, data: new Uint8Array(samples.buffer), count: total, stride: 2 },
		);
	}

	if (table.gradients.length > 0) {
		const totalBytes = table.gradients.reduce((sum, g) => sum + g.samples.byteLength, 0);
		const headers = new Uint8Array(table.gradients.length * GRDH_SIZE);
		const hv = viewOf(headers);
		const bytes = new Uint8Array(totalBytes);
		let at = 0;
		for (const [i, grad] of table.gradients.entries()) {
			const elemBytes = grad.format === GradientLutFormat.Rgba32f ? 16 : 4;
			if (grad.samples.byteLength !== grad.sampleCount * elemBytes) {
				throw new RangeError(`gradient ${i} byte length disagrees with sampleCount`);
			}
			const h = i * GRDH_SIZE;
			hv.setUint32(h, at, true);
			hv.setUint16(h + 4, grad.sampleCount, true);
			hv.setUint8(h + 6, grad.format);
			bytes.set(grad.samples, at);
			at += grad.samples.byteLength;
		}
		sections.push(
			{ tag: TAG_GRDH, data: headers, count: table.gradients.length, stride: GRDH_SIZE },
			{ tag: TAG_GRDS, data: bytes, count: totalBytes, stride: 1 },
		);
	}

	if (table.shapeMeshes.length > 0) {
		let totalVerts = 0;
		let totalColorVerts = 0;
		let totalPrimIndices = 0;
		let totalPrims = 0;
		for (const mesh of table.shapeMeshes) {
			const verts = mesh.positions.length / 3;
			totalVerts += verts;
			if (mesh.hasColor) {
				totalColorVerts += verts;
			}
			totalPrimIndices += mesh.primitives.length;
			totalPrims += mesh.areaCdf.length;
		}
		const headers = new Uint8Array(table.shapeMeshes.length * PMSH_SIZE);
		const hv = viewOf(headers);
		const positions = new Float32Array(totalVerts * 3);
		const normals = new Float32Array(totalVerts * 3);
		const colors = new Uint8Array(totalColorVerts * 4);
		const prims = new Uint32Array(totalPrimIndices);
		const cdfs = new Float32Array(totalPrims);
		let vAt = 0;
		let cAt = 0;
		let piAt = 0;
		let pAt = 0;
		for (const [i, mesh] of table.shapeMeshes.entries()) {
			const verts = mesh.positions.length / 3;
			const primCount = mesh.areaCdf.length;
			if (
				mesh.normals.length !== verts * 3 ||
				mesh.primitives.length !== primCount * mesh.primSize ||
				(mesh.hasColor && mesh.colors?.byteLength !== verts * 4)
			) {
				throw new RangeError(`particle shape mesh ${i} arrays disagree in length`);
			}
			const h = i * PMSH_SIZE;
			hv.setUint32(h, vAt, true);
			hv.setUint32(h + 4, verts, true);
			hv.setUint32(h + 8, piAt, true);
			hv.setUint32(h + 12, pAt, true);
			hv.setUint32(h + 16, primCount, true);
			hv.setUint8(h + 20, mesh.primSize);
			hv.setUint8(h + 21, mesh.hasColor ? 1 : 0);
			positions.set(mesh.positions, vAt * 3);
			normals.set(mesh.normals, vAt * 3);
			if (mesh.hasColor && mesh.colors !== null) {
				colors.set(mesh.colors, cAt * 4);
				cAt += verts;
			}
			prims.set(mesh.primitives, piAt);
			cdfs.set(mesh.areaCdf, pAt);
			vAt += verts;
			piAt += mesh.primitives.length;
			pAt += primCount;
		}
		sections.push(
			{ tag: TAG_PMSH, data: headers, count: table.shapeMeshes.length, stride: PMSH_SIZE },
			{ tag: TAG_PMPO, data: new Uint8Array(positions.buffer), count: totalVerts, stride: 12 },
			{ tag: TAG_PMNM, data: new Uint8Array(normals.buffer), count: totalVerts, stride: 12 },
			...(totalColorVerts > 0 ? [{ tag: TAG_PMCL, data: colors, count: totalColorVerts, stride: 4 }] : []),
			{ tag: TAG_PMPR, data: new Uint8Array(prims.buffer), count: totalPrimIndices, stride: 4 },
			{ tag: TAG_PMCD, data: new Uint8Array(cdfs.buffer), count: totalPrims, stride: 4 },
		);
	}

	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes an `EFLU` TLV LUT table
 *
 * @param data inflated `tables/luts.bin.zst` bytes
 * @returns decoded curves, gradients and particle shape meshes
 * @throws {PackageFormatError} on malformed headers or out-of-range slices
 */
export const decodeLutsTable = (data: Uint8Array): LutsTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'luts table',
	});

	const curves: CurveLut[] = [];
	const crvh = container.sections.get(TAG_CRVH);
	if (crvh !== undefined) {
		checkStride(crvh, CRVH_SIZE, 'CRVH');
		const crvsSec = container.sections.get(TAG_CRVS);
		if (crvsSec === undefined) {
			throw new PackageFormatError('luts table has CRVH without CRVS');
		}
		const all = sectionU16(crvsSec);
		const v = viewOf(crvh.data);
		for (let i = 0; i < crvh.count; i++) {
			const at = i * crvh.stride;
			const first = v.getUint32(at, true);
			const count = v.getUint16(at + 4, true);
			if (first + count > all.length) {
				throw new PackageFormatError(`curve LUT ${i} runs past CRVS`);
			}
			curves.push({
				flags: v.getUint16(at + 6, true),
				minVal: v.getFloat32(at + 8, true),
				maxVal: v.getFloat32(at + 12, true),
				samples: all.subarray(first, first + count),
			});
		}
	}

	const gradients: GradientLut[] = [];
	const grdh = container.sections.get(TAG_GRDH);
	if (grdh !== undefined) {
		checkStride(grdh, GRDH_SIZE, 'GRDH');
		const grdsSec = container.sections.get(TAG_GRDS);
		if (grdsSec === undefined) {
			throw new PackageFormatError('luts table has GRDH without GRDS');
		}
		const v = viewOf(grdh.data);
		for (let i = 0; i < grdh.count; i++) {
			const at = i * grdh.stride;
			const firstByte = v.getUint32(at, true);
			const sampleCount = v.getUint16(at + 4, true);
			const rawFormat = v.getUint8(at + 6);
			if (rawFormat !== GradientLutFormat.Rgba8 && rawFormat !== GradientLutFormat.Rgba32f) {
				throw new PackageFormatError(`gradient LUT ${i} has unknown format ${rawFormat}`);
			}
			const byteLen = sampleCount * (rawFormat === GradientLutFormat.Rgba32f ? 16 : 4);
			if (firstByte + byteLen > grdsSec.byteLength) {
				throw new PackageFormatError(`gradient LUT ${i} runs past GRDS`);
			}
			gradients.push({
				format: rawFormat,
				sampleCount,
				samples: grdsSec.data.subarray(firstByte, firstByte + byteLen),
			});
		}
	}

	const shapeMeshes: ParticleShapeMeshLut[] = [];
	const pmsh = container.sections.get(TAG_PMSH);
	if (pmsh !== undefined) {
		checkStride(pmsh, PMSH_SIZE, 'PMSH');
		const pmpo = container.sections.get(TAG_PMPO);
		const pmnm = container.sections.get(TAG_PMNM);
		const pmpr = container.sections.get(TAG_PMPR);
		const pmcd = container.sections.get(TAG_PMCD);
		if (!pmpo || !pmnm || !pmpr || !pmcd) {
			throw new PackageFormatError('luts table PMSH missing required vertex/primitive sections');
		}
		const allPos = sectionF32(pmpo);
		const allNorm = sectionF32(pmnm);
		const allCol = container.sections.get(TAG_PMCL)?.data ?? null;
		const allPrims = sectionU32(pmpr);
		const allCdfs = sectionF32(pmcd);
		const v = viewOf(pmsh.data);
		let cAt = 0;
		for (let i = 0; i < pmsh.count; i++) {
			const at = i * pmsh.stride;
			const vFirst = v.getUint32(at, true);
			const vCount = v.getUint32(at + 4, true);
			const piFirst = v.getUint32(at + 8, true);
			const pFirst = v.getUint32(at + 12, true);
			const pCount = v.getUint32(at + 16, true);
			const primSize = v.getUint8(at + 20);
			if (primSize !== 2 && primSize !== 3) {
				throw new PackageFormatError(`particle shape mesh ${i} has invalid primSize ${primSize}`);
			}
			const hasColor = (v.getUint8(at + 21) & 1) !== 0;
			let colors: Uint8Array | null = null;
			if (hasColor) {
				if (allCol === null || (cAt + vCount) * 4 > allCol.byteLength) {
					throw new PackageFormatError(`particle shape mesh ${i} colors run past PMCL`);
				}
				colors = allCol.subarray(cAt * 4, (cAt + vCount) * 4);
				cAt += vCount;
			}
			shapeMeshes.push({
				primSize,
				hasColor,
				positions: allPos.subarray(vFirst * 3, (vFirst + vCount) * 3),
				normals: allNorm.subarray(vFirst * 3, (vFirst + vCount) * 3),
				colors,
				primitives: allPrims.subarray(piFirst, piFirst + pCount * primSize),
				areaCdf: allCdfs.subarray(pFirst, pFirst + pCount),
			});
		}
	}

	return { curves, gradients, shapeMeshes };
};

/**
 * evaluates a baked 1D curve LUT at normalized `t` in `[0, 1]` with linear interpolation
 *
 * @param curve baked curve LUT
 * @param t normalized parameter in `[0, 1]`
 * @returns interpolated scalar value
 */
export const sampleCurveLut = (curve: CurveLut, t: number): number => {
	const { samples, minVal, maxVal } = curve;
	const n = samples.length;
	if (n === 0) {
		return minVal;
	}
	if (n === 1) {
		return minVal + (samples[0] / 65535) * (maxVal - minVal);
	}
	const u = Math.max(0, Math.min(1, t)) * (n - 1);
	const i = Math.min(Math.floor(u), n - 2);
	const f = u - i;
	const s = samples[i] + (samples[i + 1] - samples[i]) * f;
	return minVal + (s / 65535) * (maxVal - minVal);
};

/**
 * evaluates a baked 1D gradient LUT at normalized `t` in `[0, 1]` into linear RGBA `out`
 *
 * @param gradient baked gradient LUT
 * @param t normalized parameter in `[0, 1]`
 * @param out destination `[r, g, b, a]`
 * @returns `out`
 */
export const sampleGradientLut = <T extends Float32Array | number[]>(
	gradient: GradientLut,
	t: number,
	out: T,
): T => {
	const n = gradient.sampleCount;
	if (n === 0) {
		out[0] = out[1] = out[2] = out[3] = 1;
		return out;
	}
	const u = Math.max(0, Math.min(1, t)) * (n - 1);
	const i = Math.min(Math.floor(u), Math.max(0, n - 2));
	const j = Math.min(i + 1, n - 1);
	const f = u - i;
	if (gradient.format === GradientLutFormat.Rgba8) {
		const { samples } = gradient;
		const a = i * 4;
		const b = j * 4;
		for (let c = 0; c < 4; c++) {
			out[c] = (samples[a + c] + (samples[b + c] - samples[a + c]) * f) / 255;
		}
	} else {
		const view = viewOf(gradient.samples);
		const a = i * 16;
		const b = j * 16;
		for (let c = 0; c < 4; c++) {
			const va = view.getFloat32(a + c * 4, true);
			const vb = view.getFloat32(b + c * 4, true);
			out[c] = va + (vb - va) * f;
		}
	}
	return out;
};
