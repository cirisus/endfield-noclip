import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { constant, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';

import { configOption } from '../../parsers.ts';

/** parser for the optional photography filter export */
export const filtersParser = merge(
	object({
		command: constant('filters'),
		output: withDefault(
			option('-o', '--output', string({ metavar: 'FILE' }), {
				description: message`photo filter library output path`,
			}),
			'out/photo-filters.json',
		),
	}),
	configOption,
);

/** resolved filter export arguments */
export type FiltersArgs = InferValue<typeof filtersParser>;
