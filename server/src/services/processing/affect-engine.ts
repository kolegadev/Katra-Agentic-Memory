/**
 * Affect Engine — the streaming affective state (the "feelings engine")
 *
 * A continuous six-band state with inertia and decay, pinned to the memory writes it accompanies
 * and readable by the agent that owns it. It sits in the CORE, not behind an MCP tool the model has
 * to remember to call: an emotion that only exists when someone asks for it is not a state, it is a
 * label. The engine observes what already flows through the server — ingested content, tool
 * successes and failures, ingestion anomalies — and a bounded self-report is the only voluntary door.
 *
 * The bands and the formulas are the ones published in the design note and implemented in AGMT's
 * storage lane (`agmt/affect.py`), so a state computed here and a state read back from the wave store
 * mean the same thing:
 *
 *   faa        = ln(alpha_r) - ln(alpha_l)
 *   valence    = tanh(faa / 1.2)
 *   arousal    = 0.5 + 0.5*tanh(GAIN * (beta+gamma - base) / side)   # side = the reachable
 *                distance on that side: base below the baseline, SUM_MAX - base above it
 *   entropy    = -Σ p ln p over the normalised bands;  intensity = 1 - entropy/ln 6
 *
 * Dynamics are a leaky integrator integrated LAZILY: every read or observation advances the state by
 * the elapsed time first. There is no timer — a timer dies with the process, and a state that freezes
 * is exactly the failure the design note warns about. A restart resumes the curve because
 * `last_update` is persisted.
 *
 * Nothing here is claimed as an EEG. The bands are a compact, interpretable encoding of an
 * approach/avoidance reading and an activation reading; the wave store renders them into a spectral
 * object because that is the store's native form.
 */

import { get_database } from '../../database/connection.js';
import { ValenceTagger } from './valence-tagger.js';

export const AFFECT_ENGINE_VERSION = 'katra-affect-1';

export const AFFECT_BANDS = ['delta', 'theta', 'alpha_l', 'alpha_r', 'beta', 'gamma'] as const;
export type AffectBand = (typeof AFFECT_BANDS)[number];
export type AffectBands = Record<AffectBand, number>;

/** The resting attractor the state decays toward — the design note's baseline. */
export const AFFECT_BASELINE: AffectBands = {
  delta: 1.0, theta: 1.0, alpha_l: 2.0, alpha_r: 2.0, beta: 0.5, gamma: 0.2,
};

/** Decay per band, per second. Fast bands recover in ~1 minute; mood bands in ~20-30. */
export const AFFECT_DECAY: AffectBands = {
  delta: 0.0008, theta: 0.0015, alpha_l: 0.002, alpha_r: 0.002, beta: 0.02, gamma: 0.05,
};

const BAND_FLOOR = 0.05;
const BAND_CEILING = 6.0;
const SHOCK_MAX_NORM = 2.0;
const FAA_SCALE = 1.2;

/**
 * Arousal: one gain, applied to each side's own reachable distance (see `arousalOf`).
 *
 * The first reading divided the excess over baseline by the BASELINE SUM, which made one baseline sum
 * of distance the whole usable range. The bands can legitimately reach about five times that, so
 * measured on the live lane on 2026-10-26: 11 of 16 pins read above 0.95, a busy working day
 * (beta+gamma 1.16) read 0.79, and the calm fixture read 0.34 — the top of the scale was where
 * everything lived and "calm" was unreachable (floor 0.119, not 0).
 */
export const AFFECT_AROUSAL_GAIN = 2.0;

/**
 * The highest beta+gamma the integrator can reach at the DEFAULT baseline:
 * beta <= 0.5 + max(3*0.5, 1.5) = 2.0 and gamma <= 0.2 + max(3*0.2, 1.5) = 1.7.
 * Published because the arousal readout is normalised against it.
 */
export const AFFECT_AROUSAL_SUM_MAX = 3.7;

/**
 * The success channel is bounded (AFFECT-5).
 *
 * A successful tool call is evidence that the agent is WORKING, not that it is aroused — and it is by
 * far the highest-volume channel. Measured live on 2026-10-26: 1111 successes against 18 memories
 * written (62:1), and a brute-force campaign held beta at its clamp and arousal at 0.95 for hours,
 * where "working hard" and "alarmed" read the same. Two bounds fix the asymmetry:
 *
 *   * a GAIN below 1 keeps a success's impulse quiet, and
 *   * a CAP stops the success channel lifting beta+gamma more than `CAP_OFFSET` above the baseline,
 *     whatever the volume.
 *
 * Failures, anomalies and content keep full authority, so alarm stays reachable: a failure should
 * alarm, a thousand greps should not.
 */
