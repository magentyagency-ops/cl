// MP3 Spotify — convertit une playlist Spotify en fichiers MP3.
//
// Deux modes :
//  - local (par défaut) : écrit directement sur une clé USB / un dossier du Mac.
//  - web (MODE=web)     : pour un serveur ; les MP3 sont téléchargés en ZIP depuis le navigateur.

import { execFile, spawn } from "node:child_process";
import { createReadStream, existsSync, statfsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ZipArchive } from "archiver";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ROOT } from "./bin.js";
import { downloadMp3, findVideo, safeName } from "./downloader.js";
import { fromCsv, fromSpotify, parseSpotifyUrl, type Playlist, type SpotifyRef } from "./tracks.js";

const WEB = process.env.MODE === "web";
const PORT = Number(process.env.PORT ?? 5050);
const HOST = process.env.HOST ?? (WEB ? "0.0.0.0" : "127.0.0.1");
const PASSWORD = process.env.APP_PASSWORD ?? "";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const MAX_TRACKS = Number(process.env.MAX_TRACKS ?? (WEB ? 300 : 10_000));
const MAX_ACTIVE_JOBS = Number(process.env.MAX_ACTIVE_JOBS ?? (WEB ? 2 : 10));
const JOB_TTL_MS = Number(process.env.JOB_TTL_MINUTES ?? 60) * 60_000;
const DEFAULT_OUTPUT = path.join(homedir(), "Music", "MP3 Spotify");
const WEB_OUTPUT = path.join(tmpdir(), "mp3spotify-jobs");

type TrackStatus = "pending" | "searching" | "downloading" | "done" | "skipped" | "error";

interface TrackState {
  title: string;
  artist: string;
  status: TrackStatus;
  message: string | null;
  file: string | null;
}

