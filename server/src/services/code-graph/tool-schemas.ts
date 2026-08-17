/**
 * Zod input schemas for the native code-graph MCP tools (F4).
 *
 * Kept separate from mcp-server.ts so the tool contracts can be unit-tested
 * without importing the whole server module graph.
 *
 * @see CONTRACT.md §F4
 */

import { z } from 'zod';

export const ScanCodebaseInput = z.object({
  root: z.string().min(1),
  followSymlinks: z.boolean().optional(),
});

export const SyncCodeGraphInput = z.object({
  root: z.string().min(1),
});

export const CodeGraphStatusInput = z.object({
  root: z.string().min(1),
});
