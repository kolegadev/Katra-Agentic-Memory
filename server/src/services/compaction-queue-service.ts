/**
 * Compaction Queue Service — Non-Blocking Background Graph Compaction
 *
 * Captures conversational turn pairs (user + assistant) and schedules
 * Knowledge Graph extraction during chat idle periods. Uses a 4-second
 * debounce window — resets whenever the user types, processes when silence
 * is detected.
 *
 * Architecture:
 *   Frontend keystroke → POST /api/memory/working/activity → reset idle timer
 *   Chat response sent → queueTurnDiff(user, assistant) → queued
 *   Idle timer fires → processQueue() → compactEpisodicToGraph()
 */

import { SemanticMemoryService } from './semantic-memory-service.js';

interface CompactionTask {
  episodicId: string;
  text: string;
}

export class CompactionQueueService {
  private semanticMemory: SemanticMemoryService;
  private queue: CompactionTask[] = [];
  private isProcessing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_DELAY = 4000; // 4 seconds of silence before processing

  constructor(semanticMemory: SemanticMemoryService) {
    this.semanticMemory = semanticMemory;
  }

  /**
   * Call this after the assistant response is generated. Seeds the queue
   * with the full conversation turn (user message + assistant response).
   */
  public queueTurnDiff(episodicId: string, userText: string, agentText: string): void {
    const combinedDiff = `User: ${userText}\nAssistant: ${agentText}`;
    this.queue.push({ episodicId, text: combinedDiff });
    console.log(`📨 Queued graph compaction for ${episodicId} (${this.queue.length} in queue)`);
    this.triggerIdleReset();
  }

  /**
   * Call this when the user is active (typing, interacting).
   * Resets the 4-second debounce timer — graph compaction waits for silence.
   */
  public registerUserActivity(): void {
    this.triggerIdleReset();
  }

  /**
   * Returns the current queue depth (for monitoring).
   */
  public getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Returns whether the processor is currently working.
   */
  public getIsProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * Reset the idle timer — when it fires, start processing the queue.
   */
  private triggerIdleReset(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.processQueue();
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * Process one task from the queue. On failure, requeue the task.
   * Automatically continues to the next task if backlog exists.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const activeTask = this.queue.shift();

    try {
      if (activeTask) {
        console.log(`📊 Processing graph compaction: ${activeTask.episodicId}`);
        await this.semanticMemory.compactEpisodicToGraph(activeTask.episodicId, activeTask.text);
        console.log(`✅ Graph compaction complete: ${activeTask.episodicId}`);
      }
    } catch (error) {
      console.error('❌ Compaction queue execution failed:', error);
      // Re-queue to safeguard data — will retry on next idle window
      if (activeTask) {
        this.queue.unshift(activeTask);
      }
    } finally {
      this.isProcessing = false;
      // Smoothly proceed to next item if backlog exists
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 500);
      }
    }
  }
}
