#!/bin/bash
#
# One-key Team Converter
# Converts a PS format team file to multiple formats/modes at once
#
# Usage:
#   ./tools/one_key_convert_team.sh <npc_id> <input_file>
#
# Example:
#   ./tools/one_key_convert_team.sh maxie tmp_team.txt
#
# To skip a format, comment out the corresponding line below

set -e

NPC_ID="$1"
INPUT_FILE="$2"

if [ -z "$NPC_ID" ] || [ -z "$INPUT_FILE" ]; then
    echo "Usage: $0 <npc_id> <input_file>"
    echo "Example: $0 maxie tmp_team.txt"
    exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: Input file not found: $INPUT_FILE"
    exit 1
fi

echo "Converting team for NPC: $NPC_ID"
echo "Input file: $INPUT_FILE"
echo ""

# ============================================================
# Singles formats (comment out lines you don't want)
# ============================================================

# National Dex OU (singles)
node tools/convert-team.js "$INPUT_FILE" "${NPC_ID}-gen9nationaldex.json" \
    --npc "$NPC_ID" --format gen9nationaldex --mode singles

# National Dex UU (singles)
# node tools/convert-team.js "$INPUT_FILE" "${NPC_ID}-gen9nationaldexuu.json" \
#     --npc "$NPC_ID" --format gen9nationaldexuu --mode singles

# National Dex RU (singles)
# node tools/convert-team.js "$INPUT_FILE" "${NPC_ID}-gen9nationaldexru.json" \
#     --npc "$NPC_ID" --format gen9nationaldexru --mode singles

# ============================================================
# Doubles formats (comment out lines you don't want)
# ============================================================

# Doubles OU
node tools/convert-team.js "$INPUT_FILE" "${NPC_ID}-gen9doublesou.json" \
    --npc "$NPC_ID" --format gen9doublesou --mode doubles

# ============================================================
# Multi Battle format (requires 6 Pokemon: first 3 -> p2, last 3 -> p4)
# ============================================================

# National Dex Multi
node tools/convert-team.js "$INPUT_FILE" "${NPC_ID}-gen9nationaldexmulti.json" \
    --npc "$NPC_ID" --format gen9nationaldexmulti --mode multi

echo ""
echo "Done! Check data/npc/teams/ for output files"
echo "templates.json has been updated automatically"
