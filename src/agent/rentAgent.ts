import type { AgentSnapshot } from './snapshot';
import { ownerRequest } from './rentOrders';

export type RentAgentCase = {
  tenantId: string;
  rank: number;
  explanation: string;
  draftReminder: string;
  proposedAction: {
    type: 'collect_rent';
    amount: string;
    currency: string;
    description: string;
  };
};

export type RentAgentResult = {
  source: 'gemini' | 'rules_fallback' | 'rules';
  summary: string;
  cases: RentAgentCase[];
  reason?: 'missing_key' | 'timeout' | 'model_error';
  warning?: string;
};

export function analyzeRentAgent(snapshot: AgentSnapshot) {
  return ownerRequest<RentAgentResult>('/api/agent/analyze', { snapshot });
}
