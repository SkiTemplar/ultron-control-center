"""Tests for ULTRON v14 S5-C — path_traversal_guard."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import path_traversal_guard as ptg  # noqa: E402


def test_path_traversal_blocks_dotdot(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    with pytest.raises(ptg.PathTraversalError):
        ptg.safe_resolve("../escape.txt", base)


def test_path_traversal_blocks_null_byte(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    with pytest.raises(ptg.PathTraversalError):
        ptg.safe_resolve("ok\x00bad", base)


def test_path_traversal_allows_safe_subpath(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    out = ptg.safe_resolve("subdir/file.txt", base)
    assert base.resolve() in out.parents or out.parent == base.resolve()


def test_path_traversal_blocks_absolute_outside(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    other = tmp_path / "other.txt"
    with pytest.raises(ptg.PathTraversalError):
        ptg.safe_resolve(str(other), base)


def test_path_traversal_allows_absolute_inside(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    inside = base / "x.txt"
    out = ptg.safe_resolve(str(inside), base)
    assert out == inside.resolve()


def test_path_traversal_blocks_deep_dotdot(tmp_path):
    base = tmp_path / "base" / "sub"
    base.mkdir(parents=True)
    with pytest.raises(ptg.PathTraversalError):
        ptg.safe_resolve("../../../etc/passwd", base)


def test_path_traversal_none_input(tmp_path):
    with pytest.raises(ptg.PathTraversalError):
        ptg.safe_resolve(None, tmp_path)
