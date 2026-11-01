import { decodeData } from './decode-data.ts';
import type { DecodeRequest, DecodeResponse } from './decode-protocol.ts';

self.addEventListener('message', async (event: MessageEvent<DecodeRequest>) => {
	const request = event.data;
	try {
		const { response, transfer } = await decodeData(request);
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posting to its owner
		self.postMessage(response, { transfer });
	} catch (err) {
		const response: DecodeResponse = { id: request.id, kind: 'error', message: String(err) };
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posting to its owner
		self.postMessage(response);
	}
});
