// MCP tool call telemetry schema.

import { pgTable, serial, varchar, text, timestamp, integer, bigint, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { clients } from './sites';

// ─── MCP tool call telemetry ────────────────────────────────────────────────
//
// Per-call audit log of every tool invocation through the in-repo MCP server.
// Captures size + duration + tokens so we can spot expensive tools, blast
// radius on errors, and rank-order callers. Raw events have a 14-day TTL via
// the mcp-cleanup cron; anything older lives only in the daily rollup table
// below (kept forever).
//
// Token estimation is content-aware (JSON ~3.0 chars/tok, hex/UUID ~2.0,
// CJK ~1.0) but still an estimate — async reconciliation against Claude's
// count_tokens API self-tunes coefficients.

export const mcpToolCalls = pgTable('mcp_tool_calls', {
  id: serial('id').primaryKey(),
  clientId: integer('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  // POLYMORPHIC: portal_api_keys.id OR oauth_access_tokens.id, disambiguated by
  // `credential_kind`. The old FK to portal_api_keys meant every OAuth-authenticated
  // tool call failed this insert — and because logToolCall swallows errors, ALL
  // OAuth telemetry was silently dropped rather than reported (QAD-048 id spaces).
  apiKeyId: integer('api_key_id'),
  credentialKind: varchar('credential_kind', { length: 20 }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  toolName: varchar('tool_name', { length: 100 }).notNull(),
  requestBytes: integer('request_bytes').default(0).notNull(),
  responseBytes: integer('response_bytes').default(0).notNull(),
  estimatedTokens: integer('estimated_tokens').default(0).notNull(),
  durationMs: integer('duration_ms').default(0).notNull(),
  success: boolean('success').default(true).notNull(),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('mcp_tool_calls_client_created_idx').on(t.clientId, t.createdAt),
  index('mcp_tool_calls_tool_created_idx').on(t.toolName, t.createdAt),
]);

// Daily aggregates of mcp_tool_calls. Persisted forever; raw events table has
// a 14-day TTL. Re-runnable via UPSERT on (day, client_id, tool_name).
// p95_* columns use percentile_cont(0.95) — friction signal (avg drowns in
// the cheap-tool count, max overstates).
export const mcpToolCallDailyRollups = pgTable('mcp_tool_call_daily_rollups', {
  id: serial('id').primaryKey(),
  day: timestamp('day', { mode: 'date' }).notNull(),
  clientId: integer('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  toolName: varchar('tool_name', { length: 100 }).notNull(),
  callCount: integer('call_count').default(0).notNull(),
  successCount: integer('success_count').default(0).notNull(),
  errorCount: integer('error_count').default(0).notNull(),
  // bigint: per-day accumulators sum across every call for a (client, tool);
  // a busy tool overflows int4 (~2.1B) over long windows. mode:'number' keeps
  // the JS surface a number (safe < 2^53) so rollup/usage-stats need no change.
  totalRequestBytes: bigint('total_request_bytes', { mode: 'number' }).default(0).notNull(),
  totalResponseBytes: bigint('total_response_bytes', { mode: 'number' }).default(0).notNull(),
  totalEstimatedTokens: bigint('total_estimated_tokens', { mode: 'number' }).default(0).notNull(),
  totalDurationMs: bigint('total_duration_ms', { mode: 'number' }).default(0).notNull(),
  p95ResponseBytes: integer('p95_response_bytes').default(0).notNull(),
  p95EstimatedTokens: integer('p95_estimated_tokens').default(0).notNull(),
  p95DurationMs: integer('p95_duration_ms').default(0).notNull(),
  maxResponseBytes: integer('max_response_bytes').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('mcp_rollups_day_client_tool_uq').on(t.day, t.clientId, t.toolName),
  index('mcp_rollups_day_idx').on(t.day),
  index('mcp_rollups_client_day_idx').on(t.clientId, t.day),
]);
