#!/bin/bash
# Installe tout ce qu'il faut (à lancer une seule fois).
set -e
cd "$(dirname "$0")"

command -v brew >/dev/null || { echo "Installe Homebrew d'abord : https://brew.sh"; exit 1; }
command -v node >/dev/null || brew install node
command -v ffmpeg >/dev/null || brew install ffmpeg
PY=$(command -v python3.12 || command -v python3.13 || true)
[ -n "$PY" ] || { brew install python@3.12; PY=$(brew --prefix)/bin/python3.12; }

[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip yt-dlp
npm install
echo "✅ Installation terminée. Lance l'appli avec : ./lancer.command"
