import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { constant, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';

import { configOption } from '../../parsers.ts';

/** parser for `endfield-extract init` */
export const initParser = merge(
	object({
		command: constant('init'),
		game: option('--game', string({ metavar: 'DIR' }), {
			description: message`install root or Endfield_Data directory`,
		}),
		keysFrom: multiple(
			option('--keys-from', string({ metavar: 'DIR' }), {
				description: message`fallback tool checkout directory to import missing keys from`,
			}),
		),
	}),
	configOption,
);

/** parsed arguments for `init` */
export type InitArgs = InferValue<typeof initParser>;
