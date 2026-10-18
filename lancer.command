#!/bin/bash
# Double-clique sur ce fichier dans le Finder pour lancer MP3 Spotify.
cd "$(dirname "$0")"
[ -d node_modules ] && [ -d .venv ] || ./setup.sh
.venv/bin/pip install -q --upgrade yt-dlp >/dev/null 2>&1 &  # YouTube change souvent : garder yt-dlp à jour
npm start
