import {
  enqueueTelemetry,
  getTelemetryQueue,
  updateTelemetryQueueItem,
  deleteTelemetryQueueItem,
} from './storage.js';

const ENDPOINT = 'https://nxfgnaztkjecflzhfcgo.supabase.co/functions/v1/ingest-okey-game';
const APP_VERSION = '0.6.0';
const SOLVER_VERSION = 'mc-seeded-v2';

function unseenCount(before) {
  return 24 - new Set([...(before?.hand || []), ...(before?.used || [])]).size;
}

export function buildTelemetryPayload(game) {
  const turns = (game.turns || []).map((turn, index) => ({
    turn_number: index + 1,
    score_before: Number(turn.before?.score || 0),
    score_after: Number(turn.before?.score || 0) + Number(turn.points || 0),
    hand_before: [...(turn.before?.hand || [])],
    used_cards: [...(turn.before?.used || [])],
    unseen_count: unseenCount(turn.before),
    recommended_action: turn.recommended,
    recommended_ev: Number(turn.recommendedEV || 0),
    alternatives: (turn.ranking || []).slice(1),
    chosen_action: turn.chosen,
    chosen_ev: Number(turn.chosenEV || 0),
    decision_regret: Number(turn.regret || 0),
    drawn_cards: [...(turn.draws || [])],
    points_awarded: Number(turn.points || 0),
    compute_time_ms: turn.computeTimeMs == null ? null : Number(turn.computeTimeMs),
    solver_seed: turn.solverSeed || null,
    state_hash: null,
  }));

  const modes = [...new Set(turns.length ? (game.turns || []).map(t => t.solverMode).filter(Boolean) : [])];
  const simulations = (game.turns || []).map(t => Number(t.simulationCount || 0));
  const start = new Date(game.startedAt).getTime();
  const end = game.endedAt ? new Date(game.endedAt).getTime() : Date.now();

  return {
    game: {
      client_game_id: game.id,
      schema_version: 1,
      app_version: APP_VERSION,
      solver_version: SOLVER_VERSION,
      solver_mode: modes.length === 1 ? modes[0] : modes.length > 1 ? 'mixed' : 'unknown',
      simulation_count: simulations.length ? Math.max(...simulations) : 0,
      started_at: game.startedAt,
      finished_at: game.endedAt || null,
      final_score: Number(game.score || 0),
      turn_count: turns.length,
      status: game.status === 'completed' ? 'completed' : 'abandoned',
      duration_ms: Number.isFinite(end - start) ? Math.max(0, Math.round(end - start)) : null,
      telemetry_version: '1',
      metadata: {
        solver_modes_used: modes,
      },
    },
    turns,
  };
}

async function upload(payload) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Version': APP_VERSION,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Telemetry upload failed (${response.status}) ${text}`.trim());
  }
  return response.json().catch(() => ({ ok: true }));
}

export async function queueGameTelemetry(game) {
  if (!game?.id || !game?.turns?.length) return;
  const payload = buildTelemetryPayload(game);
  await enqueueTelemetry(game.id, payload);
}

export async function flushTelemetryQueue() {
  if (!navigator.onLine) return { uploaded: 0, pending: (await getTelemetryQueue()).length };
  const queue = await getTelemetryQueue();
  let uploaded = 0;

  for (const item of queue) {
    try {
      await upload(item.payload);
      await deleteTelemetryQueueItem(item.id);
      uploaded++;
    } catch (error) {
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastAttemptAt = new Date().toISOString();
      item.lastError = error?.message || String(error);
      await updateTelemetryQueueItem(item);
    }
  }

  return { uploaded, pending: (await getTelemetryQueue()).length };
}
