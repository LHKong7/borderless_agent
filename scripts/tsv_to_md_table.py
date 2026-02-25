#!/usr/bin/env python3
"""Convert TSV table in skill.md (lines 51-461) to markdown table format."""
from pathlib import Path

def main():
    base = Path(__file__).resolve().parent.parent
    path = base / "skills" / "infant_sleep" / "skill.md"
    lines = path.read_text(encoding="utf-8").splitlines()
    # Find separator line (|---|---|...|)
    sep_idx = None
    for i, line in enumerate(lines):
        if line.strip().startswith("|---") and "---" in line:
            sep_idx = i
            break
    if sep_idx is None:
        raise SystemExit("Separator line not found")
    sep_line = lines[sep_idx]
    ncols = sep_line.count("---")
    # Convert lines after separator that still contain tab
    out_lines = lines[: sep_idx + 1]
    for i in range(sep_idx + 1, len(lines)):
        line = lines[i]
        if "\t" in line:
            cells = line.split("\t")
            cells = (cells + [""] * ncols)[:ncols]
            line = "| " + " | ".join(cells) + " |"
        out_lines.append(line)
    path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(f"Converted {len(out_lines) - sep_idx - 1} data rows")

if __name__ == "__main__":
    main()
