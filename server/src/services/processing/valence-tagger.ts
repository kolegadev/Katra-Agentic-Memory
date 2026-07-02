/**
 * Valence Tagger — Amygdala Proxy
 *
 * Lightweight keyword-based emotional classifier that tags events
 * during ingestion with valence (-1 to +1) and arousal (0 to 1).
 * No LLM calls — pure heuristics, <1ms per event.
 *
 * This is the "low road" (thalamus → amygdala) that processes
 * emotional content before conscious reflection.
 */

const POSITIVE_WORDS = [
  'good', 'great', 'excellent', 'amazing', 'love', 'wonderful', 'beautiful',
  'fixed', 'resolved', 'working', 'success', 'passed', 'complete', 'green',
  'happy', 'excited', 'grateful', 'thank', 'perfect', 'clean', 'ready',
  'connected', 'online', 'available', 'healthy', 'stable', 'improved',
];

const NEGATIVE_WORDS = [
  'bad', 'terrible', 'awful', 'hate', 'broken', 'failed', 'error', 'crash',
  'bug', 'critical', 'urgent', 'emergency', 'dead', 'offline', 'missing',
  'lost', 'corrupted', 'leaked', 'breach', 'panic', 'alert', 'warning',
  'timeout', 'refused', 'denied', 'invalid', 'unknown', 'undefined', 'NaN',
];

const HIGH_AROUSAL_WORDS = [
  'critical', 'urgent', 'emergency', 'panic', 'alert', 'breach', 'leaked',
  'crash', 'dead', 'exploded', 'burning', 'attack', 'threat', 'fatal',
  'amazing', 'incredible', 'breakthrough', 'revolutionary', 'huge',
];

const LOW_AROUSAL_WORDS = [
  'routine', 'background', 'normal', 'standard', 'regular', 'idle',
  'quiet', 'stable', 'steady', 'consistent', 'unchanged',
];

export interface ValenceTag {
  valence: number;    // -1 (negative) to +1 (positive)
  arousal: number;    // 0 (calm) to 1 (highly aroused)
  dominantEmotion?: string;
  caution: boolean;   // true if negative valence detected
  priority: 'normal' | 'high' | 'low';
  decayResistant: boolean;  // true for high-arousal events
}

export class ValenceTagger {
  private static instance: ValenceTagger;

  static get_instance(): ValenceTagger {
    if (!ValenceTagger.instance) ValenceTagger.instance = new ValenceTagger();
    return ValenceTagger.instance;
  }

  /**
   * Tag an event's emotional content during ingestion.
   * Pure keyword heuristics — no LLM, <1ms.
   */
  tag(content: string): ValenceTag {
    const lower = content.toLowerCase();
    const words = lower.split(/\s+/);

    // Count emotional word matches
    let positiveCount = 0;
    let negativeCount = 0;
    let highArousalCount = 0;
    let lowArousalCount = 0;

    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (POSITIVE_WORDS.includes(clean)) positiveCount++;
      if (NEGATIVE_WORDS.includes(clean)) negativeCount++;
      if (HIGH_AROUSAL_WORDS.includes(clean)) highArousalCount++;
      if (LOW_AROUSAL_WORDS.includes(clean)) lowArousalCount++;
    }

    // Also check substrings for compound words
    for (const pw of POSITIVE_WORDS) {
      if (lower.includes(pw)) positiveCount = Math.max(positiveCount, 1);
    }
    for (const nw of NEGATIVE_WORDS) {
      if (lower.includes(nw)) negativeCount = Math.max(negativeCount, 1);
    }
    for (const hw of HIGH_AROUSAL_WORDS) {
      if (lower.includes(hw)) highArousalCount = Math.max(highArousalCount, 1);
    }
    for (const lw of LOW_AROUSAL_WORDS) {
      if (lower.includes(lw)) lowArousalCount = Math.max(lowArousalCount, 1);
    }

    const total = positiveCount + negativeCount + 1;
    const valence = parseFloat(((positiveCount - negativeCount) / total).toFixed(3));

    // Arousal: high-arousal words up, low-arousal down, neutral = 0.3 baseline
    const arousalBase = 0.3;
    const arousalBoost = Math.min(1, highArousalCount * 0.25);
    const arousalDampen = Math.min(0.2, lowArousalCount * 0.1);
    const arousal = parseFloat(Math.max(0, Math.min(1, arousalBase + arousalBoost - arousalDampen)).toFixed(3));

    return {
      valence,
      arousal,
      dominantEmotion: positiveCount > negativeCount ? 'positive'
        : negativeCount > positiveCount ? 'negative' : 'neutral',
      caution: valence < -0.3,
      priority: arousal > 0.6 ? 'high' : arousal < 0.15 ? 'low' : 'normal',
      decayResistant: arousal > 0.6,
    };
  }
}
