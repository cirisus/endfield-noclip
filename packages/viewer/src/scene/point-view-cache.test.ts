import assert from 'node:assert/strict';
import { it } from 'node:test';

import { pointViewKey, readPointView, writePointView } from './point-view-cache.ts';

it('invalidates saved views when geometry, point, level or effective visibility changes', async () => {
	const key = await pointViewKey('gen', 'a', [0, 0, 0], [true, false]);
	assert.ok(key.startsWith('noclip-point-view-v6:'));
	assert.equal(await pointViewKey('gen', 'a', [0, 0, 0], [true, false]), key);
	for (const changed of [
		pointViewKey('new', 'a', [0, 0, 0], [true, false]),
		pointViewKey('gen', 'b', [0, 0, 0], [true, false]),
		pointViewKey('gen', 'a', [1, 0, 0], [true, false]),
		pointViewKey('gen', 'a', [0, 0, 0], [true, true]),
	]) {
		assert.notEqual(await changed, key);
	}
});
it('restores valid views across reads and rejects malformed or blocked storage', () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const items: Record<string, string> = {};
	const storage = {
		getItem: (key: string) => items[key] ?? null,
		setItem: (key: string, value: string) => {
			items[key] = value;
		},
		removeItem: (key: string) => {
			delete items[key];
		},
	};
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
	try {
		const pose = { position: [1, 2, 3] as [number, number, number], yaw: 1, pitch: -0.3 };
		writePointView('test', pose);
		assert.deepEqual(readPointView('test'), pose);
		items.test = '{"position":[0],"yaw":0,"pitch":0}';
		assert.equal(readPointView('test'), null);
		storage.getItem = () => {
			throw new Error('blocked');
		};
		storage.setItem = () => {
			throw new Error('quota');
		};
		assert.equal(readPointView('test'), null);
		assert.doesNotThrow(() => writePointView('test', pose));
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, 'localStorage', descriptor);
		} else {
			Reflect.deleteProperty(globalThis, 'localStorage');
		}
	}
});
