#!/usr/bin/env python3
"""
Launcher for the CLI agent. Run from project root:

  python main.py
  python -m cli

Core logic lives in cli/main.py (REPL, run_turn, session choice).
"""

from cli.main import main

if __name__ == "__main__":
    main()
