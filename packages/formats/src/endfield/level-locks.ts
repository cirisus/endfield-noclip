import { FormatError } from '../binary/binary-reader.ts';

import { asMemoryPackNumber, asMemoryPackObject, type MemoryPackValue } from './memory-pack.ts';

/** how a gameplay lock on an interactive is opened (`InteractiveUnlockType`) */
export const InteractiveUnlockType = {
	None: 0,
	ScriptLock: 1,
	MiniGame: 2,
	Submit: 3,
	Quest: 4,
	Sludge: 5,
} as const;

/**
 * reads the gameplay locks of a LevelData the MemoryPack schema decoded whole (`LevelDataForMemoryPack`)
 *
 * @param levelData the decoded LevelData
 * @returns by interactive logic id, the unlock types of its locks in order
 * @throws {FormatError} if a lock entry is malformed
 */
export const readLevelLocks = (levelData: MemoryPackValue): Map<bigint, number[]> => {
	const { interactiveLockData } = asMemoryPackObject(levelData, 'interactive lock level data');
	const locks = new Map<bigint, number[]>();
	if (!Array.isArray(interactiveLockData)) {
		return locks;
	}
	for (const value of interactiveLockData) {
		const entry = asMemoryPackObject(value, 'interactive lock entry');
		if (typeof entry.logicIdGlobal !== 'string' || !Array.isArray(entry.locks)) {
			throw new FormatError('invalid interactive lock entry');
		}
		const types = entry.locks.map((lock) => {
			const { unlockType } = asMemoryPackObject(lock, 'interactive lock');
			return asMemoryPackNumber(unlockType, 'interactive unlock type');
		});
		locks.set(BigInt(entry.logicIdGlobal), types);
	}
	return locks;
};
