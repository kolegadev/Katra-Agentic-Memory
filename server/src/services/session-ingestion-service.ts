/**
 * Session Ingestion Service
 *
 * Reads session JSONL files and ingests user/assistant messages
 * as episodic events into the cognitive memory system.
 *
 * Tracks ingestion state to avoid duplicate imports across runs.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getEpisodicEventManager, EpisodicEventData } from './episodic-event-manager.js';

export interface IngestionState {
  lastIngestedTimestamp: string;
  ingestedSessions: string[];
  totalIngested: number;
  lastRun: string;
}

export interface IngestionResult {
  sessionsProcessed: number;
  messagesIngested: number;
  skipped: number;
  errors: number;
  duration: number;
}

const STATE_DIR = '/data/ingestion';
const STATE_FILE = join(STATE_DIR, 'katra-ingestion-state.json');
// Inside Docker, Session logs are mounted at /sessions
// Outside Docker (local), they're at ~/.katra/sessions
const SESSIONS_DIR = existsSync('/sessions')
  ? join('/sessions', 'main', 'sessions')
  : join(homedir(), '.katra', 'sessions');

export class SessionIngestionService {
  private static instance: SessionIngestionService;
  private state: IngestionState;
  private processing = false;

  private constructor() {
    this.state = this.loadState();
  }

  static get_instance(): SessionIngestionService {
    if (!SessionIngestionService.instance) {
      SessionIngestionService.instance = new SessionIngestionService();
    }
    return SessionIngestionService.instance;
  }

  /**
   * Load ingestion state from disk
   */
  private loadState(): IngestionState {
    try {
      if (existsSync(STATE_FILE)) {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('Failed to load ingestion state:', e);
    }
    return {
      lastIngestedTimestamp: new Date(0).toISOString(),
      ingestedSessions: [],
      totalIngested: 0,
      lastRun: new Date(0).toISOString(),
    };
  }

  /**
   * Save ingestion state to disk
   */
  private saveState(): void {
    try {
      if (!existsSync(STATE_DIR)) {
        mkdirSync(STATE_DIR, { recursive: true });
      }
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('Failed to save ingestion state:', e);
    }
  }

  /**
   * List available session files
   */
  listSessions(): string[] {
    if (!existsSync(SESSIONS_DIR)) return [];
    return readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.includes('trajectory'))
      .map(f => join(SESSIONS_DIR, f));
  }

  /**
   * Parse a session JSONL file and extract user/assistant messages
   */
  private parseSessionFile(filePath: string): Array<{
    sessionId: string;
    role: 'user' | 'assistant';
    message: string;
    timestamp: Date;
    context?: string;
  }> {
    const messages: Array<{
      sessionId: string;
      role: 'user' | 'assistant';
      message: string;
      timestamp: Date;
      context?: string;
    }> = [];
    let sessionId = '';

    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);

          if (entry.type === 'session' && entry.id) {
            sessionId = entry.id;
            continue;
          }

          if (entry.type === 'message' && entry.message) {
            const role = entry.message.role;
            if (role !== 'user' && role !== 'assistant') continue;

            // Extract text content from the message
            let text = '';
            if (typeof entry.message.content === 'string') {
              text = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              text = entry.message.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n');
            }

            if (!text.trim()) continue;

            // Skip system/cron/internal messages
            if (text.startsWith('[cron:') || text.startsWith('HEARTBEAT') || text.startsWith('NO_REPLY')) {
              continue;
            }

            // Truncate very long messages
            if (text.length > 10000) {
              text = text.slice(0, 10000) + '...[truncated]';
            }

            messages.push({
              sessionId: sessionId || filePath,
              role,
              message: text,
              timestamp: new Date(entry.timestamp || Date.now()),
              context: `session:${sessionId}`,
            });
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (e) {
      console.error(`Failed to parse session file ${filePath}:`, e);
    }

    return messages;
  }

  /**
   * Ingest all new session messages since last run
   */
  async ingestNewSessions(): Promise<IngestionResult> {
    if (this.processing) {
      return { sessionsProcessed: 0, messagesIngested: 0, skipped: 0, errors: 0, duration: 0 };
    }

    this.processing = true;
    const startTime = Date.now();
    let sessionsProcessed = 0;
    let messagesIngested = 0;
    let errors = 0;

    try {
      const eventManager = getEpisodicEventManager();
      const sessionFiles = this.listSessions();
      const ingestedSet = new Set(this.state.ingestedSessions);

      for (const filePath of sessionFiles) {
        const sessionName = filePath.split('/').pop() || filePath;

        // Skip already-ingested sessions
        if (ingestedSet.has(sessionName)) continue;

        const messages = this.parseSessionFile(filePath);
        if (messages.length === 0) {
          ingestedSet.add(sessionName);
          continue;
        }

        let sessionIngested = 0;
        for (const msg of messages) {
          try {
            const eventData: EpisodicEventData = {
              user_id: 'katra-default',
              session_id: `session:${msg.sessionId}`,
              event_type: 'conversation',
              content: {
                role: msg.role,
                message: msg.message,
                context: msg.context,
                source: 'session-log',
              },
              timestamp: msg.timestamp,
              metadata: {
                source: 'session-ingestion',
                processed: false,
              },
            };

            await eventManager.createEvent(eventData);
            sessionIngested++;
            messagesIngested++;
          } catch (e) {
            // Dedup errors are expected — skip silently
            errors++;
          }
        }

        ingestedSet.add(sessionName);
        sessionsProcessed++;

        // Save state periodically (every 10 sessions)
        if (sessionsProcessed % 10 === 0) {
          this.state.ingestedSessions = Array.from(ingestedSet);
          this.state.totalIngested += messagesIngested;
          this.state.lastRun = new Date().toISOString();
          this.saveState();
        }
      }

      // Final state save
      this.state.ingestedSessions = Array.from(ingestedSet);
      this.state.lastRun = new Date().toISOString();
      this.state.totalIngested += messagesIngested;
      this.saveState();

      const duration = Date.now() - startTime;
      console.log(`✅ Session ingestion complete: ${sessionsProcessed} sessions, ${messagesIngested} messages in ${duration}ms`);

      return {
        sessionsProcessed,
        messagesIngested,
        skipped: 0,
        errors,
        duration,
      };
    } catch (e) {
      console.error('❌ Session ingestion failed:', e);
      throw e;
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get ingestion status
   */
  getStatus(): IngestionState & { available: number; pending: number } {
    const allSessions = this.listSessions();
    const ingestedSet = new Set(this.state.ingestedSessions);
    const pending = allSessions.filter(s => {
      const name = s.split('/').pop() || s;
      return !ingestedSet.has(name);
    }).length;

    return {
      ...this.state,
      available: allSessions.length,
      pending,
    };
  }

  /**
   * Reset ingestion state (for re-ingestion)
   */
  resetState(): void {
    this.state = {
      lastIngestedTimestamp: new Date(0).toISOString(),
      ingestedSessions: [],
      totalIngested: 0,
      lastRun: new Date(0).toISOString(),
    };
    this.saveState();
  }
}

// Export singleton getter
export function getSessionIngestionService(): SessionIngestionService {
  return SessionIngestionService.get_instance();
}