export const AFFECT_SUCCESS_GAIN = 0.35;
export const AFFECT_SUCCESS_CAP_OFFSET = 0.5;

/**
 * A state key: the identity, optionally scoped to a context (`agent#sentry-cwe`).
 *
 * The state was per identity, and an identity is not a project: a campaign running on an agent's
 * behalf voted in the same election as the session that was thinking, and volume won. A context
 * gives a caller its own state without a second collection or a schema migration — the key is just
 * another `user_id` value, so the existing unique index still holds one document per key.
 */
export function stateKey(identity: string, context?: string | null): string {
  const base = String(identity ?? '').trim();
  const scope = String(context ?? '').trim();
  return scope ? `${base}#${scope}` : base;
}

/** The identity part of a state key. */
export function baseIdentityOf(key: string): string {
  const text = String(key ?? '');
  const index = text.indexOf('#');
  return index === -1 ? text : text.slice(0, index);
}

/** The context part of a state key, or null when there is none. */
export function contextOf(key: string): string | null {
  const text = String(key ?? '');
  const index = text.indexOf('#');
  return index === -1 ? null : text.slice(index + 1);
}
const TRAIL_MAX = 200;
const PERSIST_MIN_INTERVAL_MS = 1000;

export type AffectStimulusSource = 'content' | 'tool_success' | 'tool_failure' | 'anomaly' | 'self_report';

export interface AffectStimulus {
  /** -1 (negative) .. +1 (positive) */
  valence: number;
  /** 0 (calm) .. 1 (activated) */
  arousal: number;
  /** How much authority this source has over the state (content 1.0, self-report 0.35). */
  weight: number;
  source: AffectStimulusSource;
  detail?: string;
  /**
   * How much this stimulus speaks to the CALM band (theta). Content does — a calm sentence raises
   * theta. An outcome does not: a successful call is not a calm statement about the world, and
   * letting it drive theta integrated to 3.3x baseline over a hundred successes (measured live).
   */
  theta_weight?: number;
  /** Scales the beta/gamma (activation) part of the impulse. Successes run at a fraction of 1. */
  arousal_gain?: number;
  /** Scales the alpha (valence) part of the impulse. */
  valence_gain?: number;
  /**
   * How far above the identity's baseline this channel may lift beta+gamma, whatever the volume.
   * Only the success channel sets it: volume must not be able to masquerade as alarm.
   */
  arousal_cap_offset?: number;
  /** Who produced this observation (a session, a job, a process). Defaults to the channel name. */
  source_id?: string;
  /** Attribution scope: a campaign or project getting its own state instead of the identity's. */
  context?: string;
}

export interface AffectPoint {
  at: string;
  bands: AffectBands;
  valence: number;
  arousal: number;
}

export interface AffectStateSnapshot {
  enabled: boolean;
  identity: string;
  engine: string;
  bands: AffectBands;
  baseline: AffectBands;
  faa: number;
  valence: number;
  arousal: number;
  entropy: number;
  intensity: number;
  felt: string;
  at: string;
  age_seconds: number;
  stale: boolean;
  observations: number;
  trail: AffectPoint[];
  sources: Partial<Record<AffectStimulusSource, number>>;
  /** The attribution scope, when this state belongs to a campaign rather than the identity. */
  context?: string | null;
  /** Who has been moving this state, most observations first. */
  contributors?: Record<string, { observations: number; successes: number; lastAt: number }>;
}

