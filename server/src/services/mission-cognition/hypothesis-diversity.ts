// Phase 5 hypothesis diversity (criteria 12-14): measured over SUBMITTED
// hypotheses only; comparison happens after independent submissions are
// committed (pure read of persisted state — no worker-to-worker channel);
// acceptance requires falsifiable form plus distinguishing evidence.
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';

interface HypothesisLike {
  entry_id: string;
  statement: string;
  status: string;
  alternative_hypotheses?: string[];
  evidence_for?: string[];
  information_needed?: string[];
  author_id?: string;
}

function isFalsifiable(h: HypothesisLike): boolean {
  const s = h.statement.toLowerCase();
  return s.includes('will') || s.includes('because') || s.includes('if ') || s.includes('when ')
    || s.includes('leads to') || s.includes('causes') || s.includes('>') || s.includes('<')
    || s.includes('not ') || /\d/.test(s);
}

export interface DiversityReport {
  submitted_count: number;
  distinct_authors: number;
  falsifiable_count: number;
  flagged_not_falsifiable: string[];
  distinct_forms: number;
  alternatives_recorded: number;
}

export async function measureHypothesisDiversity(db: Db, missionId: string): Promise<DiversityReport> {
  const hypotheses = await db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ mission_id: missionId, entry_type: 'hypothesis' }, { projection: { _id: 0 } })
    .toArray() as unknown as HypothesisLike[];

  const submitted = hypotheses.filter(h => ['accepted', 'active'].includes(h.status));
  const authors = new Set(submitted.map(h => h.author_id).filter(Boolean));
  const falsifiable = submitted.filter(isFalsifiable);
  const flagged = submitted.filter(h => !isFalsifiable(h)).map(h => h.entry_id);

  // Distinctness of submitted forms — normalized statement set.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const distinctForms = new Set(submitted.map(h => norm(h.statement)).filter(Boolean));
  const alternativesRecorded = submitted.reduce((n, h) => n + (h.alternative_hypotheses ?? []).length, 0);

  return {
    submitted_count: submitted.length,
    distinct_authors: authors.size,
    falsifiable_count: falsifiable.length,
    flagged_not_falsifiable: flagged,
    distinct_forms: distinctForms.size,
    alternatives_recorded: alternativesRecorded,
  };
}

/** Acceptance gate (criterion 14): falsifiable form + distinguishing evidence. */
export function assessHypothesisAcceptance(h: HypothesisLike): { acceptable: boolean; reason: string } {
  if (!isFalsifiable(h)) {
    return { acceptable: false, reason: 'not falsifiable — no distinguishing prediction stated' };
  }
  if ((h.evidence_for ?? []).length === 0 && (h.information_needed ?? []).length === 0) {
    return { acceptable: false, reason: 'no distinguishing evidence or stated information need' };
  }
  return { acceptable: true, reason: 'falsifiable form with distinguishing evidence' };
}
