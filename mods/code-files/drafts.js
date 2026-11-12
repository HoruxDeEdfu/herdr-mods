// Unsaved edits kept on disk so a restart or a layout switch never loses them.
// Lives in this mod's hidden .drafts folder: Herdr doesn't reload mods for hidden files.
import * as fs from "fs/promises";
import { appHome } from "herdr";

const dir = () => `${appHome()}/mods/code-files/.drafts`;
const file = () => `${dir()}/drafts.json`;

export async function loadDrafts() {
  try { return JSON.parse(await fs.readFile(file(), "utf8")) ?? {}; }
  catch { return {}; }
}

// drafts: { [absolutePath]: { text, baseline, at } }
export async function saveDrafts(drafts) {
  try {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(drafts));
  } catch (e) { console.log(`code-files: cannot keep drafts: ${e}`); }
}
