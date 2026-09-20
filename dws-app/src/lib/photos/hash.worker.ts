import { hashBlob } from "./hash-core";
import type { HashWorkerReply } from "./hash";

// Each worker owns one file and is terminated by its caller, including on abort.
self.onmessage = async (event: MessageEvent<Blob>) => {
  self.onmessage = null;
  let reply: HashWorkerReply;
  try {
    reply = { digest: await hashBlob(event.data) };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : "Hashing failed" };
  }
  self.postMessage(reply);
};
