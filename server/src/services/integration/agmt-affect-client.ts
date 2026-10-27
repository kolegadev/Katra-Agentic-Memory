/**
 * AGMT affect-lane client — pin a wave signature into the acoustic store.
 *
 * The lane lives in the AGMT lite service (`agmt_affect_write`, `agmt_affect_search`,
 * `agmt_affect_stats`) and is OPT-IN there too: `AGMT_AFFECT=1` on that service, or every call is an
 * unknown tool. This client mirrors that: it does nothing unless `KATRA_AFFECT_ENABLED=1`, and a
 * failure never reaches the caller — a memory write must not fail because the wave store is down.
 *
 * The transport is the MCP front's JSON-RPC over HTTP, the same shape the autonomous action pipeline
 * already uses against this server's own endpoint.
 */

export interface AgmtAffectConfig {
  url: string;
  token: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface AgmtAffectResult {
  ok: boolean;
  externalId?: string;
  code?: string;
  detail?: string;
  latencyMs?: number;
}

const DEFAULT_TIMEOUT_MS = 800;

export function agmtAffectConfig(): AgmtAffectConfig {
  return {
    url: (process.env.AGMT_AFFECT_URL || 'http://100.101.206.13:9110').replace(/\/+$/, ''),
    token: process.env.AGMT_AFFECT_TOKEN || '',
    enabled: String(process.env.KATRA_AFFECT_ENABLED || '0') === '1'
      && String(process.env.AGMT_AFFECT_LANE || '1') === '1',
    timeoutMs: Number(process.env.AGMT_AFFECT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

async function callTool(name: string, args: Record<string, unknown>,
                        config: AgmtAffectConfig): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const response = await fetch(`${config.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
      signal: controller.signal,
    });
    const text = await response.text();
    // The front answers JSON in its response mode, but a proxy may prepend an SSE frame.
    const match = /data: (\{.*\})/.exec(text);
    const payload = match ? JSON.parse(match[1]) : JSON.parse(text);
    if (payload?.error) throw new Error(`${payload.error.code}: ${payload.error.message}`);
    const result = payload?.result;
    if (result?.isError) throw new Error(String(result?.content?.[0]?.text || 'tool error'));
    return result?.structuredContent ?? result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pin one memory's affect signature. Idempotent per `externalId` in the sense that matters: the lane
 * is append-only and the newest row wins, so a retry is a re-pin, never a duplicate memory.
 */
export async function pinAffect(externalId: string, signature: Record<string, unknown>,
                                scope: { user_id?: string; shared_id?: string } = {},
                                config: AgmtAffectConfig = agmtAffectConfig()): Promise<AgmtAffectResult> {
  if (!config.enabled) return { ok: false, code: 'disabled' };
  if (!externalId) return { ok: false, code: 'no_external_id' };
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await callTool('agmt_affect_write', {
        external_id: externalId,
        state: signature,
        user_id: scope.user_id || '',
        shared_id: scope.shared_id || '',
        actor: 'affect-engine',
      }, config);
      if (result?.ok === false) {
        return { ok: false, code: 'lane_refused', detail: String(result?.error || ''),
                 latencyMs: Date.now() - started };
      }
      return { ok: true, externalId, latencyMs: Date.now() - started };
    } catch (error: any) {
      const aborted = error?.name === 'AbortError';
      if (attempt === 1) {
        return {
          ok: false,
          code: aborted ? 'timeout' : 'unreachable',
          detail: String(error?.message || error).slice(0, 200),
          latencyMs: Date.now() - started,
        };
      }
    }
  }
  return { ok: false, code: 'unknown', latencyMs: Date.now() - started };
}

/** The lane's own inventory, or a named failure. Never throws. */
export async function affectLaneStats(config: AgmtAffectConfig = agmtAffectConfig()):
  Promise<{ ok: boolean; stats?: any; code?: string }> {
  if (!config.enabled) return { ok: false, code: 'disabled' };
  try {
    const stats = await callTool('agmt_affect_stats', {}, config);
    return { ok: stats?.ok !== false, stats };
  } catch (error: any) {
    return { ok: false, code: String(error?.message || error).slice(0, 120) };
  }
}

export interface AffectHit {
  external_id: string;
  resonance: number;
  user_id: string;
  shared_id: string;
  at: number;
  state: { bands: Record<string, number>; valence: number; arousal: number };
}

export interface AffectSearchResult {
  ok: boolean;
  hits: AffectHit[];
  scored: number;
  admitted: number;
  seconds?: number;
  floor?: number;
  code?: string;
}

/**
 * Ask the lane which memories resonate with a state — NO TEXT.
 *
 * This is the whole capability in one call: the query is a state, the answer is a set of memory ids.
 * The floor is the store's measured default (0.90) unless the caller passes one; passing 0 turns the
 * lane back into a pure ranker, which is a legitimate use and is reported as such by the payload.
 */
export async function affectSearch(state: Record<string, unknown>, options: {
  k?: number; identity?: string; minResonance?: number; includeInterference?: boolean;
} = {}, config: AgmtAffectConfig = agmtAffectConfig()): Promise<AffectSearchResult> {
  if (!config.enabled) {
    return { ok: false, hits: [], scored: 0, admitted: 0, code: 'disabled' };
  }
  try {
    const result = await callTool('agmt_affect_search', {
      state,
      k: options.k ?? 5,
      identity: options.identity || '',
      ...(options.minResonance === undefined ? {} : { min_resonance: options.minResonance }),
      include_interference: options.includeInterference ?? false,
    }, config);
    if (result?.ok === false) {
      return { ok: false, hits: [], scored: 0, admitted: 0,
               code: String(result?.error || 'lane_refused').slice(0, 120) };
    }
    return {
      ok: true,
      hits: Array.isArray(result?.hits) ? result.hits as AffectHit[] : [],
      scored: Number(result?.scored) || 0,
      admitted: Number(result?.admitted) || 0,
      seconds: Number(result?.seconds) || 0,
      floor: Number(result?.min_resonance),
    };
  } catch (error: any) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, hits: [], scored: 0, admitted: 0,
             code: `${aborted ? 'timeout' : 'unreachable'}: ${String(error?.message || error).slice(0, 120)}` };
  }
}
