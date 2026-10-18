// Recherche du titre sur YouTube Music, téléchargement + conversion MP3, tags ID3.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import NodeID3 from "node-id3";
import YTMusic from "ytmusic-api";
import { bin } from "./bin.js";
import type { Track } from "./tracks.js";

const execFileAsync = promisify(execFile);

let ytm: Promise<YTMusic> | null = null;
function client(): Promise<YTMusic> {
  ytm ??= (async () => {
    const c = new YTMusic();
    await c.initialize();
    return c;
  })();
  return ytm;
}

/** Nom de fichier compatible FAT32/exFAT (clés USB, autoradios). */
export function safeName(text: string, maxLen = 120): string {
  const clean = text
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return clean.slice(0, maxLen).trim() || "Sans titre";
}

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|- .*remaster.*|feat\..*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Similarité 0..1 basée sur les bigrammes (coefficient de Dice). */
function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) { grams.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (x.length + y.length - 2);
}

interface Candidate {
  videoId: string;
  name: string;
  artist: { name: string };
  duration: number | null;
  album?: { name: string } | null;
  thumbnails: { url: string; width: number }[];
}

export interface Match {
  videoId: string;
  album: string;
  coverUrl: string | null;
}

function score(track: Track, c: Candidate): number {
  // « Marvin Gaye, Tammi Terrell » : on compare la chaîne entière et chaque nom séparément.
  const names = track.artists.flatMap((a) => [a, ...a.split(/, | & /)]);
  let s = similarity(track.title, c.name) * 0.5;
  s += Math.max(0, ...names.map((a) => similarity(a, c.artist.name))) * 0.3;
  if (track.duration && c.duration) {
    s += Math.max(0, 1 - Math.abs(track.duration - c.duration) / 30) * 0.2;
  } else {
    s += 0.1;
  }
  return s;
}

export async function findVideo(track: Track): Promise<Match | null> {
  const yt = await client();
  const query = `${track.artists.join(", ")} - ${track.title}`;
  let best: Match | null = null;
  let bestScore = 0;

  // Les pistes audio officielles d'abord, puis les clips vidéo en repli.
  const searches: [() => Promise<Candidate[]>, boolean][] = [
    [() => yt.searchSongs(query), true],
    [() => yt.searchVideos(query), false],
  ];
  for (const [search, isSong] of searches) {
    let results: Candidate[] = [];
    try {
      results = await search();
    } catch {
      continue;
    }
    for (const c of results.slice(0, 10)) {
      const s = score(track, c) - (isSong ? 0 : 0.05);
      if (!c.videoId || s <= bestScore) continue;
      bestScore = s;
      // Seules les pistes « song » ont un album et une pochette carrée (agrandie en 544 px).
      const thumb = isSong ? c.thumbnails.at(-1)?.url.replace(/=w\d+-h\d+/, "=w544-h544") : undefined;
      best = { videoId: c.videoId, album: (isSong && c.album?.name) || "", coverUrl: thumb ?? null };
    }
    if (bestScore >= 0.75) break;
  }
  return bestScore >= 0.45 ? best : null;
}

async function fetchCover(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function writeTags(file: string, track: Track, position: number): Promise<void> {
  const cover = await fetchCover(track.coverUrl);
  const tags: NodeID3.Tags = {
    title: track.title,
    artist: track.artists.join(", "),
    album: track.album || undefined,
    performerInfo: track.albumArtist || undefined,
    year: track.year || undefined,
    trackNumber: String(position),
  };
  if (cover) {
    tags.image = { mime: "image/jpeg", type: { id: 3, name: "front cover" }, description: "Cover", imageBuffer: cover };
  }
  // write() remplace tous les tags existants (ceux de YouTube) ; ID3v2.3 = compatible autoradios.
  const result = NodeID3.write(tags, file);
  if (result instanceof Error) throw result;
}

/** Télécharge l'audio, le convertit en MP3 tagué et l'enregistre dans `target`. */
export async function downloadMp3(
  match: Match,
  track: Track,
  position: number,
  target: string,
  bitrate: "192" | "320",
): Promise<void> {
  const dir = path.dirname(target);
  const tmpBase = path.join(dir, `.tmp-${randomUUID()}`);
  const args = [
    "-f", "bestaudio/best",
    "-x", "--audio-format", "mp3", "--audio-quality", `${bitrate}K`,
    "--no-playlist", "--quiet", "--no-warnings", "--no-progress",
    "--js-runtimes", `node:${process.execPath}`, // déchiffrement YouTube via le Node déjà présent
    "-o", `${tmpBase}.%(ext)s`,
    `https://music.youtube.com/watch?v=${match.videoId}`,
  ];
  // Sur un serveur, YouTube bloque souvent les IP d'hébergeurs : des cookies d'un compte débloquent l'accès.
  if (process.env.YTDLP_COOKIES) args.unshift("--cookies", process.env.YTDLP_COOKIES);
  try {
    // YouTube renvoie parfois des 403 passagers : jusqu'à 3 essais.
    for (let attempt = 1; ; attempt++) {
      try {
        await execFileAsync(bin("yt-dlp"), args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    const tmpMp3 = `${tmpBase}.mp3`;
    if (!existsSync(tmpMp3)) throw new Error("conversion MP3 échouée");
    const tagged = { ...track, album: track.album || match.album, coverUrl: track.coverUrl ?? match.coverUrl };
    await writeTags(tmpMp3, tagged, position);
    await rename(tmpMp3, target);
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const line = (e.stderr || e.message).trim().split("\n").pop() ?? "erreur inconnue";
    throw new Error(line.slice(0, 200));
  } finally {
    const prefix = path.basename(tmpBase);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (f.startsWith(prefix)) await unlink(path.join(dir, f)).catch(() => {});
    }
  }
}
