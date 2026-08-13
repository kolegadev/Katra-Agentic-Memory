#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';

const GRAPHIFY_GRAPH = process.env.GRAPHIFY_GRAPH || join(process.cwd(), 'graphify-out/graph.json');
const KATRA_MCP_URL = process.env.KATRA_MCP_URL || 'http://localhost:3112/mcp';
const KATRA_MCP_KEY = process.env.KATRA_MCP_KEY || '';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);

async function main() {
  console.log(`Reading Graphify graph from: ${GRAPHIFY_GRAPH}`);
  const graph = JSON.parse(readFileSync(GRAPHIFY_GRAPH, 'utf-8'));

  const nodes = graph.nodes || [];
  const edges = graph.links || [];

  console.log(`Found ${nodes.length} nodes, ${edges.length} edges`);

  let ingested = 0;
  let errors = 0;

  // Ingest nodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    try {
      await mcpCall('store_memory', {
        content: JSON.stringify({
          action: 'node_discovered',
          node: {
            name: node.label || node.id,
            type: mapGraphifyType(node.file_type, node._origin),
            source_path: node.source_file || null,
            language: inferLanguage(node.source_file),
            community: node.community || null,
            community_name: node.community_name || null,
          },
          source: 'graphify-seed',
        }),
        source: 'graphify-seed-ingestion',
        confidence: 0.8,
        tags: ['code_exploration', 'graphify-seed'],
      });
      ingested++;
      if (i % 500 === 0) console.log(`  Progress: ${i}/${nodes.length} nodes`);
    } catch (e) {
      errors++;
      if (errors <= 5) console.warn(`  Error on node ${i}: ${e.message}`);
    }
  }

  console.log(`Ingested ${ingested}/${nodes.length} nodes (${errors} errors)`);

  // Ingest edges
  let edgeIngested = 0;
  let edgeErrors = 0;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    try {
      const sourceNode = nodes.find(n => n.id === edge.source);
      const targetNode = nodes.find(n => n.id === edge.target);

      await mcpCall('store_memory', {
        content: JSON.stringify({
          action: 'edge_discovered',
          edge: {
            from: sourceNode?.label || edge.source,
            to: targetNode?.label || edge.target,
            type: edge.type || 'related_to',
            weight: edge.weight || 1,
          },
          source: 'graphify-seed',
        }),
        source: 'graphify-seed-ingestion',
        confidence: 0.7,
        tags: ['code_exploration', 'graphify-seed', 'edge'],
      });
      edgeIngested++;
      if (i % 500 === 0) console.log(`  Progress: ${i}/${edges.length} edges`);
    } catch (e) {
      edgeErrors++;
      if (edgeErrors <= 5) console.warn(`  Error on edge ${i}: ${e.message}`);
    }
  }

  console.log(`Ingested ${edgeIngested}/${edges.length} edges (${edgeErrors} errors)`);
  console.log('Done.');
}

function mapGraphifyType(fileType, origin) {
  if (origin === 'ast' && !fileType) return 'function';
  if (fileType === 'code') return 'file';
  if (fileType === 'directory') return 'module';
  return fileType || 'module';
}

function inferLanguage(sourceFile) {
  if (!sourceFile) return null;
  const ext = sourceFile.split('.').pop()?.toLowerCase();
  const map = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby' };
  return map[ext] || ext || null;
}

async function mcpCall(toolName, args) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (KATRA_MCP_KEY) headers['X-MCP-Auth'] = KATRA_MCP_KEY;

  const response = await fetch(KATRA_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  // Handle SSE response
  const text = await response.text();
  const dataMatch = text.match(/data:\s*(\{.*\})/);
  if (dataMatch) {
    const data = JSON.parse(dataMatch[1]);
    if (data.error) throw new Error(data.error.message || 'MCP error');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
