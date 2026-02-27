"""
CLI entry point for the general-purpose agent.

Run from project root:
  python -m cli
  python main.py   (root main.py delegates here)
"""

from cli.main import Agent, main, run_turn

__all__ = ["Agent", "main", "run_turn"]
