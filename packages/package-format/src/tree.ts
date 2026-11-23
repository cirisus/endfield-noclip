import { checkedEnum, enumGuard, viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';
import type { Bounds, Rect } from './values.ts';

/** what a tile content reference points at */
export const ContentKind = {
	/** the node's terrain height page */
	TerrainHeights: 0,
	/** HLOD cluster rows `[first, first + count)` of an instance block; `tier` is the HLOD tier */
	Hlod: 1,
	/** detail instances the HLODs stand in for: a whole instance block, drawn once its leaf refines */
	Detail: 2,
	/**
	 * instances the HLODs don't stand in for (scene-state and dynamic content): a whole instance block, drawn
	 * regardless of refinement while the camera is within the detail distance of its tile, or, with a `reach`,
	 * while the camera is inside that reach
	 */
	Conditional: 3,
	/** the node's baked terrain surface page (albedo and normal); covers the same tile as its height page */
	TerrainSurface: 4,
	/** a leaf node's close-up blend inputs (splat control, tint, layer index) */
	TerrainSplat: 5,
} as const;

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

/** readable names of content kinds, for reports and debugging */
export const CONTENT_KIND_NAMES: Record<ContentKind, string> = {
	[ContentKind.TerrainHeights]: 'terrainHeights',
	[ContentKind.Hlod]: 'hlod',
	[ContentKind.Detail]: 'detail',
	[ContentKind.Conditional]: 'conditional',
	[ContentKind.TerrainSurface]: 'terrainSurface',
	[ContentKind.TerrainSplat]: 'terrainSplat',
};

/** game streaming layer a content ref or instance block belongs to */
export const StreamingLayer = {
	Default: 0,
	Tiny: 1,
	Lighting: 2,
	Hlod0: 3,
	Hlod1: 4,
	Hlod2: 5,
	Persistent: 6,
	Dynamic: 7,
} as const;

export type StreamingLayer = (typeof StreamingLayer)[keyof typeof StreamingLayer];

/**
 * the tile hierarchy: a forest of quadtrees on one unbounded grid. level `l` tiles are `rootSize / 2^l`
 * across and tile `(l, x, z)` covers `[origin.x + x·size, +size) × [origin.z + z·size, +size)`; `x`, `z` may
 * be negative or exceed `2^l - 1` for content off the terrain square. children of `(l, x, z)` are `(l + 1, 2x +
 * dx, 2z + dz)`. the grid coincides with the game's terrain quadtree (same origin, same levels)
 */
export interface TreeInfo {
	/** world x, z of tile `(0, 0, 0)`'s minimum corner */
	origin: [x: number, z: number];
	/** edge length of a level-0 tile, metres */
	rootSize: number;
	/** deepest level; its 64 m tiles carry detail instances and HLOD0 */
	leafLevel: number;
	/** level whose tiles are the game's 128 m streaming and level-ownership cells */
	cellLevel: number;
	/** the level each HLOD tier attaches to, by tier */
	hlodLevels: number[];
	/** level whose tiles group shard archives (see {@link ArchiveInfo.tile}) */
	shardLevel: number;
}

/** a reference from a tree node, or from {@link Tree.global}, to content */
export interface ContentRef {
	kind: ContentKind;
	/** HLOD tier for {@link ContentKind.Hlod}; 0 otherwise */
	tier: number;
	/** optional streaming layer (defaults to {@link StreamingLayer.Default}) */
	streamingLayer?: StreamingLayer;
	/**
	 * index into `StatesInfo.groups`: who owns the content and when it loads. terrain uses an always-shown
	 * group
	 */
	group: number;
	/** blob index */
	blob: number;
	/** first row, for refs into a shared instance block; 0 otherwise */
	first: number;
	/** row count (instances), or 1 for single-item blobs */
	count: number;
	/**
	 * for {@link ContentKind.Conditional}, index into {@link Tree.reaches}: the content draws while the camera is
	 * inside it, however far its tile. `null` otherwise
	 */
	reach: number | null;
}

/** a tree node */
export interface TreeNode {
	level: number;
	x: number;
	z: number;
	/** index of parent node in {@link Tree.nodes}, or `-1` for roots (auto-computed on encode if omitted) */
	parent?: number;
	/** bounds of everything the node and its descendants draw, including overhang past the tile */
	bounds: Bounds;
	/**
	 * world-space error, metres, of drawing this node's coarse content (HLOD, terrain page) instead of
	 * refining. screen-space error = `geometricError · viewportHeight / (2 · distance · tan(fovY / 2))`
	 */
	geometricError: number;
	/** this node's slice of {@link Tree.refs} */
	refFirst: number;
	refCount: number;
}

/** an HLOD cluster hierarchy link in `tree.bin` (`HLOD` section) */
export interface HlodClusterLink {
	clusterId: number;
	/** parent cluster id, or `-1` for top-tier clusters */
	parentCluster: number;
	childCount: number;
	unloadMask: number;
}

/** decoded tree.bin */
export interface Tree {
	/** coarse to fine: by level, then z, then x */
	nodes: TreeNode[];
	/** the nodes' refs, each node's a contiguous slice */
	refs: ContentRef[];
	/**
	 * content drawn regardless of the tree's refinement while its group shows (the game's Global chunk scenery,
	 * conditional where it comes from scene-state chunks)
	 */
	global: ContentRef[];
	/** world x, z rectangles {@link ContentRef.reach} names, `[min, max)` on each axis; a bound may be infinite */
	reaches: Rect[];
	/** optional explicit HLOD cluster links (additive `HLOD` section) */
	hlodClusters?: HlodClusterLink[];
}

const MAGIC = fourcc('EFTR');
const MAJOR_VERSION = 2;
const TAG_NODE = fourcc('NODE');
const TAG_REFS = fourcc('REFS');
const TAG_GLOB = fourcc('GLOB');
const TAG_RCHS = fourcc('RCHS');
const TAG_HLOD = fourcc('HLOD');
const KNOWN_TAGS = new Set([TAG_NODE, TAG_REFS, TAG_GLOB, TAG_RCHS, TAG_HLOD]);

const NODE_SIZE = 52;
const REF_SIZE = 24;
const REACH_SIZE = 16;
const HLOD_SIZE = 16;
const NONE = 0xff_ff_ff_ff;

const isContentKind = enumGuard(ContentKind);
const isStreamingLayer = enumGuard(StreamingLayer);

const encodeRefs = (refs: readonly ContentRef[], reachCount: number): Uint8Array => {
	const buf = new Uint8Array(refs.length * REF_SIZE);
	const view = viewOf(buf);
	for (const [i, ref] of refs.entries()) {
		if (ref.reach !== null && ref.reach >= reachCount) {
			throw new RangeError(`a ref's reach ${ref.reach} runs past the reach table`);
		}
		const at = i * REF_SIZE;
		view.setUint8(at, ref.kind);
		view.setUint8(at + 1, ref.tier);
		view.setUint8(at + 2, ref.streamingLayer ?? StreamingLayer.Default);
		view.setUint32(at + 4, ref.group, true);
		view.setUint32(at + 8, ref.blob, true);
		view.setUint32(at + 12, ref.first, true);
		view.setUint32(at + 16, ref.count, true);
		view.setUint32(at + 20, ref.reach ?? NONE, true);
	}
	return buf;
};

const decodeRefs = (data: Uint8Array, count: number, stride: number, reachCount: number): ContentRef[] => {
	const view = viewOf(data);
	const refs: ContentRef[] = [];
	for (let i = 0; i < count; i++) {
		const at = i * stride;
		const reach = view.getUint32(at + 20, true);
		if (reach !== NONE && reach >= reachCount) {
			throw new PackageFormatError(`a ref's reach ${reach} runs past the reach table`);
		}
		const layer = checkedEnum(isStreamingLayer, view.getUint8(at + 2), 'streaming layer');
		refs.push({
			kind: checkedEnum(isContentKind, view.getUint8(at), 'content kind'),
			tier: view.getUint8(at + 1),
			...(layer !== StreamingLayer.Default ? { streamingLayer: layer } : {}),
			group: view.getUint32(at + 4, true),
			blob: view.getUint32(at + 8, true),
			first: view.getUint32(at + 12, true),
			count: view.getUint32(at + 16, true),
			reach: reach === NONE ? null : reach,
		});
	}
	return refs;
};

/**
 * encodes `tree.bin` as an `EFTR` v2 TLV container
 *
 * @param tree nodes, refs and reaches
 * @returns the encoded file
 * @throws {RangeError} if a node's ref slice runs past `refs`, or a ref's reach past `reaches`
 */
export const encodeTree = (tree: Tree): Uint8Array => {
	const nodeIndex = new Map<string, number>();
	for (const [i, node] of tree.nodes.entries()) {
		nodeIndex.set(`${node.level}/${node.x}/${node.z}`, i);
	}
	const nodeBuf = new Uint8Array(tree.nodes.length * NODE_SIZE);
	const nv = viewOf(nodeBuf);
	for (const [i, node] of tree.nodes.entries()) {
		if (node.refFirst + node.refCount > tree.refs.length) {
			throw new RangeError(`node ${node.level}/${node.x}/${node.z} refs run past the ref table`);
		}
		const parent =
			node.parent ??
			(node.level > 0
				? (nodeIndex.get(`${node.level - 1}/${Math.floor(node.x / 2)}/${Math.floor(node.z / 2)}`) ?? -1)
				: -1);
		const at = i * NODE_SIZE;
		nv.setInt32(at, node.x, true);
		nv.setInt32(at + 4, node.z, true);
		nv.setInt32(at + 8, parent, true);
		nv.setUint8(at + 12, node.level);
		for (let axis = 0; axis < 3; axis++) {
			nv.setFloat32(at + 16 + axis * 4, node.bounds.min[axis], true);
			nv.setFloat32(at + 28 + axis * 4, node.bounds.max[axis], true);
		}
		nv.setFloat32(at + 40, node.geometricError, true);
		nv.setUint32(at + 44, node.refFirst, true);
		nv.setUint32(at + 48, node.refCount, true);
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_NODE, required: true, data: nodeBuf, count: tree.nodes.length, stride: NODE_SIZE },
		{
			tag: TAG_REFS,
			required: true,
			data: encodeRefs(tree.refs, tree.reaches.length),
			count: tree.refs.length,
			stride: REF_SIZE,
		},
		{
			tag: TAG_GLOB,
			required: true,
			data: encodeRefs(tree.global, tree.reaches.length),
			count: tree.global.length,
			stride: REF_SIZE,
		},
	];
	if (tree.reaches.length > 0) {
		const reachBuf = new Uint8Array(tree.reaches.length * REACH_SIZE);
		const rv = viewOf(reachBuf);
		for (const [i, reach] of tree.reaches.entries()) {
			const at = i * REACH_SIZE;
			rv.setFloat32(at, reach.minX, true);
			rv.setFloat32(at + 4, reach.minZ, true);
			rv.setFloat32(at + 8, reach.maxX, true);
			rv.setFloat32(at + 12, reach.maxZ, true);
		}
		sections.push({
			tag: TAG_RCHS,
			required: false,
			data: reachBuf,
			count: tree.reaches.length,
			stride: REACH_SIZE,
		});
	}
	if (tree.hlodClusters !== undefined && tree.hlodClusters.length > 0) {
		const hlodBuf = new Uint8Array(tree.hlodClusters.length * HLOD_SIZE);
		const hv = viewOf(hlodBuf);
		for (const [i, link] of tree.hlodClusters.entries()) {
			const at = i * HLOD_SIZE;
			hv.setUint32(at, link.clusterId, true);
			hv.setInt32(at + 4, link.parentCluster, true);
			hv.setUint32(at + 8, link.childCount, true);
			hv.setUint32(at + 12, link.unloadMask, true);
		}
		sections.push({
			tag: TAG_HLOD,
			required: false,
			data: hlodBuf,
			count: tree.hlodClusters.length,
			stride: HLOD_SIZE,
		});
	}
	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes `tree.bin` (`EFTR` v2 TLV container)
 *
 * @param data tree.bin
 * @returns its nodes, refs and reaches
 * @throws {PackageFormatError} on a bad header, length or reach index
 */
export const decodeTree = (data: Uint8Array): Tree => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'package tree',
	});
	const nodeSec = requireSection(container, TAG_NODE, 'package tree');
	const refSec = requireSection(container, TAG_REFS, 'package tree');
	const globSec = requireSection(container, TAG_GLOB, 'package tree');
	const reachSec = container.sections.get(TAG_RCHS);
	checkStride(nodeSec, NODE_SIZE, 'NODE');
	checkStride(refSec, REF_SIZE, 'REFS');
	checkStride(globSec, REF_SIZE, 'GLOB');
	if (reachSec !== undefined) {
		checkStride(reachSec, REACH_SIZE, 'RCHS');
	}
	const reachCount = reachSec?.count ?? 0;

	const nv = viewOf(nodeSec.data);
	const nodes: TreeNode[] = [];
	for (let i = 0; i < nodeSec.count; i++) {
		const at = i * nodeSec.stride;
		const f = (offset: number): number => nv.getFloat32(at + offset, true);
		const parent = nv.getInt32(at + 8, true);
		nodes.push({
			level: nv.getUint8(at + 12),
			x: nv.getInt32(at, true),
			z: nv.getInt32(at + 4, true),
			...(parent >= 0 ? { parent } : {}),
			bounds: { min: [f(16), f(20), f(24)], max: [f(28), f(32), f(36)] },
			geometricError: f(40),
			refFirst: nv.getUint32(at + 44, true),
			refCount: nv.getUint32(at + 48, true),
		});
	}
	const refs = decodeRefs(refSec.data, refSec.count, refSec.stride, reachCount);
	const global = decodeRefs(globSec.data, globSec.count, globSec.stride, reachCount);
	const reaches: Rect[] = [];
	if (reachSec !== undefined) {
		const rv = viewOf(reachSec.data);
		for (let i = 0; i < reachSec.count; i++) {
			const at = i * reachSec.stride;
			const f = (offset: number): number => rv.getFloat32(at + offset, true);
			reaches.push({ minX: f(0), minZ: f(4), maxX: f(8), maxZ: f(12) });
		}
	}
	const hlodSec = container.sections.get(TAG_HLOD);
	let hlodClusters: HlodClusterLink[] | undefined;
	if (hlodSec !== undefined) {
		checkStride(hlodSec, HLOD_SIZE, 'HLOD');
		const hv = viewOf(hlodSec.data);
		hlodClusters = [];
		for (let i = 0; i < hlodSec.count; i++) {
			const at = i * hlodSec.stride;
			hlodClusters.push({
				clusterId: hv.getUint32(at, true),
				parentCluster: hv.getInt32(at + 4, true),
				childCount: hv.getUint32(at + 8, true),
				unloadMask: hv.getUint32(at + 12, true),
			});
		}
	}
	return hlodClusters === undefined
		? { nodes, refs, global, reaches }
		: { nodes, refs, global, reaches, hlodClusters };
};
