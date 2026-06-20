"""Live one-turn conversation test using the real Kolega Code agent + Katra hook."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

# Ensure the package is importable in case it was not installed.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from kolega_code.agent import CoderAgent
from kolega_code.agent.prompt_provider import AgentMode
from kolega_code.cli.config import build_agent_config
from kolega_code.cli.connection import CliConnectionManager
from kolega_code.cli.settings import SettingsStore
from kolega_code.hooks import HookDispatcher, load_hook_config


async def main() -> None:
    project = Path.home() / "Projects" / "katra"
    project = project.expanduser().resolve()

    settings_store = SettingsStore()
    settings = settings_store.load()

    # Use the configured provider/model/API keys.
    config = build_agent_config(project, settings=settings)
    print("Config:", json.dumps({
        "provider": config.long_context_config.provider.value,
        "model": config.long_context_config.model,
    }))

    # Load global hooks (from Application Support) + project hooks if trusted.
    hook_config = load_hook_config(
        project,
        settings_store.root,
        project_trusted=settings.is_hook_project_trusted(project),
    )
    dispatcher = HookDispatcher(hook_config)
    print("Hooks active:", dispatcher.is_active)
    if dispatcher.is_active:
        for event_name, entries in hook_config.entries.items():
            for matcher, specs in entries:
                for spec in specs:
                    print(f"  - {event_name.value}: {spec.type} {spec.callable or spec.command}")

    manager = CliConnectionManager()
    thread_id = f"live-test-{uuid.uuid4().hex[:8]}"
    agent = CoderAgent(
        project_path=project,
        workspace_id=f"harness-ws-{uuid.uuid4().hex[:8]}",
        thread_id=thread_id,
        connection_manager=manager,
        config=config,
        agent_mode=AgentMode.CLI,
        permission_mode="auto",
        hook_dispatcher=dispatcher,
    )

    print(f"\nUser: what were we working on?")
    print(f"Thread: {thread_id}\n")

    try:
        async for chunk in agent.process_message_stream("what were we working on?"):
            if chunk.get("type") == "response":
                text = chunk.get("content", "")
                if text:
                    print(text, end="", flush=True)
                if chunk.get("complete"):
                    print()
    finally:
        # Dump the first user message to prove the hook injected Katra context.
        if agent.history and len(agent.history) > 0:
            print("\n\n--- first user message blocks ---")
            first_msg = agent.history[0]
            for block in first_msg.content:
                print("BLOCK TYPE:", getattr(block, "type", "unknown"))
                print("TEXT:", getattr(block, "text", str(block))[:800])
                print()
        await agent.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
