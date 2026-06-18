#!/usr/bin/env python3
"""
Katra Migration Script — Migrate data from cognitive-memory-chat to Katra.

This script copies episodic events, semantic facts, knowledge graph, journal entries,
missions, and working memory from a cognitive-memory-chat MongoDB database to a Katra
MongoDB database. Both databases can be in the same MongoDB instance or different ones.

Usage:
    python3 migrate_from_cognitive_memory.py --source "mongodb://admin:***@localhost:27017/cognitive-memory?authSource=admin" --target "mongodb://admin:***@localhost:27017/katra?authSource=admin"

    # Dry run (count only, no copying):
    python3 migrate_from_cognitive_memory.py --source ... --target ... --dry-run

    # Specific collections only:
    python3 migrate_from_cognitive_memory.py --source ... --target ... --collections episodic_events,semantic_facts
"""

import argparse
import sys
import time
from pymongo import MongoClient

# Collections to migrate (source_name → target_name, same unless noted)
COLLECTIONS = {
    "episodic_events": "episodic_events",
    "semantic_facts": "semantic_facts",
    "knowledge_nodes": "knowledge_nodes",
    "knowledge_relationships": "knowledge_relationships",
    "memory_nodes": "memory_nodes",
    "memory_edges": "memory_edges",
    "memory_missions": "memory_missions",
    "working_memory_sessions": "working_memory_sessions",
    "heartbeat_journal": "heartbeat_journal",
    "agent_journal_auto": "agent_journal_auto",
    "agent_transaction_log": "agent_transaction_log",
    "time_block_summaries": "time_block_summaries",
    "temporal_patterns": "temporal_patterns",
    "asset_metadata": "asset_metadata",
    "compaction_queue": "compaction_queue",
}


def migrate(source_uri: str, target_uri: str, dry_run: bool = False,
            collections_filter: list = None, batch_size: int = 1000):
    print(f"{'DRY RUN: ' if dry_run else ''}Katra Migration")
    print(f"  Source: {source_uri.split('@')[-1] if '@' in source_uri else source_uri}")
    print(f"  Target: {target_uri.split('@')[-1] if '@' in target_uri else target_uri}")
    print()

    source_client = MongoClient(source_uri)
    target_client = MongoClient(target_uri)

    # Extract database names from URIs
    source_db_name = source_uri.split("/")[-1].split("?")[0]
    target_db_name = target_uri.split("/")[-1].split("?")[0]

    source_db = source_client[source_db_name]
    target_db = target_client[target_db_name]

    total_migrated = 0
    total_skipped = 0

    for src_name, tgt_name in COLLECTIONS.items():
        if collections_filter and src_name not in collections_filter:
            continue

        src_col = source_db[src_name]
        tgt_col = target_db[tgt_name]

        count = src_col.count_documents({})
        if count == 0:
            print(f"  ⏭️  {src_name}: 0 documents (skipped)")
            continue

        if dry_run:
            print(f"  📊 {src_name}: {count} documents (dry run)")
            total_migrated += count
            continue

        # Check what's already in target
        existing = tgt_col.count_documents({})
        if existing > 0:
            print(f"  ⚠️  {src_name}: target has {existing} documents, merging...")

        # Copy in batches
        migrated = 0
        skipped = 0
        for batch_start in range(0, count, batch_size):
            docs = list(src_col.find().skip(batch_start).limit(batch_size))

            # Remove _id to avoid conflicts, let MongoDB generate new ones
            for doc in docs:
                doc.pop("_id", None)

            if docs:
                result = tgt_col.insert_many(docs, ordered=False)
                migrated += len(result.inserted_ids)

        print(f"  ✅ {src_name}: {migrated} migrated ({existing} already existed)")
        total_migrated += migrated
        total_skipped += skipped

    # Create indexes on target
    if not dry_run:
        print()
        print("  📇 Creating indexes...")
        try:
            # Episodic events indexes
            target_db["episodic_events"].create_index([("user_id", 1), ("timestamp", -1)])
            target_db["episodic_events"].create_index([("session_id", 1)])
            target_db["episodic_events"].create_index([("event_type", 1)])
            target_db["episodic_events"].create_index([("content_hash", 1)], unique=True)
            print("    ✅ episodic_events indexes")

            # Semantic facts indexes
            target_db["semantic_facts"].create_index([("user_id", 1), ("confidence", -1)])
            target_db["semantic_facts"].create_index([("category", 1)])
            print("    ✅ semantic_facts indexes")

            # Knowledge graph indexes
            target_db["knowledge_nodes"].create_index([("user_id", 1), ("type", 1)])
            target_db["knowledge_nodes"].create_index([("name", 1)])
            target_db["knowledge_relationships"].create_index([("source_id", 1)])
            target_db["knowledge_relationships"].create_index([("target_id", 1)])
            print("    ✅ knowledge_graph indexes")

            # Memory nodes/edges
            target_db["memory_nodes"].create_index([("user_id", 1), ("type", 1)])
            target_db["memory_edges"].create_index([("source", 1), ("target", 1)])
            print("    ✅ memory_nodes/edges indexes")

            # Missions
            target_db["memory_missions"].create_index([("user_id", 1), ("status", 1)])
            print("    ✅ memory_missions indexes")

            # Journal
            target_db["agent_journal_auto"].create_index([("user_id", 1), ("created_at", -1)])
            target_db["heartbeat_journal"].create_index([("timestamp", -1)])
            print("    ✅ journal indexes")

            # Transaction log
            target_db["agent_transaction_log"].create_index([("timestamp", -1)])
            print("    ✅ transaction_log indexes")

            # Assets
            target_db["asset_metadata"].create_index([("user_id", 1), ("uploaded_at", -1)])
            print("    ✅ asset_metadata indexes")

        except Exception as e:
            print(f"    ⚠️  Index creation warning: {e}")

    print()
    print(f"{'Dry run' if dry_run else 'Migration'} complete: {total_migrated} documents {'would be ' if dry_run else ''}migrated, {total_skipped} skipped")

    source_client.close()
    target_client.close()


def main():
    parser = argparse.ArgumentParser(description="Migrate data from cognitive-memory-chat to Katra")
    parser.add_argument("--source", required=True, help="Source MongoDB URI (cognitive-memory-chat)")
    parser.add_argument("--target", required=True, help="Target MongoDB URI (Katra)")
    parser.add_argument("--dry-run", action="store_true", help="Count only, don't copy")
    parser.add_argument("--collections", default=None, help="Comma-separated list of collections to migrate")
    parser.add_argument("--batch-size", type=int, default=1000, help="Batch size for copying")
    args = parser.parse_args()

    collections_filter = args.collections.split(",") if args.collections else None

    start = time.time()
    migrate(args.source, args.target, args.dry_run, collections_filter, args.batch_size)
    elapsed = time.time() - start
    print(f"Elapsed: {elapsed:.1f}s")


if __name__ == "__main__":
    main()
