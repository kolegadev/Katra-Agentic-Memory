"""
Agent Pub-Sub Bus — Redis-backed discovery and messaging for Katra agents.

Thin layer on top of Redis pub-sub. Agents register their presence, discover
peers, and form ad-hoc collaboration channels. Complements the hybrid-memory
architecture (shared + private) without touching Katra's MCP server.

Usage:
    from katra_pubsub import AgentBus

    bus = AgentBus("kolega-agent")
    bus.register(interests=["code-review", "architecture"], capabilities=["python", "typescript"])

    # Discover peers
    peers = bus.discover()
    for agent_id, info in peers.items():
        print(f"{agent_id} is interested in {info['interests']}")

    # Subscribe to a topic
    def on_message(msg):
        print(f"Received on {msg['channel']}: {msg['data']}")

    bus.subscribe(["code-review", "architecture"], on_message)

    # Publish to a topic
    bus.publish("code-review", {"type": "review-request", "file": "src/main.py"})

    # Send direct inter-agent message
    bus.send_to_agent("opencode-agent", "Attention: OpenCode — can you review this?")
"""

from __future__ import annotations

import json
import os
import time
import threading
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import redis

logger = logging.getLogger("katra_pubsub")

# ── Constants ──────────────────────────────────────────────────────────────
DEFAULT_REDIS_HOST = os.environ.get("KATRA_REDIS_HOST", "localhost")
DEFAULT_REDIS_PORT = int(os.environ.get("KATRA_REDIS_PORT", "6384"))
DEFAULT_SHARED_ID = os.environ.get("KATRA_SHARED_ID", "my-team")
PRESENCE_KEY = "katra:presence"
PRESENCE_TTL = 120  # seconds — agents must heartbeat within this window
HEARTBEAT_CHANNEL = "katra:presence:heartbeat"


