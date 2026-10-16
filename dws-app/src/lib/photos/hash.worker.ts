import { hashBlob } from "./hash-core";
import type { HashWorkerReply } from "./hash";

// One file at a time, for as many files as its caller sends; the caller
// terminates it on cancellation or failure.
self.onmessage = async (event: MessageEvent<Blob>) => {
  let reply: HashWorkerReply;
  try {
    reply = { digest: await hashBlob(event.data) };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : "Hashing failed" };
  }
  self.postMessage(reply);
};