interface UserAffect {
  bands: AffectBands;
  baseline: AffectBands;
  lastUpdate: number;
  observations: number;
  sources: Partial<Record<AffectStimulusSource, number>>;
  trail: AffectPoint[];
  lastPersist: number;
  dirty: boolean;
  /** Timestamps of recent successful calls PER SOURCE, for habituation (see `habituation`). */
  successWindows: Record<string, number[]>;
  /** Who has been moving this state: observations and successes per source, newest last. */
  contributors: Record<string, { observations: number; successes: number; lastAt: number }>;
  /** True while a trailing flush is scheduled, so a burst schedules exactly one. */
  flushScheduled?: boolean;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

const floorOf = (value: number): number => (Number.isFinite(value) ? Math.max(value, 1e-9) : 1e-9);

/**
 * Arousal from the fast bands, normalised per side by the range that side can actually reach.
 *
 *   arousal = 0.5 + 0.5*tanh( GAIN * (beta+gamma - base) / side )
 *   side    = base                  when beta+gamma <= base   (down to a band sum of 0)
 *           = SUM_MAX - base        when beta+gamma >  base   (up to the integrator's ceiling)
 *
 * baseline -> exactly 0.5; a band sum of 0 -> 0.018; the ceiling -> 0.982. Monotone, continuous at
 * the baseline, and invertible, so a reader can recover the band sum from the number.
 */
export function arousalOf(beta: number, gamma: number): number {
  const base = AFFECT_BASELINE.beta + AFFECT_BASELINE.gamma;
  const total = beta + gamma;
  const side = total <= base ? base : AFFECT_AROUSAL_SUM_MAX - base;
  return clamp(0.5 + 0.5 * Math.tanh((AFFECT_AROUSAL_GAIN * (total - base)) / side), 0, 1);
}

/** The published derivations. Exported so a test can pin them against the storage lane's. */
export function deriveAffect(bands: AffectBands): {
  faa: number; valence: number; arousal: number; entropy: number; intensity: number; felt: string;
} {
  const faa = Math.log(floorOf(bands.alpha_r)) - Math.log(floorOf(bands.alpha_l));
  const total = AFFECT_BANDS.reduce((sum, band) => sum + Math.max(bands[band], 0), 0) || 1e-9;
  let entropy = 0;
  for (const band of AFFECT_BANDS) {
    const share = Math.max(bands[band], 0) / total;
    if (share > 0) entropy -= share * Math.log(share);
  }
  const arousal = arousalOf(bands.beta, bands.gamma);
  const valence = Math.tanh(faa / FAA_SCALE);
  const intensity = clamp(1 - entropy / Math.log(AFFECT_BANDS.length), 0, 1);
  return { faa, valence, arousal, entropy, intensity, felt: feltLabel(valence, arousal) };
}

/** tanh's inverse, written out rather than taken from the platform (lib targets vary). */
const atanh = (value: number): number => 0.5 * Math.log((1 + value) / (1 - value));

/**
 * The lowest arousal the readout can express: a band sum of 0 gives 0.5 - 0.5*tanh(GAIN) = 0.018.
 * A report asking for calmer than this asks for a state the readout cannot name, so the target is
 * clamped here rather than promising something that will never appear.
 */
export const AFFECT_AROUSAL_FLOOR = clamp(0.5 - 0.5 * Math.tanh(AFFECT_AROUSAL_GAIN), 0, 1);

/**
 * The inverse of `arousalOf`, restricted to a band SUM: the sum a report asks for when it names an
 * arousal. The beta:gamma split is not something a report can speak to, so it is not solved here.
 */
export function arousalTargetSum(arousal: number): number {
  const base = AFFECT_BASELINE.beta + AFFECT_BASELINE.gamma;
  const wanted = clamp(Number(arousal) || 0, AFFECT_AROUSAL_FLOOR, 0.999);
  const scaled = atanh(2 * wanted - 1) / AFFECT_AROUSAL_GAIN;
  const side = wanted <= 0.5 ? base : AFFECT_AROUSAL_SUM_MAX - base;
  return Math.max(base + scaled * side, 0);
}

/**
 * The band vector a self-report aims at.
 *
 * A report supplies two numbers, so it may constrain exactly two degrees of freedom: the alpha
 * RATIO (which is what valence reads) and the beta+gamma SUM (which is what arousal reads). The
 * other four are held where they are, because a report says nothing about theta, delta or the
 * beta:gamma split — inventing values for them is how the additive version turned "I am calm" into
 * "arousal 0.95".
 *
 * Solved against the published readouts instead of approximated:
 *   valence = tanh(faa / 1.2)   -> faa = atanh(valence) * 1.2
 *   arousal = arousalOf(b, g)   -> b+g = arousalTargetSum(arousal)
 * The alpha pair keeps its SUM and takes the reported RATIO; the beta/gamma pair keeps its SHARE of
 * the current split and takes the reported SUM. Both are exact inverses of `deriveAffect`, so the
 * target provably reads back as the state the report asked for.
 */
export function selfReportTarget(bands: AffectBands, valence: number, arousal: number): AffectBands {
  const wanted = clamp(Number(valence) || 0, -0.999, 0.999);
  const activation = clamp(Number(arousal) || 0, AFFECT_AROUSAL_FLOOR, 0.999);
  const ratio = Math.exp(atanh(wanted) * FAA_SCALE);
  const alphaSum = Math.max(bands.alpha_l + bands.alpha_r, 2 * BAND_FLOOR);
  const alphaRight = (alphaSum * ratio) / (1 + ratio);
  const base = AFFECT_BASELINE.beta + AFFECT_BASELINE.gamma;
  const activated = arousalTargetSum(activation);
  const current = bands.beta + bands.gamma;
  const share = current > 0 ? bands.gamma / current : AFFECT_BASELINE.gamma / base;
  return {
    delta: bands.delta,
    theta: bands.theta,
    alpha_l: alphaSum - alphaRight,
    alpha_r: alphaRight,
    beta: activated * (1 - share),
    gamma: activated * share,
  };
}

/** A rendering label. Never the stored truth: the stored truth is the band vector. */
export function feltLabel(valence: number, arousal: number): string {
  if (arousal >= 0.6) {
    // 'frustrated' and 'alarmed' have to mean something negative. Measured live: a successful agent
    // in a fast tool loop sat at arousal 0.86 with valence -0.10 and was being labelled 'frustrated',
    // which is exactly the kind of label that makes the whole feature untrustworthy. Engaged-but-
    // neutral is 'focused'; only a sustained negative reading escalates.
    if (valence <= -0.6) return 'alarmed';
    if (valence <= -0.2) return 'frustrated';
    return 'focused';
  }
  if (valence >= 0.15) return 'satisfied';
  if (valence <= -0.15) return 'flat';
  return 'steady';
}

function readIdentities(): string[] {
  return (process.env.KATRA_AFFECT_IDENTITIES || '')
    .split(',').map(name => name.trim()).filter(Boolean);
}

export class AffectEngine {
  private static instance: AffectEngine;
  private users = new Map<string, UserAffect>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private selfReportAt = new Map<string, number>();

