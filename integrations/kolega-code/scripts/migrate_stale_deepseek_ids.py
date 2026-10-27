#!/usr/bin/env python3
"""Migrate stale DeepSeek model ids to the canonical `deepseek-flash`.

Canonical target: deepseek-flash (DeepSeek-V4.1-Flash, text+image).
Stale -> new: deepseek-v4-pro, deepseek-v4-flash(-*), deepseek-v4.1-flash*,
              deepseek-chat, deepseek-reasoner, deepseek-coder  ==> deepseek-flash

Only files on an explicit per-machine allowlist are touched: history
(incident cards, session artifacts), measurement data (bench results,
PRICES tables) and third-party vendored catalogs are deliberately excluded.

Usage: migrate_stale_models.py <profile> [--apply]
       migrate_stale_models.py --files PATH[,PATH...] [--apply]
  profile: mac | thebrick | natasha
  --files:  explicit file list (use on machines without a profile; find the
            files first with scan_stale_models.py)
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime

# Longest-first so `deepseek-v4-flash-vision-exp` wins over `deepseek-v4-flash`.
STALE_TOKENS = [
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4.1-flash",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-reasoner",
    "deepseek-chat",
    "deepseek-coder",
]
TARGET = "deepseek-flash"

# Files whose stale ids are replaced by a synthetic test id instead: these
# exercise "an explicit override is sent verbatim", and using a real-but-retired
# alias would leave a stale id in live code (and using the canonical id would
# make the assertion vacuous).
OVERRIDE_TEST_FILES = {
    "~/Projects/data-maid/tests/test_maid_fuzzy.py",
    "~/Projects/ConstructionMarketData/tests/test_maid_fuzzy.py",
}

PROFILES = {
    "mac": [
        "~/creator-discovery/threads/classify.py",
        "~/Projects/katra-imagination/server/src/services/infrastructure/llm-service.ts",
        "~/Projects/katra-imagination/server/src/mcp-server.ts",
        "~/Projects/katra-imagination/server/src/routes/admin-routes.ts",
        "~/Projects/katra-imagination/dashboard/index.html",
        "~/Projects/katra-imagination/docs/CONFIGURATION.md",
        "~/Projects/katra-imagination/docs/QUICKSTART.md",
        "~/Projects/katra-imagination/docs/ARCHITECTURE.md",
        "~/Projects/katra-imagination/docs/Data-Processing-Pipelines.md",
        "~/Projects/katra-imagination/docs/MCP-TOOLS.md",
        "~/.katra/src/server/src/services/infrastructure/llm-service.ts",
        "~/.katra/src/server/src/mcp-server.ts",
        "~/.katra/src/server/src/routes/admin-routes.ts",
        "~/.katra/src/dashboard/index.html",
        "~/.katra/src/docs/MCP-TOOLS.md",
        "~/.katra/src/docs/CONFIGURATION.md",
        "~/.katra/src/docs/Data-Processing-Pipelines.md",
        "~/.katra/src/docs/QUICKSTART.md",
        "~/.katra/src/docs/ARCHITECTURE.md",
    ],
    "thebrick": [
        "~/Projects/data-maid/src/maid/fuzzy.py",
        "~/Projects/data-maid/tests/test_maid_fuzzy.py",
        "~/Projects/ConstructionMarketData/tests/test_maid_fuzzy.py",
        "~/live-polymarket-box/watcher/gas_law_watcher/config.py",
        "~/Katra-Agentic-Memory/.env",
    ],
    # Second pass on thebrick: repos/files the first profile did not cover
    # (found by the post-migration verification sweep).
    "thebrick2": [
        "~/Projects/data-maid/src/maid/search.py",
        "~/Projects/satori-scrape/tests/test_clicker.py",
        "~/Katra-Agentic-Memory/server/src/services/infrastructure/llm-service.ts",
        "~/Katra-Agentic-Memory/server/src/mcp-server.ts",
        "~/Katra-Agentic-Memory/server/src/routes/admin-routes.ts",
        "~/Katra-Agentic-Memory/dashboard/index.html",
        "~/Katra-Agentic-Memory/docs/MCP-TOOLS.md",
        "~/Katra-Agentic-Memory/docs/CONFIGURATION.md",
        "~/Katra-Agentic-Memory/docs/Data-Processing-Pipelines.md",
        "~/Katra-Agentic-Memory/docs/QUICKSTART.md",
        "~/Katra-Agentic-Memory/docs/ARCHITECTURE.md",
        "~/RankPilot/server/src/connectors/llm.ts",
        "~/RankPilot/server/tests/tools/llm.test.ts",
    ],
    "natasha": [
        "~/creator-discovery/threads/classify.py",
        "~/Katra-Agentic-Memory/server/src/services/infrastructure/llm-service.ts",
        "~/Katra-Agentic-Memory/server/src/mcp-server.ts",
        "~/Katra-Agentic-Memory/server/src/routes/admin-routes.ts",
        "~/Katra-Agentic-Memory/dashboard/index.html",
        "~/Katra-Agentic-Memory/docs/MCP-TOOLS.md",
        "~/Katra-Agentic-Memory/docs/CONFIGURATION.md",
        "~/Katra-Agentic-Memory/docs/Data-Processing-Pipelines.md",
        "~/Katra-Agentic-Memory/docs/QUICKSTART.md",
        "~/Katra-Agentic-Memory/docs/ARCHITECTURE.md",
        "~/RankPilot/server/src/connectors/llm.ts",
        "~/RankPilot/server/tests/tools/llm.test.ts",
    ],
}

STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")


def token_re(tok: str) -> re.Pattern:
    # Not followed by another id character, so `deepseek-v4-flash-0731`
    # (a distinct id) is not silently rewritten.
    return re.compile(re.escape(tok) + r"(?![\w.-])", re.IGNORECASE)


def migrate_text(text: str, synthetic: bool) -> tuple[str, dict]:
    counts: dict[str, int] = {}
    for tok in STALE_TOKENS:
        if synthetic and tok == "deepseek-v4-flash-vision-exp":
            new = "test-override-model"
        else:
            new = TARGET
        text, n = token_re(tok).subn(new, text)
        if n:
            counts[tok] = n
    return text, counts


def main() -> int:
    argv = sys.argv[1:]
    apply = "--apply" in argv
    args = [a for a in argv if not a.startswith("--")]
    if "--files" in argv:
        idx = argv.index("--files")
        if idx + 1 >= len(argv):
            print("--files needs a comma-separated list")
            return 2
        files = [f.strip() for f in argv[idx + 1].split(",") if f.strip()]
        profile = "explicit-files"
    elif args and args[0] in PROFILES:
        profile = args[0]
        files = PROFILES[profile]
    else:
        print(__doc__)
        return 2

    total = 0
    print(f"profile={profile} mode={'APPLY' if apply else 'DRY-RUN'}")
    for raw in files:
        path = os.path.expanduser(raw)
        synthetic = raw in OVERRIDE_TEST_FILES
        if not os.path.isfile(path):
            print(f"  MISSING  {raw}")
            continue
        with open(path, encoding="utf-8") as fh:
            original = fh.read()
        updated, counts = migrate_text(original, synthetic)
        if not counts:
            print(f"  clean    {raw}")
            continue
        detail = ", ".join(f"{k}x{v}" for k, v in counts.items())
        print(f"  CHANGE   {raw}  [{detail}]")
        total += sum(counts.values())
        if apply:
            bak = f"{path}.bak-stale-models-{STAMP}"
            with open(bak, "w", encoding="utf-8") as fh:
                fh.write(original)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(updated)
            print(f"           backup -> {os.path.basename(bak)}")
    print(f"total replacements: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
