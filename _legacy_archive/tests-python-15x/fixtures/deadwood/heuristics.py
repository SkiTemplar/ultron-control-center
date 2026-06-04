"""Module docstring — should NOT trigger heuristics even if it says
removed in v1.0 inside the docstring. The mask suppresses these.
"""

def foo_OLD():
    """trailing docstring also masked: DEPRECATED in here is fine"""
    return "removed in v1.2.3 marker on a real comment line"  # heuristic hit


# TODO: remove this helper once Sprint 7 lands
def helper():
    return 1


# LEGACY — kept around for backwards compat with v0.x callers
def legacy_path():
    return None


# Plain mention of DEPRECATED on a code comment
LIVE_VAR = "DEPRECATED"  # heuristic hit


def clean_code():
    return 42