  private constructor() {}

  static get_instance(): AffectEngine {
    if (!AffectEngine.instance) AffectEngine.instance = new AffectEngine();
    return AffectEngine.instance;
  }

  /** The engine is on only when enabled AND the identity is allowlisted. */
  isEnabled(identity?: string): boolean {
    if (String(process.env.KATRA_AFFECT_ENABLED || '0') !== '1') return false;
    if (!identity) return true;
    const allowed = readIdentities();
    // A scoped key (`agent#sentry-cwe`) is enabled when its identity is, so adding a context never
    // requires a new allow-list entry; an entry may also name the scoped key explicitly.
    return allowed.includes(identity) || allowed.includes(baseIdentityOf(identity));
  }

  /**
   * Load one identity's persisted state. Lazy, idempotent, and SINGLE-FLIGHT.
   *
   * Single-flight is not a nicety. The first version marked the identity "loaded" *before* awaiting
   * the read, so two tool calls arriving together both built a fresh baseline state, the slower one
   * clobbering the other, and a persist could then write that fresh default over the durable row —
   * losing the agent's state on restart. Measured: a restart plus one call left `observations: 1`
   * against a durable 13. Every concurrent caller now awaits the same promise, and `loaded` is only
   * set once the read has actually completed.
   */
  async initialize(identity: string): Promise<void> {
    if (this.loaded.has(identity)) return;
    const inFlight = this.loading.get(identity);
    if (inFlight) return inFlight;
    const promise = this.load(identity).finally(() => this.loading.delete(identity));
    this.loading.set(identity, promise);
    return promise;
  }

  private async load(identity: string): Promise<void> {
    try {
      const db = get_database();
      if (!db) {
        this.loaded.add(identity);
        return;
      }
      const row = await db.collection('affect_state').findOne({ user_id: identity });
      if (row) {
        const bands = this.coerceBands(row.bands);
        this.users.set(identity, {
          bands,
          baseline: this.coerceBands(row.baseline) || { ...AFFECT_BASELINE },
          lastUpdate: Number(row.last_update_ms) || Date.now(),
          observations: Number(row.observations) || 0,
          sources: (row.sources || {}) as UserAffect['sources'],
          trail: Array.isArray(row.trail) ? row.trail.slice(-TRAIL_MAX) : [],
          lastPersist: 0,
          dirty: false,
          successWindows: {},
          contributors: (row.contributors || {}) as UserAffect['contributors'],
        });
      }
      this.loaded.add(identity);
    } catch (error) {
      console.warn('[AffectEngine] initialize failed (state resets to baseline):', (error as Error)?.message);
      this.loaded.add(identity);
    }
  }

