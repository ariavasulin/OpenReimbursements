// A stored original streamed into /tmp under a byte cap, for the server-side
// renderers (sharp for images, ffmpeg for video) that read from a file.
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { WorkBudget } from './deadline';

export class MediaProcessingLimit extends Error {
  constructor(detail: string) {
    super(`repair media processing limit: ${detail}; generate derivatives in the upload client`);
    this.name = 'MediaProcessingLimit';
  }
}

/** Never trust Content-Length (or row metadata) to bound bytes written to /tmp. */
export async function downloadOriginal(url: string, input: string, budget: WorkBudget, maxBytes: number) {
  await budget.run(async signal => {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`download original: ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body.cancel();
      throw new MediaProcessingLimit(`original exceeds ${maxBytes} bytes`);
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) next(new MediaProcessingLimit(`original exceeds ${maxBytes} bytes`));
        else next(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), limit, createWriteStream(input), { signal });
  });
}
