import sys
from pathlib import Path

# Make scripts/cockpit importable without installing
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "cockpit"))
