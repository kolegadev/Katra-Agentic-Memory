#!/usr/bin/env python3
"""Parity test — the canonical personality registry, the bridge and the server.

Run:  python3 integrations/kolega-code/scripts/test_personality_registry.py
      (from the repository root; stdlib only, no pytest)

ITER-1 made `shared/personality/registry.json` the single source of truth for the
ten memory personality profiles. The generator renders it into
`personality_registry.generated.py`, which `personality.py` loads; this script
proves the two agree, that the runtime still behaves the way it did before the
registry existed, and that no number was invented on the way:

  1. the registry is well-formed: version, the eleven sources, ten profiles
  2. the generated artifact carries the registry's values, key order and types
     (the artifact's file name contains a dot, so it is loaded by path)
  3. personality.py materialises exactly those values, agent_message included
  4. resolve_profile still drops unknown weights, re-pins agent_message to 10.0
     even when a caller overrides it, and accepts scoring overrides only for
     known keys
  5. every profile matches the pre-change module at 48ba7e6 (read from git, so
     the expectation cannot be self-reported). Skipped loudly if the checkout
     cannot provide that commit.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BRIDGE_DIR = HERE.parent / "kolega_katra_bridge"
REPO_ROOT = HERE.parents[2]
REGISTRY_PATH = REPO_ROOT / "shared" / "personality" / "registry.json"
GENERATED_PATH = BRIDGE_DIR / "personality_registry.generated.py"

PRE_CHANGE_COMMIT = "48ba7e6"
PRE_CHANGE_FILE = "integrations/kolega-code/kolega_katra_bridge/personality.py"

SCORING_FIELDS = {
    "k": "relevance_multiplier",
    "half_life_days": "recency_half_life_days",
    "cap_pct": "max_single_source_pct",
    "floors": "budget_floors",
    "vector_fetch_limit": "vector_fetch_limit",
    "vector_sample": "vector_sample",
    "min_fetch_weight": "min_fetch_weight",
}

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


def section(name: str) -> None:
    print(f"\n{name}")


def load_by_path(name: str, path: Path) -> Any:
    """Load a module from a path whose file name is not a valid module name."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve their module through sys.modules
    spec.loader.exec_module(module)
    return module


def effective_scoring(registry: dict, entry: dict) -> dict:
    """The registry's declared value for every scoring key: defaults + overrides."""
    scoring = dict(registry["default_scoring"])
    scoring.update(entry.get("scoring", {}))
    return scoring


def describe(profile: Any) -> dict:
    return {
        "name": profile.name,
        "description": profile.description,
        "weights": profile.weights,
        "relevance_multiplier": profile.relevance_multiplier,
        "recency_half_life_days": profile.recency_half_life_days,
        "budget_floors": profile.budget_floors,
        "max_single_source_pct": profile.max_single_source_pct,
        "vector_fetch_limit": profile.vector_fetch_limit,
        "vector_sample": profile.vector_sample,
        "min_fetch_weight": profile.min_fetch_weight,
    }


