import 'server-only';

export class ConfiguredSecretError extends Error {
  constructor() { super('Invalid request.'); }
}

/** Reject before validation/persistence; never put rejected values in an error or log. */
export function assertNoConfiguredSecrets(value: unknown): void {
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) => secret && !name.startsWith('NEXT_PUBLIC_') &&
      /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|MCP_SHARED_KEY)/i.test(name))
    .map(([, secret]) => secret!);
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      let decoded = item;
      for (let round = 0; round < 3; round++) {
        if (secrets.some(secret => decoded.includes(secret))) throw new ConfiguredSecretError();
        try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
        catch { break; }
      }
    } else if (item && typeof item === 'object' && !visited.has(item)) {
      visited.add(item);
      for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
}
