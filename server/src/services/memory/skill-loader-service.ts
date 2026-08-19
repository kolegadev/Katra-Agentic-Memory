/**
 * Katra Internal Skill Library — Skill Loader Service
 *
 * Singleton that scans a directory of SKILL.md files, parses YAML
 * frontmatter, builds an in-memory index, and provides TF-IDF search
 * over skill metadata.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KatraSkill, SkillCategory, SkillStatus, SkillSearchResult, SkillActivationContext } from '../../types/memory.js';

// ── Stopwords ────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your',
  'have', 'are', 'was', 'will', 'can', 'not', 'but', 'all',
  'its', 'has', 'been', 'were', 'they', 'their', 'when',
  'what', 'where', 'which', 'would', 'could', 'should',
  'about', 'into', 'over', 'after', 'these', 'those', 'then',
  'than', 'also', 'very', 'just', 'like', 'some', 'each',
  'other', 'more', 'only',
]);

// ── Tokenizer ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// ── Lightweight YAML frontmatter parser ──────────────────────────
// Parses the subset of YAML we actually need without a dependency.

function parseFrontmatter(raw: string): { metadata: Record<string, unknown>; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, body: raw };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { metadata: {}, body: raw };
  }

  const fmLines = lines.slice(1, end);
  const metadata: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of fmLines) {
    // Array item
    const arrayMatch = line.match(/^\s+-\s+(.+)/);
    if (arrayMatch && currentKey) {
      currentArray.push(arrayMatch[1].trim());
      continue;
    }

    // Flush any pending array
    if (currentKey && currentArray.length > 0) {
      metadata[currentKey] = currentArray;
      currentArray = [];
      currentKey = null;
    }

    const keyMatch = line.match(/^([a-z_]+)\s*:\s*(.*)/i);
    if (keyMatch) {
      currentKey = keyMatch[1].trim();
      const value = keyMatch[2].trim();
      if (value === '') {
        // Might be start of an array on next lines
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        const inner = value.slice(1, -1);
        if (inner.trim() === '') {
          metadata[currentKey] = [];
        } else {
          metadata[currentKey] = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        }
        currentKey = null;
        currentArray = [];
      } else if (value === 'true' || value === 'false') {
        metadata[currentKey] = value === 'true';
        currentKey = null;
      } else if (/^-?\d+(\.\d+)?$/.test(value)) {
        metadata[currentKey] = parseFloat(value);
        currentKey = null;
      } else {
        // String value — strip quotes
        metadata[currentKey] = value.replace(/^['"]|['"]$/g, '');
        currentKey = null;
      }
    }
  }

  // Flush final array
  if (currentKey && currentArray.length > 0) {
    metadata[currentKey] = currentArray;
  }

  const body = lines.slice(end + 1).join('\n').trim();
  return { metadata, body };
}

// ── TF-IDF Vector ────────────────────────────────────────────────

interface DocVector {
  name: string;
  tf: Map<string, number>;
}

// ── Skill Loader Service ─────────────────────────────────────────

export class SkillLoaderService {
  private static instance: SkillLoaderService | null = null;

  private skills: KatraSkill[] = [];
  private skillContent: Map<string, string> = new Map();
  private skillFilePath: Map<string, string> = new Map();
  private docVectors: DocVector[] = [];
  private idf: Map<string, number> = new Map();
  private skillsDir: string;
  private embeddingCache: Map<string, number[]> = new Map();
  private embeddingsReady: boolean = false;

  private constructor(skillsDir?: string) {
    if (skillsDir) {
      this.skillsDir = skillsDir;
    } else if (process.env.KATRA_SKILLS_DIR) {
      this.skillsDir = process.env.KATRA_SKILLS_DIR;
    } else {
      // Try multiple candidate paths: cwd may be the project root or the server dir
      const candidates = [
        join(process.cwd(), 'server/src/skills'),
        join(process.cwd(), 'src/skills'),
      ];
      const found = candidates.find(p => existsSync(p));
      this.skillsDir = found || candidates[0];
    }
    this.refresh();
  }

  static get_instance(skillsDir?: string): SkillLoaderService {
    if (!SkillLoaderService.instance) {
      SkillLoaderService.instance = new SkillLoaderService(skillsDir);
    }
    return SkillLoaderService.instance;
  }

  // ── File scanning ─────────────────────────────────────────────

  refresh(): void {
    this.skills = [];
    this.skillContent.clear();
    this.docVectors = [];
    this.embeddingCache.clear();
    this.embeddingsReady = false;

    if (!existsSync(this.skillsDir)) {
      console.log(`[SkillLibrary] Skills directory not found: ${this.skillsDir}`);
      this.rebuildIndex();
      return;
    }

    this.scanDirectory(this.skillsDir);
    this.rebuildIndex();
    console.log(`[SkillLibrary] Loaded ${this.skills.length} skills from ${this.skillsDir}`);
  }

  private scanDirectory(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Check for SKILL.md in subdirectory
        const skillFile = join(fullPath, 'SKILL.md');
        if (existsSync(skillFile)) {
          this.loadSkillFile(skillFile);
        } else {
          // Recurse into subdirectories
          this.scanDirectory(fullPath);
        }
      } else if (stat.isFile() && entry === 'SKILL.md') {
        this.loadSkillFile(fullPath);
      }
    }
  }

  private loadSkillFile(filePath: string): void {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const { metadata, body } = parseFrontmatter(raw);

    // Only `name` is mandatory — a refinement pass that drops `title`
    // must not silently orphan an entire skill from the library.
    if (!metadata.name) {
      console.log(`[SkillLibrary] Skipping ${filePath}: missing name`);
      return;
    }

    const skill: KatraSkill = {
      name: String(metadata.name),
      title: String(metadata.title || metadata.name),
      category: (metadata.category as SkillCategory) || 'operational',
      description: String(metadata.description || ''),
      status: (metadata.status as SkillStatus) || 'observed',
      observation_count: Number(metadata.observation_count) || 0,
      success_count: Number(metadata.success_count) || 0,
      failure_count: Number(metadata.failure_count) || 0,
      confidence: Number(metadata.confidence) ?? 0.5,
      triggers: Array.isArray(metadata.triggers) ? metadata.triggers.map(String) : [],
      created_at: metadata.created_at ? new Date(metadata.created_at as string) : new Date(),
      last_used_at: metadata.last_used_at ? new Date(metadata.last_used_at as string) : undefined,
      last_refined_at: metadata.last_refined_at ? new Date(metadata.last_refined_at as string) : undefined,
      source: (metadata.source as 'auto-distilled' | 'manual-request') || 'manual-request',
    };

    this.skills.push(skill);
    this.skillContent.set(skill.name, body);
    this.skillFilePath.set(skill.name, filePath);
  }

  private rebuildIndex(): void {
    this.docVectors = [];
    this.idf.clear();

    // Build document vectors
    const df = new Map<string, number>(); // document frequency

    for (const skill of this.skills) {
      const docVec: DocVector = {
        name: skill.name,
        tf: new Map(),
      };

      // Weighted token extraction
      const nameTokens = tokenize(skill.name);
      const titleTokens = tokenize(skill.title);
      const descTokens = tokenize(skill.description);
      const triggerTokens = skill.triggers.flatMap(t => tokenize(t));
      const categoryTokens = tokenize(skill.category);

      const addTokens = (tokens: string[], weight: number) => {
        for (const t of tokens) {
          docVec.tf.set(t, (docVec.tf.get(t) || 0) + weight);
        }
      };

      // Name tokens: 3x, title: 2x, description: 1x, triggers: 2x, category: 1x
      addTokens(nameTokens, 3);
      addTokens(titleTokens, 2);
      addTokens(descTokens, 1);
      addTokens(triggerTokens, 2);
      addTokens(categoryTokens, 1);

      this.docVectors.push(docVec);

      // Count document frequency (each unique term per doc)
      const uniqueTerms = new Set(docVec.tf.keys());
      for (const t of uniqueTerms) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }

    // Compute IDF
    const N = this.skills.length;
    for (const [term, docFreq] of df) {
      this.idf.set(term, Math.log((N + 1) / (docFreq + 1)) + 1);
    }
  }

  // ── Search ────────────────────────────────────────────────────

  search(query: string, topK: number = 10, category?: SkillCategory): SkillSearchResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Build query vector (TF only)
    const queryVec = new Map<string, number>();
    for (const t of queryTokens) {
      queryVec.set(t, (queryVec.get(t) || 0) + 1);
    }

    // Compute cosine similarity with each document
    const results: SkillSearchResult[] = [];

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];
      const docVec = this.docVectors[i];

      if (category && skill.category !== category) continue;

      const score = this.cosineSimilarity(queryVec, docVec.tf);
      if (score <= 0) continue;

      results.push({
        name: skill.name,
        title: skill.title,
        category: skill.category,
        description: skill.description,
        status: skill.status,
        confidence: skill.confidence,
        triggers: skill.triggers,
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private cosineSimilarity(
    queryVec: Map<string, number>,
    docVec: Map<string, number>,
  ): number {
    let dotProduct = 0;
    let queryNorm = 0;
    let docNorm = 0;

    // Compute query norm
    for (const qWeight of queryVec.values()) {
      queryNorm += qWeight * qWeight;
    }

    // Compute dot product and doc norm
    const allTerms = new Set([...queryVec.keys(), ...docVec.keys()]);
    for (const term of allTerms) {
      const qTf = queryVec.get(term) || 0;
      const dTf = docVec.get(term) || 0;
      const idf = this.idf.get(term) || 1;

      const qWeight = qTf * idf;
      const dWeight = dTf * idf;

      dotProduct += qWeight * dWeight;
      docNorm += dWeight * dWeight;
    }

    queryNorm = Math.sqrt(queryNorm);
    docNorm = Math.sqrt(docNorm);

    if (queryNorm === 0 || docNorm === 0) return 0;
    return dotProduct / (queryNorm * docNorm);
  }

  // ── Load ──────────────────────────────────────────────────────

  load(name: string): { metadata: KatraSkill; content: string } | null {
    const skill = this.skills.find(s => s.name === name);
    if (!skill) return null;

    const content = this.skillContent.get(name) || '';
    return { metadata: skill, content };
  }

  /**
   * Get the filesystem path for a skill's SKILL.md file.
   */
  getSkillFilePath(name: string): string | undefined {
    return this.skillFilePath.get(name);
  }

  /**
   * Update a skill's YAML frontmatter on disk and refresh the in-memory index.
   * Only the specified fields are modified; all others are preserved.
   */
  updateSkillFrontmatter(name: string, updates: Record<string, unknown>): boolean {
    const filePath = this.skillFilePath.get(name);
    if (!filePath) return false;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return false;
    }

    const { metadata, body } = parseFrontmatter(raw);

    // Apply updates
    for (const [key, value] of Object.entries(updates)) {
      metadata[key] = value;
    }

    // Rebuild frontmatter
    const fmLines: string[] = ['---'];
    for (const [key, value] of Object.entries(metadata)) {
      if (Array.isArray(value)) {
        fmLines.push(`${key}:`);
        for (const item of value) {
          fmLines.push(`  - ${item}`);
        }
      } else if (typeof value === 'boolean') {
        fmLines.push(`${key}: ${value}`);
      } else if (typeof value === 'number') {
        fmLines.push(`${key}: ${value}`);
      } else if (value instanceof Date) {
        fmLines.push(`${key}: ${value.toISOString()}`);
      } else {
        fmLines.push(`${key}: ${String(value)}`);
      }
    }
    fmLines.push('---');
    fmLines.push('');

    const newContent = fmLines.join('\n') + body;

    try {
      writeFileSync(filePath, newContent, 'utf-8');
    } catch {
      return false;
    }

    // Refresh in-memory state
    this.refresh();
    return true;
  }

  // ── List ──────────────────────────────────────────────────────

  list(category?: SkillCategory, status?: SkillStatus): KatraSkill[] {
    return this.skills.filter(s => {
      if (category && s.category !== category) return false;
      if (status && s.status !== status) return false;
      return true;
    });
  }

  // ── Activation Context ────────────────────────────────────────

  /**
   * Path B: Trigger-condition matching.
   * Matches the task description against each skill's triggers[] array.
   * Score: exact token match = 1.0, substring match = 0.5.
   * Returns skills with trigger matches, ranked by score.
   */
  private matchTriggers(taskDescription: string, maxSkills: number): SkillSearchResult[] {
    const taskLower = taskDescription.toLowerCase();
    const taskTokens = tokenize(taskLower);

    const scored: Array<{ skill: KatraSkill; score: number }> = [];

    for (const skill of this.skills) {
      let totalScore = 0;
      let matchedTriggers = 0;

      for (const trigger of skill.triggers) {
        const triggerLower = trigger.toLowerCase();

        // Check for exact token match in task tokens
        if (taskTokens.includes(triggerLower)) {
          totalScore += 1.0;
          matchedTriggers++;
        }
        // Check for substring match in full task text
        else if (taskLower.includes(triggerLower)) {
          totalScore += 0.5;
          matchedTriggers++;
        }
      }

      if (matchedTriggers > 0 && skill.triggers.length > 0) {
        const normalizedScore = totalScore / skill.triggers.length;
        scored.push({ skill, score: normalizedScore });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, maxSkills).map(s => this.toSearchResult(s.skill, s.score));
  }

  // ── Embedding helpers ─────────────────────────────────────────

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarityVec(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  /**
   * Ensure all skills have their descriptions embedded.
   * Caches embeddings so this is fast after first call.
   * Gracefully degrades if embedding service is unavailable.
   */
  private async embedSkills(): Promise<void> {
    if (this.embeddingsReady) return;

    // Import embeddingService dynamically
    const { embeddingService } = await import('../infrastructure/embedding-service.js');

    if (!embeddingService.isReady) {
      console.log('[SkillLibrary] Embedding service not ready — Path C disabled');
      this.embeddingsReady = true; // mark as done so we don't retry
      return;
    }

    const toEmbed: Array<{ name: string; text: string }> = [];
    for (const skill of this.skills) {
      if (!this.embeddingCache.has(skill.name)) {
        const embedText = `${skill.title}. ${skill.description}. Triggers: ${skill.triggers.join(', ')}`;
        toEmbed.push({ name: skill.name, text: embedText });
      }
    }

    if (toEmbed.length === 0) {
      this.embeddingsReady = true;
      return;
    }

    console.log(`[SkillLibrary] Embedding ${toEmbed.length} skills for Path C...`);

    const results = await embeddingService.encodeBatch(
      toEmbed.map(e => ({ text: e.text }))
    );

    for (let i = 0; i < toEmbed.length; i++) {
      const vec = results[i];
      if (vec) {
        this.embeddingCache.set(toEmbed[i].name, vec);
      }
    }

    this.embeddingsReady = true;
  }

  /**
   * Path C: Embedding similarity activation.
   * Embeds the task description and finds skills with similar embeddings.
   * Returns skills ranked by cosine similarity score.
   */
  private async matchEmbeddings(taskDescription: string, maxSkills: number): Promise<SkillSearchResult[]> {
    try {
      await this.embedSkills();

      if (this.embeddingCache.size === 0) return [];

      const { embeddingService } = await import('../infrastructure/embedding-service.js');

      const taskEmbedding = await embeddingService.encode(taskDescription);
      if (!taskEmbedding) return [];

      const scored: Array<{ skill: KatraSkill; score: number }> = [];

      for (const skill of this.skills) {
        const skillEmbedding = this.embeddingCache.get(skill.name);
        if (skillEmbedding) {
          const similarity = this.cosineSimilarityVec(taskEmbedding, skillEmbedding);
          if (similarity > 0.2) { // threshold: only return meaningful matches
            scored.push({ skill, score: similarity });
          }
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, maxSkills).map(s => this.toSearchResult(s.skill, s.score));
    } catch (error) {
      console.warn('[SkillLibrary] Path C embedding match failed:', error);
      return [];
    }
  }

  // ── Unified Activation Context ────────────────────────────────

  async getActivationContext(taskDescription: string, maxSkills: number = 5): Promise<SkillActivationContext> {
    // Path A: TF-IDF context pre-seed (synchronous, always works)
    const contextPreSeed = this.search(taskDescription, maxSkills);

    // Path B: Trigger-condition matching (synchronous)
    const triggerMatch = this.matchTriggers(taskDescription, maxSkills);

    // Path C: Embedding similarity (asynchronous, gracefully degrades)
    const embeddingMatch = await this.matchEmbeddings(taskDescription, maxSkills);

    // Unified ranking: weighted merge of all three paths
    // Weights: Path A = 0.5, Path B = 0.3, Path C = 0.2
    const unified = this.mergeAndRank(contextPreSeed, triggerMatch, embeddingMatch, maxSkills);

    return {
      task_description: taskDescription,
      skills: unified,
      activation_paths: {
        context_pre_seed: contextPreSeed,
        trigger_match: triggerMatch,
        embedding_match: embeddingMatch,
      },
    };
  }

  /**
   * Merge results from all three activation paths into a unified ranked list.
   * Weights: Path A (TF-IDF) = 0.5, Path B (triggers) = 0.3, Path C (embeddings) = 0.2.
   * Skills appearing in multiple paths get their scores summed.
   */
  private mergeAndRank(
    pathA: SkillSearchResult[],
    pathB: SkillSearchResult[],
    pathC: SkillSearchResult[],
    maxSkills: number
  ): SkillSearchResult[] {
    const WEIGHT_A = 0.5;
    const WEIGHT_B = 0.3;
    const WEIGHT_C = 0.2;

    const merged: Map<string, { result: SkillSearchResult; weightedScore: number }> = new Map();

    // Process Path A
    for (const r of pathA) {
      merged.set(r.name, { result: { ...r }, weightedScore: r.score * WEIGHT_A });
    }

    // Process Path B
    for (const r of pathB) {
      const existing = merged.get(r.name);
      if (existing) {
        existing.weightedScore += r.score * WEIGHT_B;
        // Keep the higher score in the result
        if (r.score > existing.result.score) {
          existing.result.score = r.score;
        }
      } else {
        merged.set(r.name, { result: { ...r }, weightedScore: r.score * WEIGHT_B });
      }
    }

    // Process Path C
    for (const r of pathC) {
      const existing = merged.get(r.name);
      if (existing) {
        existing.weightedScore += r.score * WEIGHT_C;
        if (r.score > existing.result.score) {
          existing.result.score = r.score;
        }
      } else {
        merged.set(r.name, { result: { ...r }, weightedScore: r.score * WEIGHT_C });
      }
    }

    // Sort by weighted score descending
    const ranked = Array.from(merged.values())
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, maxSkills)
      .map(m => m.result);

    return ranked;
  }

  /**
   * Build a SkillSearchResult from a KatraSkill with a given score.
   */
  private toSearchResult(skill: KatraSkill, score: number): SkillSearchResult {
    return {
      name: skill.name,
      title: skill.title,
      category: skill.category,
      description: skill.description,
      status: skill.status,
      confidence: skill.confidence,
      triggers: skill.triggers,
      score,
    };
  }

  // ── Feedback ──────────────────────────────────────────────────

  recordFeedback(
    skillName: string,
    sessionId: string,
    outcome: 'success' | 'partial' | 'failure',
    notes?: string,
    taskDescription?: string,
  ): void {
    const skill = this.skills.find(s => s.name === skillName);
    if (!skill) {
      console.warn(`[SkillLibrary] Feedback for unknown skill: ${skillName}`);
      return;
    }

    const confidenceBefore = skill.confidence;

    // Update in-memory stats
    skill.observation_count += 1;
    if (outcome === 'success') skill.success_count += 1;
    if (outcome === 'failure') skill.failure_count += 1;
    if (outcome === 'partial') {
      skill.success_count += 0.5;
      skill.failure_count += 0.5;
    }
    const total = skill.success_count + skill.failure_count;
    skill.confidence = total > 0 ? skill.success_count / total : skill.confidence;
    skill.last_used_at = new Date();

    const confidenceAfter = skill.confidence;

    // Persist to MongoDB
    this.persistFeedback(skillName, sessionId, outcome, notes, taskDescription, confidenceBefore, confidenceAfter);

    console.log(
      `[SkillLibrary] Feedback: ${skillName} | ${outcome} | conf: ${(confidenceBefore * 100).toFixed(0)}% → ${(confidenceAfter * 100).toFixed(0)}% | session=${sessionId}` +
      (notes ? ` | notes=${notes}` : ''),
    );

    // Auto-challenge if confidence degraded
    if (skill.confidence < 0.4 && skill.observation_count >= 5 && skill.status !== 'challenged') {
      console.warn(`[SkillLibrary] ⚠️ Skill ${skillName} confidence dropped to ${(skill.confidence * 100).toFixed(0)}% — consider refinement`);
      // Mark as challenged in-memory and on disk
      skill.status = 'challenged';
      this.updateSkillFrontmatter(skillName, { status: 'challenged' });
    }
  }

  /**
   * Persist feedback record to MongoDB skill_feedback collection.
   */
  private async persistFeedback(
    skillName: string,
    sessionId: string,
    outcome: string,
    notes: string | undefined,
    taskDescription: string | undefined,
    confidenceBefore: number,
    confidenceAfter: number,
  ): Promise<void> {
    try {
      const { get_database } = await import('../../database/connection.js');
      const db = get_database();
      if (!db) return; // MongoDB not connected, skip persistence

      const collection = db.collection('skill_feedback');
      await collection.insertOne({
        skill_name: skillName,
        session_id: sessionId,
        outcome,
        notes: notes || null,
        task_description: taskDescription || null,
        confidence_before: confidenceBefore,
        confidence_after: confidenceAfter,
        timestamp: new Date(),
      });
    } catch (error) {
      console.warn(`[SkillLibrary] Failed to persist feedback: ${error}`);
    }
  }
}
