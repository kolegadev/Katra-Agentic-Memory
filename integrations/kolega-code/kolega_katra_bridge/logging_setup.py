"""Persistent logging setup for the Katra bridge.

The hook runs inside each (ephemeral) kolega-code session process, so log
records emitted via ``logging`` normally vanish into that process's stderr.
This module attaches a rotating file handler to the package logger so the
retrieval diagnostics — ``Katra fetch [personality=...]`` and
``Injecting N memories ... [per-source=...]`` — persist across sessions and
can be watched over days while tuning personality.

Design:
* Idempotent: ``configure_logging`` is called on every prompt but only
  installs the handler once per process (guarded by a module flag and a
  handler tag).
* Package-scoped: the handler is attached to the ``kolega_katra_bridge``
  logger so records from every submodule (``.retriever``, ``.config``, …)
  propagate to it.
* Fail-open: if the log directory/file can't be created, the hook must not
  crash — we simply skip the file handler and leave stderr logging intact.
* Level tracks the ``debug`` flag: DEBUG when debug is on, INFO otherwise.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import BridgeConfig, _default_state_dir

# Tag used to identify our handler so we never add it twice.
_HANDLER_NAME = "katra-bridge-file"
_PACKAGE_LOGGER = "kolega_katra_bridge"

# 2 MB per file, keep 3 rotations (~8 MB total). Enough for days of prompts.
_MAX_BYTES = 2 * 1024 * 1024
_BACKUP_COUNT = 3

_configured = False


def log_file_path() -> Path:
    """Return the persistent log path (override with KATRA_HOOK_LOG_FILE)."""
    override = os.environ.get("KATRA_HOOK_LOG_FILE")
    if override:
        return Path(override).expanduser()
    return _default_state_dir() / "diagnostics" / "katra-hook.log"


def configure_logging(config: BridgeConfig) -> None:
    """Attach a rotating file handler to the package logger (once per process).

    Safe to call on every prompt. Updates the level to match the current
    debug flag even after the handler is installed, so toggling ``debug`` in
    katra-hook.json takes effect on the next prompt without a restart.
    """
    global _configured

    pkg_logger = logging.getLogger(_PACKAGE_LOGGER)
    level = logging.DEBUG if config.debug else logging.INFO
    pkg_logger.setLevel(level)

    if _configured:
        # Handler already present — just keep the level in sync with debug.
        for handler in pkg_logger.handlers:
            if getattr(handler, "name", None) == _HANDLER_NAME:
                handler.setLevel(level)
        return

    try:
        path = log_file_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            path, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8"
        )
        handler.name = _HANDLER_NAME
        handler.setLevel(level)
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        pkg_logger.addHandler(handler)
        # Don't double-emit through the root logger's handlers if any exist,
        # but keep propagation so a caller-configured handler still sees us.
        pkg_logger.propagate = True
        _configured = True
        pkg_logger.debug("Katra bridge file logging initialized at %s", path)
    except Exception:  # noqa: BLE001 - logging must never break the hook
        # Fail open: leave whatever logging config exists (stderr) in place.
        _configured = True  # don't retry every prompt on a persistent failure
