/**
 * Memory Synthesis Service — Graph Context Retrieval
 *
 * When a user prompt arrives, this service queries the Knowledge Graph
 * (memory_nodes + memory_edges) for structured facts relevant to the
 * conversation topic. Results are formatted as declarative context lines
 * for injection into the LLM system prompt.
 *
 * Architecture:
 *   User prompt → extract keywords → query graph by node IDs → format context → inject into LLM
 */

import { Db } from 'mongodb';

export class MemorySynthesisService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Pulls structural graph context related to detected topic keywords.
   * Returns a formatted string ready for LLM prompt injection, or empty
   * string if no relevant graph data exists.
   */
  public async getGraphContextAsString(detectedKeywords: string[]): Promise<string> {
    if (detectedKeywords.length === 0) return '';

    // Normalize keywords to node IDs
    const normalizedIds = detectedKeywords.map((k) =>
      `node_${k.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    );

    // Also do fuzzy matching — find nodes whose labels contain any keyword
    const fuzzyNodeIds: string[] = [];
    try {
      const regexPatterns = detectedKeywords.map((k) => ({
        label: { $regex: k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
      }));
      
      if (regexPatterns.length > 0) {
        const fuzzyNodes = await this.db.collection('memory_nodes')
          .find({ $or: regexPatterns })
          .limit(20)
          .toArray();
        
        for (const node of fuzzyNodes) {
          if (!normalizedIds.includes(node._id as string)) {
            fuzzyNodeIds.push(node._id as string);
          }
        }
      }
    } catch {
      // Fuzzy matching is best-effort — skip on error
    }

    const allNodeIds = [...new Set([...normalizedIds, ...fuzzyNodeIds])];

    // Query edges connected to any matching topic nodes, sorted by weight
    const edges = await this.db.collection('memory_edges').aggregate([
      {
        $match: {
          $or: [
            { source: { $in: allNodeIds } },
            { target: { $in: allNodeIds } },
          ],
          confidence: { $gt: 0.5 },
        },
      },
      { $sort: { weight: -1 } },
      { $limit: 15 },
    ]).toArray();

    if (edges.length === 0) return '';

    // Collect all unique node IDs referenced in edges
    const referencedNodeIds = new Set<string>();
    for (const edge of edges) {
      referencedNodeIds.add(edge.source as string);
      referencedNodeIds.add(edge.target as string);
    }

    // Fetch all referenced node labels in one query
    const nodes = await this.db.collection('memory_nodes')
      .find({ _id: { $in: [...referencedNodeIds] } })
      .project({ _id: 1, label: 1, type: 1 })
      .toArray();

    const nodeMap = new Map<string, { label: string; type: string }>();
    for (const node of nodes) {
      nodeMap.set(node._id as string, { label: node.label as string, type: node.type as string });
    }

    // Convert relationships to clean declarative strings
    const contextLines = edges.map((edge) => {
      const source = nodeMap.get(edge.source as string);
      const target = nodeMap.get(edge.target as string);

      if (source && target) {
        return `- ${source.label} (${source.type}) --[${edge.relationship}]--> ${target.label} (${target.type}) (Strength: ${edge.weight})`;
      }
      return '';
    }).filter(Boolean);

    if (contextLines.length === 0) return '';

    return `\n[Verified Knowledge Graph Context]:\n${contextLines.join('\n')}\n`;
  }

  /**
   * Extract candidate keywords from a user message for graph lookup.
   * Simple approach — identifies capitalized phrases and key terms.
   * Can be enhanced with NLP later.
   */
  public extractKeywords(message: string): string[] {
    const keywords: string[] = [];

    // Capitalized multi-word phrases (likely entities)
    const capitalizedPhrases = message.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g);
    if (capitalizedPhrases) {
      keywords.push(...capitalizedPhrases.filter((p) => p.length > 3));
    }

    // Known tech/framework names (case-insensitive)
    const techPatterns = [
      /\b(react|python|typescript|javascript|docker|kubernetes|mongodb|redis|node\.?js|deepseek|openai|llm|markov|btc|bitcoin|ethereum|solidity|rust|golang|next\.?js|tailwind|graphql|rest|api|grpc|kafka|rabbitmq|postgres|sqlite|linux|raspberry\s*pi|tensorflow|pytorch|ml|ai|nlp|blockchain)\b/gi,
    ];

    for (const pattern of techPatterns) {
      const matches = message.match(pattern);
      if (matches) {
        keywords.push(...matches);
      }
    }

    // Deduplicate
    return [...new Set(keywords.map((k) => k.toLowerCase()))];
  }

  /**
   * Deep multi-hop graph traversal. Starting from seed keywords, walks outward
   * up to `depth` hops, collecting the expanded subgraph. Returns formatted
   * context for the LLM with each hop labelled.
   */
  public async getDeepGraphContext(
    detectedKeywords: string[],
    depth: number = 2
  ): Promise<{
    context: string;
    hop_summary: string;
    total_edges: number;
    total_nodes: number;
  }> {
    if (detectedKeywords.length === 0) {
      return { context: '', hop_summary: '(no keywords)', total_edges: 0, total_nodes: 0 };
    }

    const seedIds = detectedKeywords.map((k) =>
      `node_${k.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    );

    const visitedEdges = new Set<string>();
    const visitedNodes = new Set<string>();
    const hopEdges: Array<{ source: string; target: string; relationship: string; weight: number; hop: number }> = [];
    let frontier = [...seedIds];

    // BFS outward from seed nodes
    for (let hop = 1; hop <= depth; hop++) {
      if (frontier.length === 0) break;

      const batchEdges = await this.db.collection('memory_edges').find({
        $or: [
          { source: { $in: frontier } },
          { target: { $in: frontier } },
        ],
        confidence: { $gt: 0.5 },
      })
        .sort({ weight: -1 })
        .limit(30)
        .toArray();

      const nextFrontier: string[] = [];
      const discoveredThisHop = new Set<string>();

      for (const edge of batchEdges) {
        const edgeKey = `${edge.source}::${edge.relationship}::${edge.target}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);

        hopEdges.push({
          source: edge.source as string,
          target: edge.target as string,
          relationship: edge.relationship as string,
          weight: edge.weight as number,
          hop,
        });

        // Collect newly discovered nodes for the next frontier.
        // Use discoveredThisHop to track per-hop discovery (visitedNodes lags by one hop).
        for (const nodeId of [edge.source as string, edge.target as string]) {
          if (!visitedNodes.has(nodeId)) {
            discoveredThisHop.add(nodeId);
            visitedNodes.add(nodeId);
            if (!seedIds.includes(nodeId)) {
              nextFrontier.push(nodeId);
            }
          }
        }
      }

      frontier = [...new Set(nextFrontier)];
    }

    if (hopEdges.length === 0) {
      return { context: '', hop_summary: '(no connections found)', total_edges: 0, total_nodes: 0 };
    }

    // Fetch node labels
    const nodeMap = new Map<string, string>();
    const nodes = await this.db.collection('memory_nodes')
      .find({ _id: { $in: [...visitedNodes] } })
      .project({ _id: 1, label: 1, type: 1 })
      .toArray();
    for (const node of nodes) {
      nodeMap.set(node._id as string, `${node.label} (${node.type})`);
    }

    // Format by hop depth
    const linesByHop: string[][] = [];
    for (let i = 1; i <= depth; i++) linesByHop.push([]);

    for (const e of hopEdges) {
      const srcLabel = nodeMap.get(e.source) || e.source;
      const tgtLabel = nodeMap.get(e.target) || e.target;
      const arrow = e.hop > 1 ? '↳' : '→';
      linesByHop[e.hop - 1].push(
        `  ${arrow} ${srcLabel} --[${e.relationship}]--> ${tgtLabel} (w=${e.weight})`
      );
    }

    const context =
      `\n[Deep Knowledge Graph Exploration — ${depth} hop(s) from: ${detectedKeywords.join(', ')}]:\n` +
      linesByHop
        .map((lines, i) => (lines.length > 0 ? `Hop ${i + 1}:\n${lines.join('\n')}` : `Hop ${i + 1}: (no new edges)`))
        .join('\n');

    const hop_summary = `Walked ${depth} hops from ${seedIds.length} seeds → ${hopEdges.length} edges across ${visitedNodes.size} nodes`;

    return {
      context,
      hop_summary,
      total_edges: hopEdges.length,
      total_nodes: visitedNodes.size,
    };
  }
}
