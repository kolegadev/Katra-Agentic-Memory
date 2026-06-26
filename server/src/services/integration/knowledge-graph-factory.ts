/**
 * Knowledge Graph service factory — creates/lazily initializes singletons.
 * All services require the database, which is available after MongoDB connects.
 */

import { get_database } from '../database/connection.js';
import { SemanticMemoryService } from './semantic-memory-service.js';
import { CompactionQueueService } from './compaction-queue-service.js';
import { MemorySynthesisService } from './memory-synthesis-service.js';
import { ProspectiveMemoryService } from './prospective-memory-service.js';

let semanticMemoryService: SemanticMemoryService | null = null;
let compactionQueueService: CompactionQueueService | null = null;
let memorySynthesisService: MemorySynthesisService | null = null;
let prospectiveMemoryService: ProspectiveMemoryService | null = null;

// Global toggle — controls whether the AI can write to goal memory
export const goalsAccess = { readwrite: true };

export function getSemanticMemoryService(): SemanticMemoryService {
  if (!semanticMemoryService) {
    const db = get_database();
    semanticMemoryService = new SemanticMemoryService(db);
  }
  return semanticMemoryService;
}

export function getCompactionQueueService(): CompactionQueueService {
  if (!compactionQueueService) {
    const sms = getSemanticMemoryService();
    compactionQueueService = new CompactionQueueService(sms);
  }
  return compactionQueueService;
}

export function getMemorySynthesisService(): MemorySynthesisService {
  if (!memorySynthesisService) {
    const db = get_database();
    memorySynthesisService = new MemorySynthesisService(db);
  }
  return memorySynthesisService;
}

export function getProspectiveMemoryService(): ProspectiveMemoryService {
  if (!prospectiveMemoryService) {
    const db = get_database();
    prospectiveMemoryService = new ProspectiveMemoryService(db);
  }
  return prospectiveMemoryService;
}