  private coerceBands(raw: any): AffectBands {
    const bands = { ...AFFECT_BASELINE };
    if (!raw || typeof raw !== 'object') return bands;
    for (const band of AFFECT_BANDS) {
      const value = Number(raw[band]);
      if (Number.isFinite(value)) bands[band] = clamp(value, BAND_FLOOR, BAND_CEILING);
    }
    return bands;
  }

  private state(identity: string): UserAffect {
    let state = this.users.get(identity);
    if (!state) {
      state = {
        bands: { ...AFFECT_BASELINE },
        baseline: { ...AFFECT_BASELINE },
        lastUpdate: Date.now(),
        observations: 0,
        sources: {},
        trail: [],
        lastPersist: 0,
        dirty: false,
        successWindows: {},
        contributors: {},
      };
      this.users.set(identity, state);
    }
    return state;
  }

  /** Advance the leaky integrator to `now`. Called before every read and every observation. */
  private decay(state: UserAffect, now: number): void {
    const seconds = Math.max(0, (now - state.lastUpdate) / 1000);
    state.lastUpdate = now;
    if (seconds <= 0) return;
    for (const band of AFFECT_BANDS) {
      const decay = Math.exp(-AFFECT_DECAY[band] * seconds);
      state.bands[band] = clamp(state.baseline[band] + (state.bands[band] - state.baseline[band]) * decay,
        BAND_FLOOR, BAND_CEILING);
    }
  }

  /**
   * Habituation for the success channel: the twentieth successful call in a minute is not news.
   *
   * Without this, a leaky integrator under a sustained success rate settles at `shock/γ` above the
   * baseline, which saturates beta and pins arousal at 1.0 for any agent that is simply working. That
   * was measured live (13 calls in 30 s -> arousal 0.97). The factor is 1/(1 + n/5): the fifth success
   * in a minute carries half weight, the tenth a third, and sustained work settles at a steady,
   * mildly-activated state instead of an alarm.
   */
  private habituation(state: UserAffect, sourceId: string, now: number): number {
    // Per SOURCE, not per identity: one flooding process habituates against its own window instead of
    // spending the identity's shared budget, so a thousand calls from a campaign cannot drown out a
    // session that made five. Many genuine sources still add up — that is load, and load should count.
    const window = (state.successWindows[sourceId] || []).filter(at => now - at < 60_000);
    window.push(now);
    state.successWindows[sourceId] = window;
    const seen = Object.entries(state.successWindows)
      .filter(([id]) => id !== sourceId)
      .map(([, times]) => times.filter(at => now - at < 60_000).length);
    if (seen.length > 24) {
      // Bound the bookkeeping: keep the wins that are still inside the window.
      for (const [id, times] of Object.entries(state.successWindows)) {
        const live = times.filter(at => now - at < 60_000);
        if (live.length === 0) delete state.successWindows[id];
      }
    }
    return 1 / (1 + window.length / 5);
  }

