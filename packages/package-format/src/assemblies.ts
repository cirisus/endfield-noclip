/**
 * `tables/assemblies.bin.zst` (`EFAS` TLV container): lightweight transform-node assemblies for moving and
 * stateful prefabs (moving platforms, waterwheels, lifts, cranes, multi-state interactives) so meshes,
 * lights, decals, billboards, and particle emitters share parent transforms and `.anim` clips
 *
 * @module
 */

import { viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';

/** one transform node inside an assembly */
export interface AssemblyNode {
	/** parent node index within {@link AssembliesTable.nodes}, or `-1` for an assembly root */
	parent: number;
	/** optional default `.anim` blob index (`0xffffffff` = none, decoded as `null`) */
	animBlob: number | null;
	/** 12-float `rows3x4` local transform relative to parent (or world for root) */
	localTransform: [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
}

/** a state-driven clip/pose override on an assembly */
export interface AssemblyState {
	/** index into `StatesInfo.controls` */
	control: number;
	/** bitmask of control values selecting this state */
	valueMask: number;
	/** `.anim` blob index active in this state, or `null` */
	animBlob: number | null;
}

/** one moving or stateful prefab assembly */
export interface AssemblyInfo {
	/** slice of {@link AssembliesTable.nodes} */
	firstNode: number;
	nodeCount: number;
	flags: number;
	/** visibility group index (`StatesInfo.groups`) */
	group: number;
	/** slice of {@link AssembliesTable.states} */
	firstState: number;
	stateCount: number;
	defaultState: number;
}

/** decoded `tables/assemblies.bin.zst` */
export interface AssembliesTable {
	assemblies: AssemblyInfo[];
	nodes: AssemblyNode[];
	states: AssemblyState[];
}

const MAGIC = fourcc('EFAS');
const MAJOR_VERSION = 2;

const TAG_ASMB = fourcc('ASMB');
const TAG_NODE = fourcc('NODE');
const TAG_STAT = fourcc('STAT');
const KNOWN_TAGS = new Set([TAG_ASMB, TAG_NODE, TAG_STAT]);

const ASMB_SIZE = 20;
const NODE_SIZE = 56;
const STAT_SIZE = 12;
const NONE = 0xff_ff_ff_ff;

/**
 * encodes an {@link AssembliesTable} into an `EFAS` TLV container
 *
 * @param table assemblies, nodes, and state bindings
 * @returns encoded bytes (before outer zstd)
 * @throws {RangeError} if any assembly's node or state slice runs past the table
 */
export const encodeAssembliesTable = (table: AssembliesTable): Uint8Array => {
	const asmbBuf = new Uint8Array(table.assemblies.length * ASMB_SIZE);
	const av = viewOf(asmbBuf);
	for (const [i, a] of table.assemblies.entries()) {
		if (a.firstNode + a.nodeCount > table.nodes.length) {
			throw new RangeError(`assembly ${i} nodes run past NODE table`);
		}
		if (a.firstState + a.stateCount > table.states.length) {
			throw new RangeError(`assembly ${i} states run past STAT table`);
		}
		const at = i * ASMB_SIZE;
		av.setUint32(at, a.firstNode, true);
		av.setUint16(at + 4, a.nodeCount, true);
		av.setUint16(at + 6, a.flags, true);
		av.setUint32(at + 8, a.group, true);
		av.setUint32(at + 12, a.firstState, true);
		av.setUint16(at + 16, a.stateCount, true);
		av.setUint16(at + 18, a.defaultState, true);
	}

	const nodeBuf = new Uint8Array(table.nodes.length * NODE_SIZE);
	const nv = viewOf(nodeBuf);
	for (const [i, n] of table.nodes.entries()) {
		const at = i * NODE_SIZE;
		nv.setInt32(at, n.parent, true);
		nv.setUint32(at + 4, n.animBlob ?? NONE, true);
		for (let k = 0; k < 12; k++) {
			nv.setFloat32(at + 8 + k * 4, n.localTransform[k], true);
		}
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_ASMB, required: true, data: asmbBuf, count: table.assemblies.length, stride: ASMB_SIZE },
		{ tag: TAG_NODE, required: true, data: nodeBuf, count: table.nodes.length, stride: NODE_SIZE },
	];

	if (table.states.length > 0) {
		const statBuf = new Uint8Array(table.states.length * STAT_SIZE);
		const sv = viewOf(statBuf);
		for (const [i, s] of table.states.entries()) {
			const at = i * STAT_SIZE;
			sv.setUint32(at, s.control, true);
			sv.setUint32(at + 4, s.valueMask, true);
			sv.setUint32(at + 8, s.animBlob ?? NONE, true);
		}
		sections.push({
			tag: TAG_STAT,
			required: false,
			data: statBuf,
			count: table.states.length,
			stride: STAT_SIZE,
		});
	}

	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes an `EFAS` assemblies table
 *
 * @param data inflated `tables/assemblies.bin.zst` bytes
 * @returns decoded assemblies, nodes, and state bindings
 * @throws {PackageFormatError} on malformed headers or out-of-range slices
 */
export const decodeAssembliesTable = (data: Uint8Array): AssembliesTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'assemblies table',
	});
	const asmbSec = requireSection(container, TAG_ASMB, 'assemblies table');
	const nodeSec = requireSection(container, TAG_NODE, 'assemblies table');
	const statSec = container.sections.get(TAG_STAT);
	checkStride(asmbSec, ASMB_SIZE, 'ASMB');
	checkStride(nodeSec, NODE_SIZE, 'NODE');
	if (statSec !== undefined) {
		checkStride(statSec, STAT_SIZE, 'STAT');
	}
	const statCount = statSec?.count ?? 0;

	const av = viewOf(asmbSec.data);
	const assemblies: AssemblyInfo[] = [];
	for (let i = 0; i < asmbSec.count; i++) {
		const at = i * asmbSec.stride;
		const firstNode = av.getUint32(at, true);
		const nodeCount = av.getUint16(at + 4, true);
		const firstState = av.getUint32(at + 12, true);
		const stateCount = av.getUint16(at + 16, true);
		if (firstNode + nodeCount > nodeSec.count) {
			throw new PackageFormatError(`assembly ${i} nodes run past NODE table`);
		}
		if (firstState + stateCount > statCount) {
			throw new PackageFormatError(`assembly ${i} states run past STAT table`);
		}
		assemblies.push({
			firstNode,
			nodeCount,
			flags: av.getUint16(at + 6, true),
			group: av.getUint32(at + 8, true),
			firstState,
			stateCount,
			defaultState: av.getUint16(at + 18, true),
		});
	}

	const nv = viewOf(nodeSec.data);
	const nodes: AssemblyNode[] = [];
	for (let i = 0; i < nodeSec.count; i++) {
		const at = i * nodeSec.stride;
		const rawAnim = nv.getUint32(at + 4, true);
		const f = (k: number): number => nv.getFloat32(at + 8 + k * 4, true);
		nodes.push({
			parent: nv.getInt32(at, true),
			animBlob: rawAnim === NONE ? null : rawAnim,
			localTransform: [f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8), f(9), f(10), f(11)],
		});
	}

	const states: AssemblyState[] = [];
	if (statSec !== undefined) {
		const sv = viewOf(statSec.data);
		for (let i = 0; i < statSec.count; i++) {
			const at = i * statSec.stride;
			const rawAnim = sv.getUint32(at + 8, true);
			states.push({
				control: sv.getUint32(at, true),
				valueMask: sv.getUint32(at + 4, true),
				animBlob: rawAnim === NONE ? null : rawAnim,
			});
		}
	}

	return { assemblies, nodes, states };
};
