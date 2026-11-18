// Image tabs. GPUI's image() only loads from the app's own folder, so an opened
// image is copied into this mod's hidden .cache folder (hidden: Herdr doesn't
// reload mods for hidden files) and shown from there.
//
// Each panel copy owns .cache/<uid>/ and empties it when it closes; a copy's tab
// file goes as soon as its tab closes. A folder whose owner stopped sending
// heartbeats (Herdr quit or crashed) is swept by the next copy that starts.
import * as fs from "fs/promises";
import { appHome, exec, shared, setShared, window } from "herdr";
import { createHash } from "crypto";
import { Buffer } from "buffer";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|svg)$/i;
export const isImage = (path) => IMAGE_EXT.test(path);
export const LOCAL_LIMIT = 20 * 1024 * 1024;  // 20 MiB on this machine
export const REMOTE_LIMIT = 6 * 1024 * 1024;  // exec output is capped at 8 MiB and base64 adds a third

const ALIVE = "code-files.cache-alive";
const STALE = 5 * 60 * 1000;
const REL = "mods/code-files/.cache";
const root = () => `${appHome()}/${REL}`;

export const formatBytes = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---------- cache lifetime ----------

export function heartbeat(uid) {
  const now = Date.now(), alive = {};
  for (const [id, at] of Object.entries(shared(ALIVE) ?? {})) if (now - at < STALE) alive[id] = at;
  alive[uid] = now;
  setShared(ALIVE, alive);
}

async function removeDir(dir) {
  try {
    for (const name of await fs.readdir(dir)) await fs.unlink(`${dir}/${name}`).catch(() => {});
    await fs.rmdir(dir);
  } catch {}
}

// Removes the folders of copies that are gone (and stray files left at the top level).
export async function sweep(uid) {
  const alive = shared(ALIVE) ?? {}, now = Date.now();
  let names;
  try { names = await fs.readdir(root(), { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (d.name === uid) continue;
    if (!d.isDirectory()) { await fs.unlink(`${root()}/${d.name}`).catch(() => {}); continue; }
    const at = alive[d.name];
    if (!at || now - at > STALE) await removeDir(`${root()}/${d.name}`);
  }
}

export async function clearOwn(uid) {
  await removeDir(`${root()}/${uid}`);
  const alive = { ...(shared(ALIVE) ?? {}) };
  if (alive[uid]) { delete alive[uid]; setShared(ALIVE, alive); }
}

export async function dropFile(uid, name) {
  if (name) await fs.unlink(`${root()}/${uid}/${name}`).catch(() => {});
}

// ---------- loading ----------

const SIZE_SCRIPT = 'wc -c < "$1"';

async function sizeOf(path, on) {
  if (!on && window()?.platform === "windows") return null; // checked after reading
  const r = await exec("sh", ["-c", SIZE_SCRIPT, "size", path], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "This file is no longer available");
  return Number(r.stdout.trim());
}

async function readBytes(path, on) {
  if (!on) return Buffer.from(await fs.readFile(path));
  const r = await exec("sh", ["-c", 'base64 < "$1"', "read", path], { on, timeout: 60000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image");
  return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
}

// Reads an image (within the limit) into this copy's cache folder.
// Returns { src, name, hash, bytes, width, height, format }; throws an Error whose message is shown.
export async function loadImage(uid, path, on) {
  const limit = on ? REMOTE_LIMIT : LOCAL_LIMIT;
  const size = await sizeOf(path, on);
  if (size !== null && size > limit) throw new Error(`Image too large to preview (${formatBytes(size)}; up to ${formatBytes(limit)} ${on ? "from another machine" : "here"})`);
  const bytes = await readBytes(path, on);
  if (bytes.length > limit) throw new Error(`Image too large to preview (${formatBytes(bytes.length)}; up to ${formatBytes(limit)})`);
  const ext = (path.match(IMAGE_EXT)?.[1] ?? "png").toLowerCase();
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 20);
  const name = `${hash}.${ext}`, dir = `${root()}/${uid}`;
  await fs.mkdir(dir, { recursive: true });
  if (!(await fs.exists(`${dir}/${name}`))) await fs.writeFile(`${dir}/${name}`, new Uint8Array(bytes));
  const dims = dimensions(bytes, ext);
  return { src: `${REL}/${uid}/${name}`, name, hash, bytes: bytes.length, width: dims?.width ?? null, height: dims?.height ?? null, format: ext === "jpeg" ? "JPG" : ext.toUpperCase() };
}

// ---------- natural size, from the file header ----------

export function dimensions(b, ext) {
  try {
    const u16be = (o) => b[o] << 8 | b[o + 1], u16le = (o) => b[o] | b[o + 1] << 8;
    const u32be = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
    const i32le = (o) => b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24;
    if (b[0] === 0x89 && b[1] === 0x50) return { width: u32be(16), height: u32be(20) };                    // PNG
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) };     // GIF
    if (b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(i32le(18)), height: Math.abs(i32le(22)) }; // BMP
    if (b[0] === 0xff && b[1] === 0xd8) {                                                                // JPEG
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(o + 7), height: u16be(o + 5) };
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { o += m === 0xff ? 1 : 2; continue; }
        o += 2 + u16be(o + 2);
      }
      return null;
    }
    if (String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") { // WebP
      const kind = String.fromCharCode(...b.subarray(12, 16));
      if (kind === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      if (kind === "VP8L") { const bits = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24; return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
      if (kind === "VP8X") return { width: 1 + (b[24] | b[25] << 8 | b[26] << 16), height: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
      return null;
    }
    if (ext === "ico" && b[2] === 1) return { width: b[6] || 256, height: b[7] || 256 };
    if (ext === "svg") {
      const head = Buffer.from(b.subarray(0, 4096)).toString("utf8"), tag = head.match(/<svg\b[^>]*>/i)?.[0] ?? "";
      const num = (attr) => { const v = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i")); return v ? Number(v[1]) : null; };
      let width = num("width"), height = num("height");
      const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if ((!width || !height) && vb) { width = Number(vb[1]); height = Number(vb[2]); }
      return width && height ? { width: Math.round(width), height: Math.round(height) } : null;
    }
  } catch {}
  return null;
}
