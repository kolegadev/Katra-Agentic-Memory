# CONTRACT: Agent Pub-Sub Message Bus

**Goal:** Add a Redis-backed pub-sub discovery and messaging layer so agents on
the internal network can advertise their interests, discover peers, and form
ad-hoc collaboration channels — without replacing the existing hybrid-memory
architecture.

**Boundaries (must NOT touch):**
- Katra MCP server (`server/src/`) — no changes
- Hybrid memory model (shared + private) — no changes
- Docker Compose / infrastructure — Redis already present
- Existing `wake_service.py` — it already handles event delivery; I will extend
  its channel pattern, not replace it
- `.env` files on any machine — no credential changes needed

**Success Criteria:**
1. `SC-A`: Agents can REGISTER their presence (name, interests, capabilities)
2. `SC-B`: Agents can DISCOVER other agents and their advertised topics
3. `SC-C`: Agents can PUBLISH to topic channels (not just `katra:events:{shared}`)
4. `SC-D`: Agents can SUBSCRIBE to topic channels and receive messages in real-time
5. `SC-E`: A Python module (`katra_pubsub.py`) exists that any agent script can
   `from katra_pubsub import AgentBus` with zero config beyond defaults
6. `SC-F`: Documentation exists explaining how agents use the bus for
   discovery, collaboration, and the dual-hemisphere pattern

**Interfaces:**
```python
class AgentBus:
    def __init__(self, agent_id: str, shared_id: str = "my-team",
                 redis_host: str = "localhost", redis_port: int = 6384)
    def register(self, interests: list[str], capabilities: list[str]) -> None
    def discover(self) -> dict[str, dict]  # agent_id -> {interests, capabilities, last_seen}
    def publish(self, topic: str, message: dict) -> None
    def subscribe(self, topics: list[str], callback: callable) -> None
    def send_to_agent(self, target: str, message: str, urgent: bool = False) -> None
    def heartbeat(self) -> None  # periodic presence refresh
```

**Redis Channel Layout:**
```
katra:presence           → Agent registration/deregistration (Hash: agent_id → JSON)
katra:presence:heartbeat → TTL-based keepalive pings
katra:topics:{topic}     → Per-topic pub-sub channels
katra:events:{shared_id} → Existing inter-agent events (wake_service already listens)
```
