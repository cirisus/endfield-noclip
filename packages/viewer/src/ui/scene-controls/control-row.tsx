import type { RuleText, SceneControl, SceneControlKind } from '@endfield-noclip/package-format/states';

import { definite } from '@mary-ext/array-fns';
import type { ReactNode } from 'react';

import type { Viewer } from '../../viewer/viewer.ts';
import { ChoiceRow, ControlValueSelect, SceneToggle } from '../controls.tsx';
import { followLabel } from '../format.ts';

import { Drivers } from './drivers.tsx';

/** kinds whose controls are plain on/off switches */
const SWITCH_KINDS: ReadonlySet<SceneControlKind> = new Set([
	'sceneState',
	'script',
	'logic',
	'cabin',
	'created',
	'activity',
	'door',
	'bridge',
]);

/**
 * a scene control: a checkbox for an on/off switch only the user sets, otherwise a select. derived controls
 * and stream areas offer to follow the game or the camera
 *
 * @param props.describe a rule in words, its references named
 */
export const ControlRow = ({
	viewer,
	control,
	describe,
}: {
	viewer: Viewer;
	control: SceneControl;
	describe: (rule: RuleText) => string;
}) => {
	const detail = definite([control.rule && describe(control.rule), control.assumption]).join(' · ');
	let input: ReactNode;
	if (followLabel(control) === null && SWITCH_KINDS.has(control.kind)) {
		input = (
			<SceneToggle
				label={control.name}
				detail={detail}
				checked={(viewer.sceneValues[control.id] ?? control.default) === 1}
				onChange={(checked) => viewer.setSceneValue(control.id, Number(checked))}
			/>
		);
	} else {
		input = (
			<ChoiceRow label={control.name} detail={detail}>
				<ControlValueSelect viewer={viewer} control={control} />
			</ChoiceRow>
		);
	}
	return (
		<div>
			{input}
			<Drivers viewer={viewer} control={control} />
		</div>
	);
};
