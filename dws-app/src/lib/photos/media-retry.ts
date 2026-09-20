export interface MediaFailure {
  status?: number;
  code?: string;
  message?: string;
  networkFailure?: boolean;
  allowStorageLockRetry?: boolean;
}

/** Media transports share remedy semantics even when their error envelopes differ. */
export function classifyMediaFailure(failure: MediaFailure): { retryable: boolean; remedy?: string } {
  const detail = `${failure.code ?? ""} ${failure.message ?? ""}`;
  if (failure.status === 507 || /quota|insufficient.?storage/i.test(detail)) {
    return { retryable: false, remedy: "Storage is full or its quota is exhausted. Ask an administrator to free space or increase the quota, then retry." };
  }
  if (failure.status === 413 || /entitytoolarge|payload.?too.?large/i.test(detail)) {
    return { retryable: false, remedy: "This file exceeds the Storage upload size limit." };
  }
  if (failure.status === 415 || /unsupported|invalidmime|invalid.?mime/i.test(detail)) {
    return { retryable: false, remedy: "This file type is not supported by Storage." };
  }
  if (failure.status === 401 || failure.status === 403) return { retryable: false };
  return { retryable: failure.status === 429 || (failure.status !== undefined && failure.status >= 500) ||
    (!!failure.allowStorageLockRetry && (failure.status === 409 || failure.status === 423)) ||
    ((failure.status === undefined || failure.status === 0) && !!failure.networkFailure) };
}
