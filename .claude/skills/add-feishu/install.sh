#!/usr/bin/env bash
# install.sh — Applies the add-feishu skill to NanoClaw
# Run this from the NanoClaw project root directory.
#
# Usage:
#   cd /path/to/nanoclaw
#   bash groups/<your-group>/add-feishu/install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(pwd)"

echo ""
echo "=== NanoClaw: Installing Feishu Channel ==="
echo ""

# 1. Copy skill package into .claude/skills/
SKILL_DEST="$PROJECT_ROOT/.claude/skills/add-feishu"
if [ -d "$SKILL_DEST" ]; then
  echo "[1/4] Skill directory already exists at $SKILL_DEST — overwriting..."
else
  echo "[1/4] Copying skill package to $SKILL_DEST ..."
fi
mkdir -p "$SKILL_DEST"
cp -r "$SCRIPT_DIR"/* "$SKILL_DEST/"

# 2. Install npm dependency
echo "[2/4] Installing @larksuiteoapi/node-sdk ..."
npm install @larksuiteoapi/node-sdk --save

# 3. Apply the skill (copies source files and updates index.ts)
echo "[3/4] Applying skill via skills engine ..."
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu

# 4. Build
echo "[4/4] Building TypeScript ..."
npm run build

echo ""
echo "=== Feishu channel installed successfully! ==="
echo ""
echo "Next steps:"
echo "  1. Add to .env:"
echo "       FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx"
echo "       FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
echo "       FEISHU_DOMAIN=feishu   # or 'lark' for international"
echo ""
echo "  2. Sync env to container:"
echo "       mkdir -p data/env && cp .env data/env/env"
echo ""
echo "  3. Restart NanoClaw:"
echo "       launchctl kickstart -k gui/\$(id -u)/com.nanoclaw   # macOS"
echo "       systemctl --user restart nanoclaw                    # Linux"
echo ""
echo "  4. See SKILL.md for full setup instructions (creating the Feishu bot, etc.)"
echo ""