  /** One observation: decay, then the shock, with the shock's norm bounded. */
  async observe(identity: string, stimulus: AffectStimulus, context?: string | null):
    Promise<AffectStateSnapshot | null> {
    const key = stateKey(identity, context ?? stimulus.context ?? null);
    if (!this.isEnabled(key)) return null;
    await this.initialize(key);
    const state = this.state(key);
    const now = Date.now();
    this.decay(state, now);

    const sourceId = String(stimulus.source_id || stimulus.source || 'unknown');
    const habituated = stimulus.source === 'tool_success' ? this.habituation(state, sourceId, now) : 1;
    const bucket = state.contributors[sourceId] || { observations: 0, successes: 0, lastAt: 0 };
    bucket.observations += 1;
    if (stimulus.source === 'tool_success') bucket.successes += 1;
    bucket.lastAt = now;
    state.contributors[sourceId] = bucket;
    const weight = clamp(Number(stimulus.weight) || 0, 0, 1) * habituated;
    const valence = clamp(Number(stimulus.valence) || 0, -1, 1);
    const arousal = clamp(Number(stimulus.arousal) || 0, 0, 1);

    // Two kinds of input, two kinds of arithmetic.
    //
    // The ambient channels (content, outcomes, anomalies) report on something that HAPPENED, so they
    // add a bounded shock. A self-report asserts the RESULTING state, so it BLENDS toward the state
    // it names. As a shock it was one-way: beta (1.5a) and gamma (2a^2) only ever rise, and the calm
    // band, theta, is not in the arousal readout at all — so "I am calm" RAISED arousal. Measured
    // live on 2026-10-26: reporting 0.10 moved the readout 0.796 -> 0.822, and reporting 0.62 moved
    // it 0.779 -> 0.951. See `selfReportTarget`.
    let step: AffectBands;
    if (stimulus.source === 'self_report') {
      const target = selfReportTarget(state.bands, valence, arousal);
      step = { delta: 0, theta: 0, alpha_l: 0, alpha_r: 0, beta: 0, gamma: 0 };
      for (const band of AFFECT_BANDS) step[band] = weight * (target[band] - state.bands[band]);
    } else {
      const arousalGain = clamp(Number(stimulus.arousal_gain ?? 1), 0, 1);
      const valenceGain = clamp(Number(stimulus.valence_gain ?? 1), 0, 1);
      const shock: AffectBands = { delta: 0, theta: 0, alpha_l: 0, alpha_r: 0, beta: 0, gamma: 0 };
      shock.alpha_l -= 0.8 * valence * weight * valenceGain;
      shock.alpha_r += 0.8 * valence * weight * valenceGain;
      shock.beta += 1.5 * arousal * weight * arousalGain;
      shock.gamma += 2.0 * arousal * arousal * weight * arousalGain;
      shock.theta += 0.3 * (1 - arousal) * weight * (stimulus.theta_weight ?? 1);
      const norm = Math.sqrt(AFFECT_BANDS.reduce((sum, band) => sum + shock[band] ** 2, 0));
      const scale = norm > SHOCK_MAX_NORM ? SHOCK_MAX_NORM / norm : 1;
      for (const band of AFFECT_BANDS) shock[band] *= scale;

      // The cap: a channel may be bounded in how far it can lift activation, so that volume alone
      // cannot read as alarm. Applied to the impulse, never pulling the state down.
      const capOffset = stimulus.arousal_cap_offset;
      const lift = shock.beta + shock.gamma;
      if (capOffset !== undefined && lift > 0) {
        const baseSum = state.baseline.beta + state.baseline.gamma;
        const room = Math.max(0, baseSum + capOffset - (state.bands.beta + state.bands.gamma));
        if (lift > room) {
          const factor = room / lift;
          shock.beta *= factor;
          shock.gamma *= factor;
        }
      }
      step = shock;
    }
    for (const band of AFFECT_BANDS) {
      // No band may sit further than `span` from the baseline: repeated identical input must not run
      // a band away, whatever the stimulus mix. `span` is the larger of 3x the baseline and an
      // absolute 1.5 — a proportional rule alone (2x) put gamma's ceiling at 0.6 and a single strong
      // failure saturated it, which made "one failure" indistinguishable from "a mild one".
      const baseline = state.baseline[band];
      const span = Math.max(3 * baseline, 1.5);
      const low = Math.max(BAND_FLOOR, baseline - span);
      const high = Math.min(BAND_CEILING, baseline + span);
      state.bands[band] = clamp(state.bands[band] + step[band], low, high);
    }

    state.observations += 1;
    state.sources[stimulus.source] = (state.sources[stimulus.source] || 0) + 1;
    this.recordTrail(state, now);
    state.dirty = true;
    void this.persist(identity, state);
    return this.snapshotFor(identity, state);
  }

  /**
   * The one voluntary door. It BLENDS the state a third of the way toward what was reported (see
   * `selfReportTarget`), so it can correct drift in either direction but never commandeer the
   * state; and it is rate-limited so a burst of calls cannot stand in for a genuine change.
   */
  async recordSelfReport(identity: string, valence: number, arousal: number, note?: string,
    context?: string | null):
    Promise<{ accepted: boolean; reason?: string; state: AffectStateSnapshot | null }> {
    const key = stateKey(identity, context ?? null);
    if (!this.isEnabled(key)) {
      return { accepted: false, reason: 'the affect engine is off for this identity', state: null };
    }
    const now = Date.now();
    const last = this.selfReportAt.get(key) || 0;
    if (now - last < 60_000) {
      return {
        accepted: false,
        reason: `rate-limited: a self-report was taken ${Math.round((now - last) / 1000)}s ago (1 per 60s)`,
        state: await this.getState(identity),
      };
    }
    this.selfReportAt.set(key, now);
    const state = await this.observe(identity, {
      valence: clamp(Number(valence) || 0, -1, 1),
      arousal: clamp(Number(arousal) || 0, 0, 1),
      weight: 0.35,
      source: 'self_report',
      source_id: 'self_report',
      detail: note ? String(note).slice(0, 200) : undefined,
    }, context ?? null);
    return { accepted: true, state };
  }