interface Job {
  id: string;
  output: string;
  bitrate: "192" | "320";
  numbered: boolean;
  phase: string;
  name: string | null;
  folder: string | null;
  tracks: TrackState[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

type Source = { type: "url"; ref: SpotifyRef } | { type: "csv"; data: Buffer; filename: string };

const jobs = new Map<string, Job>();

async function processTrack(job: Job, playlist: Playlist, index: number): Promise<void> {
  const track = playlist.tracks[index];
  const state = job.tracks[index];
  const position = index + 1;
  const prefix = job.numbered ? `${String(position).padStart(3, "0")} - ` : "";
  const filename = safeName(`${prefix}${track.artists[0]} - ${track.title}`) + ".mp3";
  const target = path.join(job.folder!, filename);

  if (existsSync(target)) {
    Object.assign(state, { status: "skipped", message: "déjà présent", file: filename });
    return;
  }
  try {
    state.status = "searching";
    const match = await findVideo(track);
    if (!match) {
      Object.assign(state, { status: "error", message: "introuvable sur YouTube Music" });
      return;
    }
    state.status = "downloading";
    await downloadMp3(match, track, position, target, job.bitrate);
    Object.assign(state, { status: "done", file: filename });
  } catch (err) {
    Object.assign(state, { status: "error", message: (err as Error).message });
  }
}

async function runJob(job: Job, source: Source): Promise<void> {
  try {
    job.phase = "Lecture de la playlist";
    const playlist = source.type === "url" ? await fromSpotify(source.ref) : fromCsv(source.data, source.filename);
    if (!playlist.tracks.length) throw new Error("Aucun titre trouvé dans cette playlist.");
    if (playlist.tracks.length > MAX_TRACKS) {
      throw new Error(`Cette playlist contient ${playlist.tracks.length} titres (maximum : ${MAX_TRACKS}).`);
    }

    const folderName = safeName(playlist.name, 80);
    job.name = playlist.name.trim();
    job.folder = path.join(job.output, folderName);
    await mkdir(job.folder, { recursive: true });
    job.tracks = playlist.tracks.map((t) => ({
      title: t.title,
      artist: t.artists.join(", "),
      status: "pending",
      message: null,
      file: null,
    }));
    job.phase = "Conversion";

    // Pool de workers : CONCURRENCY titres en parallèle.
    let next = 0;
    const worker = async () => {
      while (next < playlist.tracks.length) await processTrack(job, playlist, next++);
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Fichier playlist .m3u (lu par la plupart des autoradios / lecteurs)
    const files = job.tracks.map((t) => t.file).filter(Boolean);
    await writeFile(path.join(job.folder, `${folderName}.m3u`), "#EXTM3U\n" + files.map((f) => `${f}\n`).join(""), "utf8");
    job.phase = "Terminé";
  } catch (err) {
    job.error = (err as Error).message;
  } finally {
    job.finishedAt = Date.now();
  }
}

// En mode web, les fichiers d'une tâche sont supprimés JOB_TTL après la fin.
if (WEB) {
  setInterval(() => {
    for (const [id, job] of jobs) {
      if (job.finishedAt && Date.now() - job.finishedAt > JOB_TTL_MS) {
        jobs.delete(id);
        void rm(job.output, { recursive: true, force: true });
      }
    }
  }, 5 * 60_000).unref();
}

async function listVolumes(): Promise<{ name: string; path: string; freeGb: number; totalGb: number }[]> {
  const vols = [];
  for (const name of await readdir("/Volumes").catch(() => [] as string[])) {
    const p = path.join("/Volumes", name);
    try {
      if ((await realpath(p)) === "/" || !(await stat(p)).isDirectory()) continue; // disque système
      const fs = statfsSync(p);
      const gb = (blocks: number) => Math.round((blocks * fs.bsize) / 1e8) / 10;
      vols.push({ name, path: p, freeGb: gb(fs.bavail), totalGb: gb(fs.blocks) });
    } catch {
      continue;
    }
  }
  return vols;
}

// Mot de passe optionnel (APP_PASSWORD) via l'authentification HTTP du navigateur.
function auth(req: Request, res: Response, next: NextFunction) {
  if (!PASSWORD || req.path === "/healthz") return next();
  const [scheme, value] = (req.headers.authorization ?? "").split(" ");
  const given = scheme === "Basic" ? Buffer.from(value ?? "", "base64").toString().split(":").slice(1).join(":") : "";
  const a = Buffer.from(given);
  const b = Buffer.from(PASSWORD);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="MP3 Spotify"').status(401).send("Mot de passe requis");
}

function localOnly(_req: Request, res: Response, next: NextFunction) {
  if (WEB) res.status(404).json({ error: "Indisponible en mode web" });
  else next();
}

function getJob(req: Request, res: Response): Job | null {
  const job = jobs.get(String(req.params.id));
  if (!job) res.status(404).json({ error: "Cette conversion n'existe plus. Relance la playlist." });
  return job ?? null;
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.disable("x-powered-by");
app.use(auth);
app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

app.get("/healthz", (_req, res) => {
  res.send("ok");
});

app.get("/api/config", (_req, res) => {
  res.json({ mode: WEB ? "web" : "local", defaultOutput: WEB ? null : DEFAULT_OUTPUT, maxTracks: MAX_TRACKS });
});

app.get("/api/volumes", localOnly, async (_req, res) => {
  res.json(await listVolumes());
});

app.post("/api/start", upload.single("csv"), async (req, res) => {
  const active = [...jobs.values()].filter((j) => !j.finishedAt).length;
  if (active >= MAX_ACTIVE_JOBS) {
    res.status(429).json({ error: "Trop de conversions en cours. Réessaie dans quelques minutes." });
    return;
  }

  let source: Source;
  if (req.file) {
    source = { type: "csv", data: req.file.buffer, filename: req.file.originalname };
  } else {
    const ref = parseSpotifyUrl(String(req.body.url || ""));
    if (!ref) {
      res.status(400).json({ error: "Colle un lien Spotify (open.spotify.com/playlist/…) ou choisis un fichier CSV." });
      return;
    }
    source = { type: "url", ref };
  }

  const id = randomUUID();
  const output = WEB
    ? path.join(WEB_OUTPUT, id)
    : String(req.body.output || DEFAULT_OUTPUT).trim().replace(/^~(?=\/|$)/, homedir());
  try {
    await mkdir(output, { recursive: true });
  } catch (err) {
    res.status(400).json({ error: `Dossier de destination inaccessible : ${(err as Error).message}` });
    return;
  }

  const job: Job = {
    id,
    output,
    bitrate: req.body.bitrate === "320" ? "320" : "192",
    numbered: req.body.numbered === "on",
    phase: "Démarrage",
    name: null,
    folder: null,
    tracks: [],
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  jobs.set(id, job);
  void runJob(job, source);
  res.json({ jobId: id });
});

app.get("/api/job/:id", (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  const { phase, name, tracks, startedAt, finishedAt, error } = job;
  res.json({
    phase, name, tracks, startedAt, error,
    finished: finishedAt !== null,
    folder: WEB ? null : job.folder,
    now: Date.now(),
  });
});

app.get("/api/job/:id/zip", (req, res) => {
  const job = getJob(req, res);
  if (!job || !job.folder || !job.finishedAt) return;
  const zipName = safeName(job.name ?? "playlist", 80);
  res.attachment(`${zipName}.zip`);
  const archive = new ZipArchive({ store: true }); // MP3 déjà compressé : on ne recompresse pas
  archive.on("error", () => res.destroy());
  archive.pipe(res);
  archive.directory(job.folder, zipName);
  void archive.finalize();
});

app.get("/api/job/:id/file/:index", (req, res) => {
  const job = getJob(req, res);
  const file = job?.tracks[Number(req.params.index)]?.file;
  if (!job || !job.folder) return;
  if (!file) {
    res.status(404).json({ error: "Fichier indisponible" });
    return;
  }
  res.attachment(file);
  createReadStream(path.join(job.folder, file)).pipe(res);
});

app.post("/api/open", localOnly, (req, res) => {
  const folder = String(req.body.folder ?? "");
  if (folder && existsSync(folder)) spawn("open", [folder], { detached: true, stdio: "ignore" }).unref();
  res.json({ ok: true });
});

app.post("/api/eject", localOnly, async (req, res) => {
  const target = String(req.body.path ?? "");
  if (!(await listVolumes()).some((v) => v.path === target)) {
    res.status(400).json({ error: "Volume invalide" });
    return;
  }
  execFile("diskutil", ["eject", target], (err, stdout, stderr) => {
    if (err) res.status(500).json({ error: (stderr || stdout || err.message).trim() });
    else res.json({ ok: true });
  });
});

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`MP3 Spotify (${WEB ? "mode web" : "mode local"}) tourne sur ${url}`);
  if (!WEB && !process.env.NO_OPEN) spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
});
