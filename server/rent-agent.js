import { google } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const MAX_TENANTS = 100;
const MAX_RECENT_MONTHS = 3;
const AGENT_TIMEOUT_MS = 25_000;

export const RENT_AGENT_SYSTEM_PROMPT = `You are Rent Agent for a hostel owner. You receive a JSON list of OVERDUE tenants only. Ranking is already decided by the server.

Rules:
1. Use only facts in the provided data. Never invent why someone is late.
2. Do no money arithmetic. Quote amounts and months exactly as given.
3. For each tenant, write a two-sentence explanation citing only months and amounts in recentMonths. If no relevant detail is present, say so.
4. Write a short, polite, factual reminder with no threats, fees, or invented deadlines; sign it with hostelName.
5. Keep the same order and tenantIds you received. Do not add or drop tenants.
6. proposedAction.amount must exactly match outstandingAmount as a string with two decimal places.
7. Reply with JSON only, matching the schema exactly.`;

const modelOutputSchema = z.object({
  summary: z.string().max(500),
  cases: z.array(z.object({
    tenantId: z.string(),
    rank: z.number().int().positive(),
    explanation: z.string().max(1000),
    draftReminder: z.string().max(1000),
    proposedAction: z.object({
      type: z.literal('collect_rent'),
      amount: z.string(),
      currency: z.string(),
      description: z.string().max(240),
    }),
  })),
});

const monthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  rentDue: z.number().finite().nonnegative(),
  amountPaid: z.number().finite().nonnegative(),
  outstandingAmount: z.number().finite().nonnegative(),
  status: z.enum(['paid', 'partial', 'unpaid']),
});

const tenantSchema = z.object({
  tenantId: z.string().min(1).max(128),
  fullName: z.string().min(1).max(120),
  floor: z.string().max(80),
  room: z.string().max(80),
  monthlyRent: z.number().finite().nonnegative(),
  outstandingAmount: z.number().finite().nonnegative(),
  monthsOverdue: z.number().int().nonnegative(),
  recentMonths: z.array(monthSchema).max(MAX_RECENT_MONTHS),
});

const snapshotSchema = z.object({
  hostelName: z.string().min(1).max(120),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.literal('USD').optional(),
  tenants: z.array(tenantSchema).max(MAX_TENANTS),
});

function money(value) {
  return value.toFixed(2);
}

function displayMonth(month) {
  const [year, monthNumber] = month.split('-');
  const date = new Date(Date.UTC(Number(year), Number(monthNumber) - 1, 1));
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function templateExplanation(tenant) {
  const recent = tenant.recentMonths.filter((month) => month.outstandingAmount > 0);
  if (recent.length === 0) {
    return `The snapshot records ${money(tenant.outstandingAmount)} outstanding across ${tenant.monthsOverdue} overdue month(s). Recent-month detail for this balance is not present in the snapshot.`;
  }
  const evidence = recent.map((month) =>
    `${displayMonth(month.month)}: ${money(month.outstandingAmount)} outstanding of ${money(month.rentDue)} rent due`,
  ).join('; ');
  return `The snapshot records ${money(tenant.outstandingAmount)} outstanding across ${tenant.monthsOverdue} overdue month(s). Recent months show ${evidence}.`;
}

function templateReminder(tenant, hostelName) {
  return `Hello ${tenant.fullName}, our records show ${money(tenant.outstandingAmount)} in rent outstanding across ${tenant.monthsOverdue} month(s). Please contact us if you have already paid or would like to discuss this balance. — ${hostelName}`;
}

function makeFallback(tenants, snapshot) {
  return {
    summary: tenants.length
      ? `${tenants.length} overdue tenant(s). Highest priority first.`
      : 'No overdue tenants.',
    cases: tenants.map((tenant, index) => ({
      tenantId: tenant.tenantId,
      rank: index + 1,
      explanation: templateExplanation(tenant),
      draftReminder: templateReminder(tenant, snapshot.hostelName),
      proposedAction: {
        type: 'collect_rent',
        amount: money(tenant.outstandingAmount),
        currency: snapshot.currency ?? 'USD',
        description: `Collect rent from ${tenant.fullName} (${tenant.room})`,
      },
    })),
  };
}

function cleanModelResult(raw, rankedTenants, snapshot) {
  const parsed = modelOutputSchema.parse(raw);
  const byId = new Map(parsed.cases.map((agentCase) => [agentCase.tenantId, agentCase]));
  const fallback = makeFallback(rankedTenants, snapshot);

  return {
    summary: parsed.summary.trim() || fallback.summary,
    cases: rankedTenants.map((tenant, index) => {
      const generated = byId.get(tenant.tenantId);
      const base = fallback.cases[index];
      return {
        ...base,
        explanation: generated?.explanation.trim() || base.explanation,
        draftReminder: generated?.draftReminder.trim() || base.draftReminder,
        proposedAction: {
          ...base.proposedAction,
          description: generated?.proposedAction.description.trim() || base.proposedAction.description,
        },
      };
    }),
  };
}

async function generateGeminiProse(input) {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('Missing GOOGLE_GENERATIVE_AI_API_KEY');
  }
  const modelId = process.env.GOOGLE_GENERATIVE_AI_MODEL || 'gemini-3.6-flash';
  const result = await generateText({
    model: google(modelId),
    system: RENT_AGENT_SYSTEM_PROMPT,
    prompt: JSON.stringify(input),
    output: Output.object({ schema: modelOutputSchema }),
    maxOutputTokens: 4000,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
  return result.output;
}

export async function analyzeRentSnapshot(rawSnapshot, generate = generateGeminiProse) {
  const snapshot = snapshotSchema.parse(rawSnapshot);
  if (new Set(snapshot.tenants.map((tenant) => tenant.tenantId)).size !== snapshot.tenants.length) {
    throw new Error('Snapshot tenant IDs must be unique.');
  }

  const overdue = snapshot.tenants
    .filter((tenant) => tenant.outstandingAmount > 0)
    .map((tenant, index) => ({ tenant, index }))
    .sort((left, right) =>
      right.tenant.monthsOverdue - left.tenant.monthsOverdue
      || right.tenant.outstandingAmount - left.tenant.outstandingAmount
      || left.index - right.index,
    )
    .map(({ tenant }) => tenant);

  if (overdue.length === 0) {
    return { source: 'rules', summary: 'No overdue tenants.', cases: [] };
  }

  const fallback = makeFallback(overdue, snapshot);
  const modelInput = {
    hostelName: snapshot.hostelName,
    asOf: snapshot.asOf,
    currency: snapshot.currency ?? 'USD',
    tenants: overdue.map((tenant, index) => ({
      rank: index + 1,
      tenantId: tenant.tenantId,
      fullName: tenant.fullName,
      floor: tenant.floor,
      room: tenant.room,
      outstandingAmount: money(tenant.outstandingAmount),
      monthsOverdue: tenant.monthsOverdue,
      recentMonths: tenant.recentMonths,
    })),
  };

  try {
    const raw = await generate(modelInput);
    return { source: 'gemini', ...cleanModelResult(raw, overdue, snapshot) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown model error';
    console.warn(`Rent Agent model unavailable; using rules fallback: ${message}`);
    return {
      source: 'rules_fallback',
      ...fallback,
      warning: 'Model unavailable; used template text.',
    };
  }
}
