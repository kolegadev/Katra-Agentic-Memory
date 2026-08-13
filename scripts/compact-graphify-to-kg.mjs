#!/usr/bin/env node
/**
 * Compact Graphify seed semantic facts directly into knowledge_nodes
 * and knowledge_relationships. Bypasses the episodic backlog.
 */
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:change-me@localhost:27017/katra?authSource=admin';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  console.log('Connected to MongoDB');

  // Get all graphify-seed semantic facts
  const facts = await db.collection('semantic_facts')
    .find({ tags: 'graphify-seed' })
    .toArray();

  console.log(`Found ${facts.length} graphify-seed semantic facts`);

  let nodesCreated = 0;
  let edgesCreated = 0;
  let nodeErrors = 0;
  let edgeErrors = 0;

  for (const fact of facts) {
    try {
      const data = JSON.parse(fact.content);
      
      if (data.action === 'node_discovered' && data.node) {
        const node = data.node;
        const nodeId = `graphify:${node.name.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
        
        await db.collection('knowledge_nodes').updateOne(
          { id: nodeId },
          {
            $set: {
              type: node.type || 'file',
              name: node.name,
              properties: {
                name: node.name,
                source_path: node.source_path || null,
                code_language: node.language || null,
                community: node.community || null,
                community_name: node.community_name || null,
                summary: `Graphify-seeded ${node.type || 'file'}: ${node.name}`,
              },
              source: 'graphify-seed',
              updated_at: new Date(),
            },
            $setOnInsert: {
              id: nodeId,
              user_id: 'kolega-agent',
              created_at: new Date(),
            },
          },
          { upsert: true }
        );
        nodesCreated++;
      }
      
      if (data.action === 'edge_discovered' && data.edge) {
        const edge = data.edge;
        const fromId = `graphify:${edge.from.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
        const toId = `graphify:${edge.to.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
        const edgeType = edge.type || 'related_to';
        const edgeId = `graphify:edge:${fromId}:${edgeType}:${toId}`;
        
        await db.collection('knowledge_relationships').updateOne(
          { id: edgeId },
          {
            $set: {
              relationship_type: edgeType,
              from_id: fromId,
              to_id: toId,
              strength: edge.weight || 1.0,
              properties: { weight: edge.weight || 1 },
              source: 'graphify-seed',
              updated_at: new Date(),
            },
            $setOnInsert: {
              id: edgeId,
              user_id: 'kolega-agent',
              created_at: new Date(),
            },
          },
          { upsert: true }
        );
        edgesCreated++;
      }
    } catch (e) {
      if (fact.content && fact.content.includes('node_discovered')) {
        nodeErrors++;
        if (nodeErrors <= 3) console.warn(`  Node error: ${e.message}`);
      } else {
        edgeErrors++;
        if (edgeErrors <= 3) console.warn(`  Edge error: ${e.message}`);
      }
    }
    
    if ((nodesCreated + edgesCreated) % 1000 === 0) {
      console.log(`  Progress: ${nodesCreated} nodes, ${edgesCreated} edges`);
    }
  }

  console.log(`Done. ${nodesCreated} nodes, ${edgesCreated} edges (${nodeErrors}/${edgeErrors} errors)`);
  
  // Print final counts
  const totalNodes = await db.collection('knowledge_nodes').countDocuments({});
  const totalEdges = await db.collection('knowledge_relationships').countDocuments({});
  const codeNodes = await db.collection('knowledge_nodes').countDocuments({ source: 'graphify-seed' });
  console.log(`\nKnowledge Graph totals:`);
  console.log(`  Total nodes: ${totalNodes} (${codeNodes} from graphify seed)`);
  console.log(`  Total edges: ${totalEdges}`);

  await client.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
