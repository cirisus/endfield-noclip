import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InteractiveUnlockType, readLevelLocks } from './level-locks.ts';

test('level locks map each interactive logic id to its unlock types in order', () => {
	const lock = (unlockType: number) => ({
		$type: 'Beyond_Gameplay_InteractiveSingleLockDataForMemoryPack',
		unlockType,
	});
	const locks = readLevelLocks({
		interactiveLockData: [
			{ logicIdGlobal: '3500021687', locks: [lock(InteractiveUnlockType.MiniGame)] },
			{
				logicIdGlobal: '3500021688',
				locks: [lock(InteractiveUnlockType.ScriptLock), lock(InteractiveUnlockType.Submit)],
			},
		],
	});
	assert.deepEqual(
		[...locks],
		[
			[3500021687n, [2]],
			[3500021688n, [1, 3]],
		],
	);
	assert.equal(readLevelLocks({ interactiveLockData: null }).size, 0);
	assert.throws(() => readLevelLocks({ interactiveLockData: [{ logicIdGlobal: '1', locks: [{}] }] }));
});
