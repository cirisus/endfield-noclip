import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DynamicEntity, WaterPipe } from '@endfield-noclip/formats/endfield/dynamic-scene';
import { quaternionUnityEuler } from '@endfield-noclip/formats/unity/transform';

import { GameState } from '../state/game-state.ts';

import { collectWaterPipes, noteWaterPipeConditions, waterPipeLooks } from './water-pipes.ts';

const pipeEntity = (varKey: number, waterPipe: WaterPipe, mapId = 85): DynamicEntity => ({
	grid: 1,
	uid: waterPipe.interactiveId,
	entityType: waterPipe.isOutFall ? 35 : 30,
	components: [47, 51],
	controllers: [],
	gates: [],
	variables: [{ kind: 'mapVar', key: varKey, mapId }],
	viewState: waterPipe.isOutFall ? null : { model: 'dyn_waterPipe_postmodel', oldVersion: false },
	resourceGroups: [],
	states: [],
	areas: [],
	scriptDefaultLoad: null,
	extraScene: null,
	erosionCore: null,
	sludgeCore: null,
	waterPipe,
});

const upper = pipeEntity(100, {
	interactiveId: 10100290007n,
	upstreamInteractiveId: 0n,
	isOutFall: false,
	connectedToWaterWheel: false,
	initialAngle: -59,
	targetAngle: 61,
	delayActivateDownStream: 0.5,
	heightToDownStream: 9.5,
	heightToGround: 22.5,
});

const lower = pipeEntity(97, {
	interactiveId: 10100290008n,
	upstreamInteractiveId: 10100290007n,
	isOutFall: false,
	connectedToWaterWheel: true,
	initialAngle: 26.1,
	targetAngle: 86.1,
	delayActivateDownStream: 0.5,
	heightToDownStream: 9,
	heightToGround: 16,
});

test('top-of-chain pipe always has water and switches between target and initial angles', () => {
	const pipes = collectWaterPipes([upper, lower]);
	assert.equal(pipes.size, 2);
	const game = new GameState();
	noteWaterPipeConditions(game, pipes);

	const looks = waterPipeLooks(game, pipes.get(upper)!, [0, 12.7, 0]);
	assert.equal(looks.length, 2);
	const [target, initial] = looks;
	assert.equal(target.suffix, '@target');
	assert.equal(target.pose.active.get('Effect'), true);
	assert.equal(target.pose.lengths?.get('WaterFall'), 9.5);
	assert.equal(target.pose.lengths?.get('Splash'), 9.5);
	const [, targetLocalYaw] = quaternionUnityEuler(target.pose.rotations!.get('RotateRoot')!);
	assert.ok(Math.abs(targetLocalYaw - (61 - 12.7)) < 1e-4);

	assert.equal(initial.suffix, '@initial');
	assert.equal(initial.pose.active.get('Effect'), true);
	assert.equal(initial.pose.lengths?.get('WaterFall'), 22.5);
	assert.equal(initial.pose.lengths?.get('Splash'), 22.5);
	const [, initLocalYaw] = quaternionUnityEuler(initial.pose.rotations!.get('RotateRoot')!);
	assert.ok(Math.abs(initLocalYaw - (-59 - 12.7)) < 1e-4);
});

test('downstream pipe hides Effect when upstream is not aligned and adjusts lengths when wet', () => {
	const pipes = collectWaterPipes([upper, lower]);
	const game = new GameState();
	noteWaterPipeConditions(game, pipes);

	const looks = waterPipeLooks(game, pipes.get(lower)!, [0, 26.1, 0]);
	assert.deepEqual(
		looks.map((l) => l.suffix),
		['@target:wet', '@initial:wet', '@target:dry', '@initial:dry'],
	);
	assert.equal(looks[0].pose.active.get('Effect'), true);
	assert.equal(looks[0].pose.lengths?.get('Splash'), 9);
	assert.equal(looks[1].pose.active.get('Effect'), true);
	assert.equal(looks[1].pose.lengths?.get('Splash'), 16);
	assert.equal(looks[2].pose.active.get('Effect'), false);
	assert.equal(looks[2].pose.lengths, undefined);
	assert.equal(looks[3].pose.active.get('Effect'), false);
	assert.equal(looks[3].pose.lengths, undefined);
	// each wet look requires both upstream (#100) and self (#97)
	assert.equal(looks[0].when.length, 1);
	assert.equal(looks[0].when[0].length, 2);
});

test('outfall supplies water when its own mapVar equals 1', () => {
	const outfall = pipeEntity(
		11,
		{
			interactiveId: 28000000300n,
			upstreamInteractiveId: 0n,
			isOutFall: true,
			connectedToWaterWheel: false,
			initialAngle: 0,
			targetAngle: 0,
			delayActivateDownStream: 1,
			heightToDownStream: 0,
			heightToGround: 0,
		},
		278,
	);
	const fed = pipeEntity(
		3,
		{
			interactiveId: 28000000264n,
			upstreamInteractiveId: 28000000300n,
			isOutFall: false,
			connectedToWaterWheel: false,
			initialAngle: -110,
			targetAngle: 10,
			delayActivateDownStream: 0.5,
			heightToDownStream: 10.3,
			heightToGround: 26.9,
		},
		278,
	);
	const pipes = collectWaterPipes([outfall, fed]);
	assert.equal(pipes.size, 1);
	assert.deepEqual(pipes.get(fed)?.upstream, {
		kind: 'whenAllOn',
		variables: [{ kind: 'mapVar', key: 11, mapId: 278 }],
	});
});
