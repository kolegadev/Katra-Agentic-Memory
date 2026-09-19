"""skills package — importing it registers every sNN skill in SKILLS."""
import importlib
import os

_PKG_DIR = os.path.dirname(__file__)
for _f in sorted(os.listdir(_PKG_DIR)):
    if _f.startswith("s") and _f.endswith(".py"):
        importlib.import_module("skills." + _f[:-3])
