/** coalesce blobs whose ranges are at most this far apart, bytes */
const COALESCE_GAP = 64 * 1024;
/** largest coalesced read, bytes */
const COALESCE_SPAN = 2 * 1024 * 1024;
/** most blobs in one coalesced read */
const COALESCE_COUNT = 96;

/** a queued blob's byte range */
export interface QueuedRange {
	/** index of the archive holding it */
	archive: number;
	/** absolute byte range in the archive, `[start, end)` */
	start: number;
	end: number;
	/** larger reads sooner */
	priority: number;
}

/** one range read covering several queued blobs */
export interface CoalescedRead {
	/** indices into the ranges, in byte order */
	members: number[];
	/** the read's byte range, `[start, end)` */
	start: number;
	end: number;
}

/**
 * groups queued blobs into range reads. seeds are taken by descending priority (ties in input order); each
 * takes in its unclaimed neighbours in the same archive while the gaps stay at most 64 KiB, the read at most
 * 2 MiB and 96 blobs, growing right before left.
 *
 * @param ranges the queued blobs
 * @param maxReads the most reads to return
 * @returns the reads, in seed order
 */
export const coalesceRanges = (ranges: readonly QueuedRange[], maxReads: number): CoalescedRead[] => {
	const reads: CoalescedRead[] = [];
	const n = ranges.length;
	if (n === 0 || maxReads <= 0) {
		return reads;
	}
	const indices = Array.from({ length: n }, (_, i) => i);
	const byPriority = indices.toSorted((a, b) => ranges[b].priority - ranges[a].priority);
	const rank = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		rank[byPriority[i]] = i;
	}
	const byPosition = indices.toSorted(
		(a, b) => ranges[a].archive - ranges[b].archive || ranges[a].start - ranges[b].start || rank[a] - rank[b],
	);
	const positions = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		positions[byPosition[i]] = i;
	}
	const taken = new Uint8Array(n);

	for (const seed of byPriority) {
		if (reads.length >= maxReads) {
			break;
		}
		if (taken[seed] === 1) {
			continue;
		}
		const archive = ranges[seed].archive;
		const usable = (p: number): boolean =>
			p >= 0 && p < n && taken[byPosition[p]] === 0 && ranges[byPosition[p]].archive === archive;
		const at = positions[seed];
		let lo = at;
		let hi = at;
		let start = ranges[seed].start;
		let end = ranges[seed].end;
		while (hi - lo + 1 < COALESCE_COUNT) {
			const right = usable(hi + 1) ? ranges[byPosition[hi + 1]] : null;
			const left = usable(lo - 1) ? ranges[byPosition[lo - 1]] : null;
			if (
				right !== null &&
				right.start - end <= COALESCE_GAP &&
				Math.max(end, right.end) - start <= COALESCE_SPAN
			) {
				hi++;
				end = Math.max(end, right.end);
			} else if (left !== null && start - left.end <= COALESCE_GAP && end - left.start <= COALESCE_SPAN) {
				lo--;
				start = left.start;
			} else {
				break;
			}
		}
		const members = byPosition.slice(lo, hi + 1);
		for (const member of members) {
			taken[member] = 1;
		}
		reads.push({ members, start, end });
	}
	return reads;
};