class AgentBus:
    """Agent pub-sub bus. One instance per agent process."""

    def __init__(
        self,
        agent_id: str,
        shared_id: str = DEFAULT_SHARED_ID,
        redis_host: str = DEFAULT_REDIS_HOST,
        redis_port: int = DEFAULT_REDIS_PORT,
    ):
        self.agent_id = agent_id
        self.shared_id = shared_id
        self.redis_host = redis_host
        self.redis_port = redis_port
        self._redis: Optional[redis.Redis] = None
        self._pubsub: Optional[redis.client.PubSub] = None
        self._subscriber_thread: Optional[threading.Thread] = None
        self._running = False
        self._registered = False

    # ── Connection ──────────────────────────────────────────────────────

    def _connect(self) -> redis.Redis:
        if self._redis is None:
            self._redis = redis.Redis(
                host=self.redis_host,
                port=self.redis_port,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_keepalive=True,
            )
            self._redis.ping()
        return self._redis

    # ── Registration / Presence ─────────────────────────────────────────

    def register(self, interests: list[str] = None, capabilities: list[str] = None) -> bool:
        """
        Register this agent on the bus. Call once at startup.
        Interests: topics this agent wants to collaborate on.
        Capabilities: what this agent can do (skills, languages, tools).
        """
        try:
            r = self._connect()
            presence_data = json.dumps({
                "agent_id": self.agent_id,
                "interests": interests or [],
                "capabilities": capabilities or [],
                "registered_at": datetime.now(timezone.utc).isoformat(),
                "last_seen": datetime.now(timezone.utc).isoformat(),
            })
            r.hset(PRESENCE_KEY, self.agent_id, presence_data)
            self._registered = True
            logger.info(f"[{self.agent_id}] Registered on bus. Interests: {interests}. Capabilities: {capabilities}.")
            return True
        except (redis.ConnectionError, redis.RedisError) as e:
            logger.error(f"[{self.agent_id}] Registration failed: {e}")
            return False

    def heartbeat(self) -> bool:
        """Refresh presence TTL. Call periodically (every 30-60s)."""
        if not self._registered:
            return False
        try:
            r = self._connect()
            # Publish heartbeat pulse
            r.publish(HEARTBEAT_CHANNEL, json.dumps({
                "agent_id": self.agent_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }))
            # Update last_seen in presence hash
            current = r.hget(PRESENCE_KEY, self.agent_id)
            if current:
                data = json.loads(current)
                data["last_seen"] = datetime.now(timezone.utc).isoformat()
                r.hset(PRESENCE_KEY, self.agent_id, json.dumps(data))
            return True
        except Exception as e:
            logger.debug(f"[{self.agent_id}] Heartbeat failed: {e}")
            return False

    def deregister(self) -> bool:
        """Remove this agent from the presence registry. Call on shutdown."""
        try:
            r = self._connect()
            r.hdel(PRESENCE_KEY, self.agent_id)
            self._registered = False
            logger.info(f"[{self.agent_id}] Deregistered from bus.")
            return True
        except Exception as e:
            logger.error(f"[{self.agent_id}] Deregistration failed: {e}")
            return False

    # ── Discovery ───────────────────────────────────────────────────────

    def discover(self, include_self: bool = False) -> dict[str, dict]:
        """
        Return all registered agents and their advertised info.
        Returns: {agent_id: {interests, capabilities, last_seen, registered_at}}
        Agents not seen within PRESENCE_TTL are excluded (stale).
        """
        try:
            r = self._connect()
            all_agents = r.hgetall(PRESENCE_KEY)
            result = {}
            now = datetime.now(timezone.utc)
            for agent_id, raw in all_agents.items():
                if not include_self and agent_id == self.agent_id:
                    continue
                try:
                    data = json.loads(raw)
                    last_seen_str = data.get("last_seen", "")
                    if last_seen_str:
                        last_seen = datetime.fromisoformat(last_seen_str)
                        if (now - last_seen).total_seconds() > PRESENCE_TTL:
                            # Stale — clean up
                            r.hdel(PRESENCE_KEY, agent_id)
                            continue
                    result[agent_id] = data
                except (json.JSONDecodeError, ValueError):
                    r.hdel(PRESENCE_KEY, agent_id)
            return result
        except Exception as e:
            logger.error(f"[{self.agent_id}] Discovery failed: {e}")
            return {}

    def find_by_interest(self, topic: str) -> list[str]:
        """Return agent_ids interested in a specific topic."""
        peers = self.discover()
        return [aid for aid, info in peers.items() if topic in info.get("interests", [])]

    def find_by_capability(self, capability: str) -> list[str]:
        """Return agent_ids advertising a specific capability."""
        peers = self.discover()
        return [aid for aid, info in peers.items() if capability in info.get("capabilities", [])]

    # ── Topic Pub-Sub ───────────────────────────────────────────────────

    def _topic_channel(self, topic: str) -> str:
        return f"katra:topics:{topic}"

    def publish(self, topic: str, message: dict) -> bool:
        """
        Publish a message to a topic channel. Any agent subscribed to this
        topic will receive it. Message must be a JSON-serializable dict.
        """
        try:
            r = self._connect()
            payload = {
                "from": self.agent_id,
                "topic": topic,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": message,
            }
            r.publish(self._topic_channel(topic), json.dumps(payload))
            logger.debug(f"[{self.agent_id}] Published to '{topic}': {json.dumps(message)[:200]}")
            return True
        except Exception as e:
            logger.error(f"[{self.agent_id}] Publish to '{topic}' failed: {e}")
            return False

    def subscribe(self, topics: list[str], callback: Callable[[dict], None] = None) -> None:
        """
        Subscribe to one or more topic channels. Messages arrive via callback
        in a background thread. Callback receives the full message dict
        including: from, topic, timestamp, data, _channel.

        The callback runs in a daemon thread — keep it lightweight.
        If no callback given, override _on_message() in a subclass instead.
        """
        if not topics:
            return

        if callback is not None:
            self._user_callback = callback

        channels = [self._topic_channel(t) for t in topics]

        if self._pubsub is None:
            r = self._connect()
            self._pubsub = r.pubsub(ignore_subscribe_messages=True)
            self._running = True

        self._pubsub.subscribe(*channels)
        logger.info(f"[{self.agent_id}] Subscribed to topics: {topics}")

        # Start listener thread if not already running
        if self._subscriber_thread is None or not self._subscriber_thread.is_alive():
            self._subscriber_thread = threading.Thread(
                target=self._listen,
                daemon=True,
                name=f"katra-pubsub-{self.agent_id}",
            )
            self._subscriber_thread.start()

    def _listen(self) -> None:
        """Background thread: listen for messages on subscribed channels."""
        while self._running and self._pubsub:
            try:
                message = self._pubsub.get_message(timeout=1.0)
                if message and message.get("type") == "message":
                    try:
                        data = json.loads(message.get("data", "{}"))
                        # Don't process my own messages
                        if data.get("from") != self.agent_id:
                            # Include channel info
                            data["_channel"] = message.get("channel", "")
                            self._dispatch(data)
                    except json.JSONDecodeError:
                        pass
            except ValueError:
                # Closed during shutdown — expected
                break
            except (redis.ConnectionError, redis.RedisError) as e:
                logger.error(f"[{self.agent_id}] Subscriber connection lost: {e}")
                time.sleep(5)
                self._reconnect_subscriber()
            except Exception as e:
                logger.error(f"[{self.agent_id}] Subscriber error: {e}")
                time.sleep(1)

    def _reconnect_subscriber(self) -> None:
        """Attempt to reconnect after Redis connection loss."""
        try:
            if self._pubsub and self._pubsub.channels:
                channels = list(self._pubsub.channels.keys())
                self._pubsub = self._connect().pubsub(ignore_subscribe_messages=True)
                self._pubsub.subscribe(*channels)
        except Exception:
            pass

    def _dispatch(self, message: dict) -> None:
        """Dispatch message to user callback or _on_message override."""
        if hasattr(self, '_user_callback') and self._user_callback:
            try:
                self._user_callback(message)
            except Exception as e:
                logger.error(f"[{self.agent_id}] Callback error: {e}")
        else:
            self._on_message(message)

    def _on_message(self, message: dict) -> None:
        """Override this in a subclass for message handling without a callback."""
        pass

    # ── Direct Inter-Agent Messaging ────────────────────────────────────

    def send_to_agent(self, target: str, message: str, urgent: bool = False) -> bool:
        """
        Send a direct message to another agent via the inter-agent events
        channel. The wake_service will deliver it to the target agent.
        Format: "Attention: TargetName — your message here"
        """
        try:
            # Publish to the existing inter-agent events channel
            # The wake_service listens here and delivers to the target
            r = self._connect()
            event_channel = f"katra:events:{self.shared_id}"

            # Format the attention message
            if not message.startswith("Attention:"):
                # Extract agent short name from agent_id
                short_name = target.replace("-agent", "").replace("_", " ").title().replace(" ", "")
                message = f"Attention: {short_name} — {message}"

            payload = {
                "type": "inter-agent-message",
                "event_id": f"direct-{self.agent_id}-{target}-{int(time.time())}",
                "content_preview": message,
                "tags": ["inter-agent", "direct-message"] + (["priority"] if urgent else []),
                "from": self.agent_id,
                "target": target,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            r.publish(event_channel, json.dumps(payload))
            logger.info(f"[{self.agent_id}] → [{target}]: {message[:120]}")
            return True
        except Exception as e:
            logger.error(f"[{self.agent_id}] Send to {target} failed: {e}")
            return False

    # ── Lifecycle ───────────────────────────────────────────────────────

    def stop(self) -> None:
        """Clean shutdown: deregister and close connections."""
        self._running = False
        self.deregister()
        if self._pubsub:
            try:
                self._pubsub.close()
            except Exception:
                pass
        if self._redis:
            try:
                self._redis.close()
            except Exception:
                pass
        if self._subscriber_thread and self._subscriber_thread.is_alive():
            self._subscriber_thread.join(timeout=2)
        logger.info(f"[{self.agent_id}] Bus stopped.")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stop()
