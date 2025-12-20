import { AgentMailClient } from 'agentmail';

let client: AgentMailClient | null = null;

export function getAgentMailClient(): AgentMailClient {
  if (!client) {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
      throw new Error('AGENTMAIL_API_KEY environment variable is not set');
    }
    client = new AgentMailClient({ apiKey });
  }
  return client;
}

export function getInboxId(): string {
  const inboxId = process.env.AGENTMAIL_INBOX_ID;
  if (!inboxId) {
    throw new Error('AGENTMAIL_INBOX_ID environment variable is not set');
  }
  return inboxId;
}