  async getState(identity: string, context?: string | null): Promise<AffectStateSnapshot> {
    const key = stateKey(identity, context ?? null);
    const enabled = this.isEnabled(key);
    if (!enabled) return this.emptySnapshot(baseIdentityOf(key), false);
    await this.initialize(key);
    const state = this.state(key);
    this.decay(state, Date.now());
    return this.snapshotFor(key, state);
  }

  async getTrail(identity: string, limit = 20, context?: string | null): Promise<AffectPoint[]> {
    const key = stateKey(identity, context ?? null);
    if (!this.isEnabled(key)) return [];
    await this.initialize(key);
    const state = this.state(key);
    return state.trail.slice(-Math.max(1, Math.min(limit, TRAIL_MAX)));
  }

  /**
   * Nightly consolidation: the design note's REM model. The day's extremes are pulled halfway back
   * toward the baseline (desensitisation), the baseline is re-set to the day's median band vector
   * (homeostasis), and the trail is cleared. Nothing is invented: with no trail, nothing moves.
   */
  async consolidate(identity: string, context?: string | null):
    Promise<{ damped: boolean; baseline_moved: boolean }> {
    const key = stateKey(identity, context ?? null);
    if (!this.isEnabled(key)) return { damped: false, baseline_moved: false };
    await this.initialize(key);
    const state = this.state(key);
    if (state.trail.length === 0) return { damped: false, baseline_moved: false };
    this.decay(state, Date.now());

    for (const band of AFFECT_BANDS) {
      state.bands[band] = clamp(state.baseline[band] + (state.bands[band] - state.baseline[band]) * 0.5,
        BAND_FLOOR, BAND_CEILING);
    }
    const median: AffectBands = { ...state.baseline };
    for (const band of AFFECT_BANDS) {
      const values = state.trail.map(point => point.bands[band]).sort((a, b) => a - b);
      const mid = values[Math.floor(values.length / 2)];
      if (Number.isFinite(mid)) median[band] = clamp(mid, BAND_FLOOR, BAND_CEILING);
    }
    state.baseline = median;
    state.trail = [];
    state.dirty = true;
    await this.persist(identity, state, true);
    return { damped: true, baseline_moved: true };
  }

  /** The exact payload the wave store pins: bands plus the engine's provenance. Never a label. */
  signatureFor(snapshot: AffectStateSnapshot): Record<string, unknown> {
    return {
      bands: { ...snapshot.bands },
      engine: AFFECT_ENGINE_VERSION,
      at: Date.parse(snapshot.at) / 1000,
      // Attribution travels with the pin: a state scoped to a campaign says so in the lane, so a
      // reader can tell whose feeling it is looking at rather than assuming it is the identity's own.
      source: snapshot.context ? `katra:${snapshot.context}` : 'katra',
    };
  }

  private recordTrail(state: UserAffect, now: number): void {
    const derived = deriveAffect(state.bands);
    state.trail.push({
      at: new Date(now).toISOString(),
      bands: { ...state.bands },
      valence: Number(derived.valence.toFixed(4)),
      arousal: Number(derived.arousal.toFixed(4)),
    });
    if (state.trail.length > TRAIL_MAX) state.trail = state.trail.slice(-TRAIL_MAX);
  }

  private snapshotFor(identity: string, state: UserAffect): AffectStateSnapshot {
    const derived = deriveAffect(state.bands);
    const ageSeconds = Math.max(0, (Date.now() - state.lastUpdate) / 1000);
    return {
      enabled: true,
      identity: baseIdentityOf(identity),
      context: contextOf(identity),
      contributors: Object.fromEntries(
        Object.entries(state.contributors)
          .sort(([, a], [, b]) => b.observations - a.observations)
          .slice(0, 8),
      ),
      engine: AFFECT_ENGINE_VERSION,
      bands: { ...state.bands },
      baseline: { ...state.baseline },
      faa: Number(derived.faa.toFixed(4)),
      valence: Number(derived.valence.toFixed(4)),
      arousal: Number(derived.arousal.toFixed(4)),
      entropy: Number(derived.entropy.toFixed(4)),
      intensity: Number(derived.intensity.toFixed(4)),
      felt: derived.felt,
      at: new Date(state.lastUpdate).toISOString(),
      age_seconds: Number(ageSeconds.toFixed(1)),
      stale: ageSeconds > 1800,
      observations: state.observations,
      trail: state.trail.slice(-20),
      sources: { ...state.sources },
    };
  }

