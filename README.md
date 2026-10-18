# Clé de Sol

Ta playlist Spotify en MP3 (tags + pochette), prête à copier sur une clé USB.

## Utilisation en local (Mac)

Double-clique sur `lancer.command` dans le Finder. La première fois, il installe tout via `setup.sh`.
L'interface s'ouvre sur http://127.0.0.1:5050.

1. Colle le lien de la playlist (Spotify → ⋯ → Partager → Copier le lien). Elle doit être **publique**.
   Tu peux aussi déposer un export CSV (Exportify, TuneMyMusic, Soundiiz…).
2. Branche ta clé USB : elle est détectée et sélectionnée automatiquement.
3. « Convertir en MP3 », puis « Éjecter la clé » une fois terminé.

## Fonctionnement

- La liste des titres est lue depuis la page publique « embed » de Spotify (une seule requête, sans compte).
  Spotify ne permet pas de télécharger son audio, qui est protégé.
- Chaque titre est recherché sur YouTube Music (titre + artiste + durée), téléchargé avec `yt-dlp` et converti en MP3 par `ffmpeg`.
- Les tags ID3v2.3 (titre, artiste, album, numéro, pochette) sont lisibles par les autoradios.
- Un fichier `.m3u` est créé. Les titres déjà présents sont ignorés si tu relances la même playlist.

## Déploiement (mode web)

En mode web, l'appli ne touche pas au disque de l'utilisateur : les MP3 sont téléchargés en ZIP depuis le navigateur.

```bash
docker build -t cle-de-sol .
docker run -p 8080:8080 -e APP_PASSWORD=motdepasse cle-de-sol
```

Le `Dockerfile` fonctionne tel quel sur Railway, Render, Fly.io, un VPS, etc. Le healthcheck est `GET /healthz`.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MODE` | `web` (Docker) / `local` | `web` = téléchargement ZIP, pas d'accès aux clés USB |
| `PORT` | `8080` (Docker) / `5050` | Port d'écoute |
| `APP_PASSWORD` | _(vide)_ | Protège l'accès par mot de passe (fortement conseillé) |
| `MAX_TRACKS` | `300` | Nombre max de titres par playlist |
| `MAX_ACTIVE_JOBS` | `2` | Conversions simultanées maximum |
| `CONCURRENCY` | `3` | Titres téléchargés en parallèle par conversion |
| `JOB_TTL_MINUTES` | `60` | Délai avant suppression des fichiers d'une conversion |
| `YTDLP_COOKIES` | _(vide)_ | Chemin d'un `cookies.txt` YouTube si l'hébergeur est bloqué |

**À savoir avant de déployer :**
- YouTube bloque souvent les adresses IP des hébergeurs (« Sign in to confirm you're not a bot »).
  Si ça arrive, exporte les cookies d'un compte YouTube (format Netscape) et passe leur chemin dans `YTDLP_COOKIES`.
- Télécharger depuis YouTube enfreint ses conditions d'utilisation, et un service public de ce type expose à des
  risques juridiques (droits d'auteur). Garde l'instance privée, avec `APP_PASSWORD`.

## Dev

```bash
npm start          # serveur local (tsx)
npm run build      # compile vers dist/
npm run serve      # lance la version compilée
npm run typecheck
```
