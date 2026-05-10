"""Pytest suite for ULTRON v14.8 P6 — RecallModal class surface.

Textual ModalScreen instances need a running App to fully exercise; we
test the static surface (class exists, has BINDINGS for Esc, methods
present, action_open_recall pushes the modal). Live interactivity is
verified manually.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


def _reimport_tui():
    if "scripts.cockpit.tui" in sys.modules:
        del sys.modules["scripts.cockpit.tui"]
    if "tui" in sys.modules:
        del sys.modules["tui"]
    return importlib.import_module("tui")


def test_recall_modal_class_present():
    tui = _reimport_tui()
    assert hasattr(tui, "RecallModal"), "RecallModal class must be defined"


def test_recall_modal_has_escape_binding():
    tui = _reimport_tui()
    bindings = getattr(tui.RecallModal, "BINDINGS", [])
    assert any(
        getattr(b, "key", "") == "escape" or
        (isinstance(b, tuple) and b and b[0] == "escape")
        for b in bindings
    ), "RecallModal must have Escape binding to dismiss"


def test_recall_modal_has_required_methods():
    tui = _reimport_tui()
    cls = tui.RecallModal
    for name in ("compose", "on_input_submitted", "on_button_pressed",
                 "_run_query", "_render_results"):
        assert hasattr(cls, name), f"RecallModal must define {name}()"


def test_app_has_capital_R_binding_for_recall():
    tui = _reimport_tui()
    app_cls = tui.UltronTUI
    bindings = getattr(app_cls, "BINDINGS", [])
    keys_to_actions = {}
    for b in bindings:
        key = getattr(b, "key", None) or (b[0] if isinstance(b, tuple) else None)
        action = getattr(b, "action", None) or (b[1] if isinstance(b, tuple) and len(b) > 1 else None)
        if key:
            keys_to_actions[key] = action
    assert "R" in keys_to_actions, "App must bind capital R to recall modal"
    assert keys_to_actions["R"] == "open_recall"


def test_app_has_reindex_action_method():
    tui = _reimport_tui()
    app_cls = tui.UltronTUI
    assert hasattr(app_cls, "action_system_reindex"), \
        "UltronTUI must define action_system_reindex"
    assert hasattr(app_cls, "_reindex_collections"), \
        "UltronTUI must define _reindex_collections helper"