  private emptySnapshot(identity: string, enabled: boolean): AffectStateSnapshot {
    const derived = deriveAffect({ ...AFFECT_BASELINE });
    return {
      enabled,
      identity,
      engine: AFFECT_ENGINE_VERSION,
      bands: { ...AFFECT_BASELINE },
      baseline: { ...AFFECT_BASELINE },
      faa: Number(derived.faa.toFixed(4)),
      valence: Number(derived.valence.toFixed(4)),
      arousal: Number(derived.arousal.toFixed(4)),
      entropy: Number(derived.entropy.toFixed(4)),
      intensity: Number(derived.intensity.toFixed(4)),
      felt: derived.felt,
      at: new Date().toISOString(),
      age_seconds: 0,
      stale: true,
      observations: 0,
      trail: [],
      sources: {},
    };
  }

  /**
   * Write-behind: at most one write per second per identity, WITH a trailing flush.
   *
   * The trailing flush is the difference between "usually persisted" and "persisted". A burst of six
   * calls inside one second wrote only the first and dropped the rest on the floor — no later call
   * meant no later write, so a restart resumed from a state up to a burst stale. A skipped write now
   * schedules exactly one flush at the end of the interval (`unref`'d, so it never holds the process
   * open), and the last observation always lands.
   */
  private async persist(identity: string, state: UserAffect, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - state.lastPersist < PERSIST_MIN_INTERVAL_MS) {
      if (!state.flushScheduled) {
        state.flushScheduled = true;
        const timer = setTimeout(() => {
          state.flushScheduled = false;
          void this.persist(identity, state, true);
        }, PERSIST_MIN_INTERVAL_MS);
        if (typeof (timer as any).unref === 'function') (timer as any).unref();
      }
      return;
    }
    state.lastPersist = now;
    try {
      const db = get_database();
      if (!db) return;
      await db.collection('affect_state').updateOne(
        { user_id: identity },
        {
          $set: {
            user_id: identity,
            bands: state.bands,
            baseline: state.baseline,
            last_update_ms: state.lastUpdate,
            observations: state.observations,
            sources: state.sources,
            contributors: state.contributors,
            context: contextOf(identity),
            trail: state.trail,
            engine: AFFECT_ENGINE_VERSION,
            updated_at: new Date(),
          },
        },
        { upsert: true },
      );
      state.dirty = false;
    } catch (error) {
      console.warn('[AffectEngine] persist failed:', (error as Error)?.message);
    }
  }
}

export const affectEngine = AffectEngine.get_instance();

/**
 * Content stimulus: the existing keyword tagger, unchanged. It stays the content channel — not the
 * only one, and not the authoritative one, because a state that only moves when text arrives freezes
 * exactly when the agent is stuck in a tool loop with no text to ingest.
 */
export function stimulusFromContent(text: string): AffectStimulus | null {
  if (!text || text.trim().length === 0) return null;
  try {
    const tag = ValenceTagger.get_instance().tag(text);
    return { valence: tag.valence, arousal: tag.arousal, weight: 1.0, source: 'content' };
  } catch {
    return null;
  }
}

export function stimulusFromToolCall(tool: string, ok: boolean): AffectStimulus {
  return ok
    ? { valence: 0.15, arousal: 0.15, weight: 0.25, source: 'tool_success', detail: tool,
        theta_weight: 0,
        // Bounded (AFFECT-5): quiet impulse, and a hard ceiling on how far volume can lift activation.
        arousal_gain: AFFECT_SUCCESS_GAIN, valence_gain: AFFECT_SUCCESS_GAIN,
        arousal_cap_offset: AFFECT_SUCCESS_CAP_OFFSET,
        source_id: 'tool_success' }
    : { valence: -0.5, arousal: 0.85, weight: 0.9, source: 'tool_failure', detail: tool,
        theta_weight: 0, source_id: 'tool_failure' };
}

export function stimulusFromAnomaly(classification?: string): AffectStimulus | null {
  if (!classification) return null;
  const normal = classification === 'normal' || classification === 'none';
  if (normal) return null;
  return { valence: -0.4, arousal: 0.6, weight: 0.5, source: 'anomaly', detail: classification };
}
