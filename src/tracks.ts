// Récupération de la liste des titres : lien Spotify (page « embed » publique) ou export CSV.

import path from "node:path";

export interface Track {
  title: string;
  artists: string[];
  album: string;
  albumArtist: string;
  year: string;
  duration: number; // secondes, 0 si inconnue
  coverUrl: string | null;
}

export interface Playlist {
  name: string;
  tracks: Track[];
}

export interface SpotifyRef {
  type: "playlist" | "album" | "track";
  id: string;
}

export function parseSpotifyUrl(input: string): SpotifyRef | null {
  const s = input.trim();
  const m =
    s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|album|track)\/([A-Za-z0-9]+)/) ??
    s.match(/^spotify:(playlist|album|track):([A-Za-z0-9]+)/);
  return m ? { type: m[1] as SpotifyRef["type"], id: m[2] } : null;
}

interface EmbedTrack {
  title: string;
  subtitle: string; // artistes séparés par « , » — ambigu (« Earth, Wind & Fire »), donc gardé tel quel
  duration: number; // ms
}

interface EmbedEntity {
  name: string;
  subtitle?: string;
  releaseDate?: { isoString?: string };
  coverArt?: { sources?: { url: string; width: number }[] };
  duration?: number;
  trackList?: EmbedTrack[];
}

// La page « embed » de Spotify contient toute la liste en JSON : une seule requête,
// sans identifiants ni limite de débit (contrairement à l'API utilisée par spotdl).
export async function fromSpotify(ref: SpotifyRef): Promise<Playlist> {
  let html: string;
  try {
    const res = await fetch(`https://open.spotify.com/embed/${ref.type}/${ref.id}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Accept-Language": "fr" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error(`Spotify ne répond pas (${(err as Error).message}). Vérifie ta connexion internet.`);
  }

  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  const entity: EmbedEntity | undefined = json && JSON.parse(json)?.props?.pageProps?.state?.data?.entity;
  if (!entity) {
    throw new Error("Impossible de lire cette playlist. Vérifie que le lien est correct et que la playlist est publique.");
  }

  // Un album fournit pochette/année communes ; pour une playlist on les complète via YouTube Music.
  const isAlbum = ref.type === "album";
  const cover = isAlbum ? [...(entity.coverArt?.sources ?? [])].sort((a, b) => b.width - a.width)[0]?.url ?? null : null;
  const year = isAlbum ? entity.releaseDate?.isoString?.slice(0, 4) ?? "" : "";
  const list: EmbedTrack[] =
    ref.type === "track" ? [{ title: entity.name, subtitle: entity.subtitle ?? "", duration: entity.duration ?? 0 }] : entity.trackList ?? [];

  return {
    name: ref.type === "track" ? `${entity.subtitle} - ${entity.name}` : entity.name,
    tracks: list.map((t) => ({
      title: t.title,
      artists: [t.subtitle || "Inconnu"],
      album: isAlbum ? entity.name : "",
      albumArtist: isAlbum ? entity.subtitle ?? "" : "",
      year,
      duration: Math.round((t.duration ?? 0) / 1000),
      coverUrl: cover,
    })),
  };
}

// Parseur CSV minimal (RFC 4180 : guillemets, virgules et retours ligne échappés).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

// Export CSV (Exportify, TuneMyMusic, Soundiiz...).
export function fromCsv(buffer: Buffer, filename: string): Playlist {
  const [header, ...rows] = parseCsv(buffer.toString("utf8").replace(/^﻿/, ""));
  if (!header) throw new Error("Le fichier CSV est vide.");
  const cols = header.map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => cols.findIndex((c) => names.includes(c));

  const cTitle = col("track name", "title", "name", "titre", "song");
  const cArtist = col("artist name(s)", "artist name", "artist", "artists", "artiste");
  const cAlbum = col("album name", "album");
  const cDur = col("duration (ms)", "duration_ms", "duration");
  if (cTitle < 0 || cArtist < 0) {
    throw new Error(
      "CSV non reconnu : il faut au moins les colonnes du titre et de l'artiste " +
        "(ex. export Exportify : « Track Name », « Artist Name(s) »).",
    );
  }

  const tracks: Track[] = [];
  for (const r of rows) {
    const title = (r[cTitle] ?? "").trim();
    if (!title) continue;
    const artists = (r[cArtist] ?? "").split(/[;,]/).map((a) => a.trim()).filter(Boolean);
    let duration = cDur >= 0 ? parseInt(r[cDur] ?? "", 10) || 0 : 0;
    if (duration > 10_000) duration = Math.round(duration / 1000); // ms → s
    tracks.push({
      title,
      artists: artists.length ? artists : ["Inconnu"],
      album: cAlbum >= 0 ? (r[cAlbum] ?? "").trim() : "",
      albumArtist: artists[0] ?? "",
      year: "",
      duration,
      coverUrl: null,
    });
  }
  return { name: path.parse(filename).name || "Playlist", tracks };
}
