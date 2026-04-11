#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
info()  { printf '\033[0;36m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Pre-flight checks ───────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed"
command -v npm  >/dev/null 2>&1 || die "npm is not installed"
command -v git  >/dev/null 2>&1 || die "git is not installed"

# Ensure working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  die "Working tree is dirty. Commit or stash changes before releasing."
fi

# Ensure we are on main
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  die "Releases must be cut from the main branch (currently on '$BRANCH')."
fi

# ── Determine version ───────────────────────────────────────────────────────
CURRENT_VERSION="$(node -p "require('./package.json').version")"
info "Current version: $CURRENT_VERSION"

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  echo "Usage: $0 <patch|minor|major|premajor|preminor|prepatch|prerelease|x.y.z>"
  echo ""
  echo "  patch       — 0.0.1-alpha.3  →  0.0.2"
  echo "  minor       — 0.0.1-alpha.3  →  0.1.0"
  echo "  major       — 0.0.1-alpha.3  →  1.0.0"
  echo "  prerelease  — 0.0.1-alpha.3  →  0.0.1-alpha.4"
  echo "  x.y.z       — set exact version"
  exit 1
fi

# Bump version (without creating a git tag — we do that ourselves)
npm version "$BUMP" --no-git-tag-version --allow-same-version
NEW_VERSION="$(node -p "require('./package.json').version")"
green "Version bumped: $CURRENT_VERSION → $NEW_VERSION"

# ── Build ────────────────────────────────────────────────────────────────────
info "Installing dependencies..."
npm ci --silent

info "Building..."
npm run build

# ── Run type-check ───────────────────────────────────────────────────────────
info "Running type-check..."
npm run typecheck

# ── Package dry-run (show what will be published) ────────────────────────────
info "Package contents:"
npm pack --dry-run 2>&1 | sed 's/^/  /'

# ── Git tag & commit ─────────────────────────────────────────────────────────
TAG="v$NEW_VERSION"

git add package.json package-lock.json
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Release $TAG"

green "Created commit and tag: $TAG"

# ── Publish ──────────────────────────────────────────────────────────────────
read -rp "Publish $TAG to npm? [y/N] " CONFIRM
if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
  npm publish --access public
  green "Published $TAG to npm!"
else
  info "Skipped npm publish. You can publish later with: npm publish --access public"
fi

# ── Push ─────────────────────────────────────────────────────────────────────
read -rp "Push commit and tag to origin? [y/N] " CONFIRM
if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
  git push origin main --follow-tags
  green "Pushed to origin."
else
  info "Skipped push. Run: git push origin main --follow-tags"
fi

green "Release $TAG complete!"
