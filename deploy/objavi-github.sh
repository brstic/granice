#!/bin/sh
# Objavi trenutni HEAD na javni GitHub (github.com/brstic/granice) kao očišćen snimak:
# git archive poštuje .gitattributes (export-ignore → bez CLAUDE.md, claude-memory/, docs/SERVER.md).
# Javna istorija je posebna (grana „github“ lokalno): jedan commit po objavi, sa porukom poslednjeg commita.
set -e
cd "$(dirname "$0")/.."
REMOTE=${GITHUB_REMOTE:-https://github.com/brstic/granice.git}
[ -z "$(git status --porcelain)" ] || { echo "Ima neprijavljenih izmena – prvo commit."; exit 1; }
WT=$(mktemp -d)
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
if git fetch -q "$REMOTE" main:github 2>/dev/null || git show-ref -q refs/heads/github; then
  git worktree add -q "$WT" github
else
  git worktree add -q --detach "$WT" && git -C "$WT" checkout -q --orphan github
fi
git -C "$WT" rm -rqf --ignore-unmatch . >/dev/null
git archive HEAD | tar -x -C "$WT"
# provera: ništa privatno ne sme napolje
if grep -rIl -E '192\.168\.|178\.149\.|sparkcan[@]|PRISTUP\.md.*`[^`]{8,}`' "$WT" --exclude-dir=.git; then echo "Nađen privatan podatak – prekidam."; exit 1; fi
git -C "$WT" add -A
if git -C "$WT" diff --cached --quiet; then echo "GitHub je već ažuran."; exit 0; fi
git -C "$WT" commit -q -m "$(git log -1 --format=%B)" --author="$(git log -1 --format='%an <%ae>')"
git -C "$WT" push -q "$REMOTE" github:main
echo "Objavljeno: $(git -C "$WT" log --oneline -1)"