def main() -> int:
    sys.path.insert(0, str(HERE.parent))
    from kolega_katra_bridge import personality  # noqa: E402

    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    generated = load_by_path("personality_registry_probe", GENERATED_PATH)
    profile_names = list(registry["profiles"])
    sources = list(registry["sources"])

    # ---- 1: the registry itself -------------------------------------------
    section("1. shared/personality/registry.json is well-formed")
    check("registry_version is 1.0", registry["registry_version"] == "1.0", repr(registry["registry_version"]))
    check("eleven sources, no duplicates", len(sources) == 11 == len(set(sources)), str(len(sources)))
    check("ten profiles, balanced first", len(profile_names) == 10 and profile_names[0] == "balanced",
          str(profile_names))
    check("each profile declares the ten sources other than the pinned agent_message",
          all(set(entry["weights"]) == set(sources) - {"agent_message"} for entry in registry["profiles"].values()))
    check("agent_message weight is the 10.0 invariant", registry["agent_message_weight"] == 10.0,
          repr(registry["agent_message_weight"]))
    check("recommended_budgets cover the ten profiles",
          sorted(registry["recommended_budgets"]) == sorted(profile_names))

    # ---- 2: the generated artifact ----------------------------------------
    section("2. personality_registry.generated.py carries the registry")
    check("generated AGENT_MESSAGE_WEIGHT", generated.AGENT_MESSAGE_WEIGHT == registry["agent_message_weight"] == 10.0)
    check("generated AGENT_MESSAGE_WEIGHT is a float", isinstance(generated.AGENT_MESSAGE_WEIGHT, float))
    check("generated ALL_SOURCES matches, as a tuple",
          isinstance(generated.ALL_SOURCES, tuple) and list(generated.ALL_SOURCES) == sources)
    check("generated REFLECTION_FAMILY matches, as a tuple",
          isinstance(generated.REFLECTION_FAMILY, tuple)
          and list(generated.REFLECTION_FAMILY) == list(registry["reflection_family"]))
    check("generated DEFAULT_SCORING matches the registry key for key",
          generated.DEFAULT_SCORING == registry["default_scoring"],
          f"{generated.DEFAULT_SCORING} != {registry['default_scoring']}")
    check("generated DEFAULT_SCORING keeps its key order",
          list(generated.DEFAULT_SCORING) == list(registry["default_scoring"]))
    check("generated default vector_fetch_limit is an int",
          isinstance(generated.DEFAULT_SCORING["vector_fetch_limit"], int)
          and not isinstance(generated.DEFAULT_SCORING["vector_fetch_limit"], bool))
    check("generated default vector_sample is a bool",
          isinstance(generated.DEFAULT_SCORING["vector_sample"], bool))
    check("generated RECOMMENDED_BUDGETS matches", generated.RECOMMENDED_BUDGETS == registry["recommended_budgets"])
    check("generated PROFILE_DATA carries the ten profiles in registry order",
          list(generated.PROFILE_DATA) == profile_names)
    for name in profile_names:
        entry = generated.PROFILE_DATA[name]
        declared = registry["profiles"][name]
        check(f"{name}: generated entry matches the registry",
              entry == declared, f"{entry} != {declared}")
        check(f"{name}: generated weights keep their key order",
              list(entry["weights"]) == list(declared["weights"]))
        check(f"{name}: generated scoring keeps its key order",
              list(entry["scoring"]) == list(declared["scoring"]))

    # ---- 3: personality.py materialises the registry -----------------------
    section("3. personality.py resolves the registry's values")
    check("AGENT_MESSAGE_WEIGHT is 10.0", personality.AGENT_MESSAGE_WEIGHT == 10.0)
    check("ALL_SOURCES matches the registry",
          isinstance(personality.ALL_SOURCES, tuple) and list(personality.ALL_SOURCES) == sources)
    check("REFLECTION_FAMILY matches the registry",
          list(personality.REFLECTION_FAMILY) == list(registry["reflection_family"]))
    check("DEFAULT_MIN_FETCH_WEIGHT matches the registry",
          personality.DEFAULT_MIN_FETCH_WEIGHT == registry["default_scoring"]["min_fetch_weight"])
    check("PROFILES carries the ten profiles in registry order", list(personality.PROFILES) == profile_names)

    defaults = personality.PersonalityProfile(name="probe", description="probe", weights={})
    check("dataclass defaults come from the registry's default scoring",
          describe(defaults) == {
              "name": "probe",
              "description": "probe",
              "weights": {},
              "relevance_multiplier": registry["default_scoring"]["k"],
              "recency_half_life_days": registry["default_scoring"]["half_life_days"],
              "budget_floors": registry["default_scoring"]["floors"],
              "max_single_source_pct": registry["default_scoring"]["cap_pct"],
              "vector_fetch_limit": registry["default_scoring"]["vector_fetch_limit"],
              "vector_sample": registry["default_scoring"]["vector_sample"],
              "min_fetch_weight": registry["default_scoring"]["min_fetch_weight"],
          })

    for name in profile_names:
        declared = registry["profiles"][name]
        scoring = effective_scoring(registry, declared)
        resolved = personality.PROFILES[name]
        expected_weights = dict(declared["weights"])
        expected_weights["agent_message"] = registry["agent_message_weight"]
        check(f"{name}: resolved profile equals the registry",
              describe(resolved) == {
                  "name": name,
                  "description": declared["description"],
                  "weights": expected_weights,
                  "relevance_multiplier": scoring["k"],
                  "recency_half_life_days": scoring["half_life_days"],
                  "budget_floors": scoring["floors"],
                  "max_single_source_pct": scoring["cap_pct"],
                  "vector_fetch_limit": scoring["vector_fetch_limit"],
                  "vector_sample": scoring["vector_sample"],
                  "min_fetch_weight": scoring["min_fetch_weight"],
              })
        check(f"{name}: weights keep their key order, agent_message last",
              list(resolved.weights) == list(declared["weights"]) + ["agent_message"],
              str(list(resolved.weights)))
        check(f"{name}: budget floors keep their key order",
              list(resolved.budget_floors) == list(scoring["floors"]))
        check(f"{name}: vector_fetch_limit is an int",
              isinstance(resolved.vector_fetch_limit, int) and not isinstance(resolved.vector_fetch_limit, bool))
        check(f"{name}: weight_for('agent_message') is the invariant",
              resolved.weight_for("agent_message") == 10.0)
        check(f"{name}: should_fetch('agent_message') is always true", resolved.should_fetch("agent_message") is True)

    # ---- 4: resolve_profile behaviour --------------------------------------
    section("4. resolve_profile invariants and overrides")
    for name in (None, "", "nope", "BALANCED"):
        check(f"resolve_profile({name!r}) falls back to balanced",
              personality.resolve_profile(name).name == "balanced")
    check("resolve_profile is case-insensitive for a known profile",
          personality.resolve_profile("  DREAMER  ").name == "dreamer")
    check("resolve_profile returns the shared profile object when there are no overrides",
          personality.resolve_profile("scholar") is personality.PROFILES["scholar"])

    pinned = personality.resolve_profile("balanced", {"agent_message": 0.5})
    check("a caller cannot lower agent_message", pinned.weights["agent_message"] == 10.0,
          repr(pinned.weights["agent_message"]))
    check("pinning keeps the other overrides", pinned.weights["missions"] == personality.PROFILES["balanced"].weights["missions"])
    check("a zeroed agent_message is still re-pinned",
          personality.resolve_profile("balanced", {"agent_message": 0.0}).weights["agent_message"] == 10.0)
    check("agent_message is not overridable through scoring either",
          personality.resolve_profile("balanced", None, {"agent_message": 1.0}).weights["agent_message"] == 10.0)

    custom = personality.resolve_profile("empath", {"missions": 6.0, "not_a_source": 3.0},
                                         {"relevance_multiplier": 4.0, "not_a_field": 1.0})
    check("known weight override applied", custom.weights["missions"] == 6.0, repr(custom.weights["missions"]))
    check("unknown weight source ignored (weight absent)",
          "not_a_source" not in custom.weights and not hasattr(custom, "not_a_source"))
    check("known scoring override applied", custom.relevance_multiplier == 4.0, repr(custom.relevance_multiplier))
    check("unknown scoring key ignored, nothing added",
          not hasattr(custom, "not_a_field") and set(vars(custom)) == set(vars(personality.PROFILES["empath"])))
    check("overridden profile is marked as custom",
          custom.name == "empath+custom" and custom.description.endswith("(with user overrides)"),
          custom.name)
    check("overrides do not mutate the shared profile",
          personality.PROFILES["empath"].weights["missions"] == 1.5
          and personality.PROFILES["empath"].relevance_multiplier == 2.0)
    check("non-numeric weight override ignored",
          personality.resolve_profile("balanced", {"missions": "high"}).weights["missions"]
          == personality.PROFILES["balanced"].weights["missions"])

    # ---- 5: zero drift against the pre-registry module ----------------------
    section(f"5. every profile is what the bridge shipped at {PRE_CHANGE_COMMIT}")
    try:
        source = subprocess.run(
            ["git", "show", f"{PRE_CHANGE_COMMIT}:{PRE_CHANGE_FILE}"],
            cwd=REPO_ROOT, check=True, capture_output=True, text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"  SKIP  git cannot provide {PRE_CHANGE_COMMIT}:{PRE_CHANGE_FILE} ({exc})")
        print("        run this script in a full checkout to exercise the anti-drift proof")
    else:
        with tempfile.TemporaryDirectory(prefix="personality-drift-") as tmp:
            old_path = Path(tmp) / f"personality_at_{PRE_CHANGE_COMMIT}.py"
            old_path.write_text(source, encoding="utf-8")
            old = load_by_path("personality_at_pre_change", old_path)
        check("pre-change module exposes the same ten profiles", list(old.PROFILES) == profile_names)
        for name in profile_names:
            before = describe(old.PROFILES[name])
            after = describe(personality.PROFILES[name])
            check(f"{name}: unchanged since {PRE_CHANGE_COMMIT}", before == after,
                  "; ".join(f"{key}: {before[key]!r} -> {after[key]!r}"
                            for key in before if before[key] != after[key]))
        check("ALL_SOURCES unchanged", list(old.ALL_SOURCES) == sources)
        check("REFLECTION_FAMILY unchanged", list(old.REFLECTION_FAMILY) == list(personality.REFLECTION_FAMILY))
        check("DEFAULT_MIN_FETCH_WEIGHT unchanged",
              old.DEFAULT_MIN_FETCH_WEIGHT == personality.DEFAULT_MIN_FETCH_WEIGHT)
        for name in (None, "", "nope", "  DREAMER  ", "legacy"):
            check(f"resolve_profile({name!r}) unchanged",
                  describe(old.resolve_profile(name)) == describe(personality.resolve_profile(name)))
        check("weight + scoring overrides behave unchanged",
              describe(old.resolve_profile("sentinel", {"missions": 6.0}, {"recency_half_life_days": 7.0}))
              == describe(personality.resolve_profile("sentinel", {"missions": 6.0}, {"recency_half_life_days": 7.0})))

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {', '.join(failures[:10])}"
              + (" ..." if len(failures) > 10 else ""))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
