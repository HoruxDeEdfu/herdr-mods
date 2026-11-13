// Is this exact text already stored in Git? A tab whose unsaved text is a
// version Git has (another branch's, left open across a checkout) loses
// nothing on reload. Pure (hash function and bytes injected) so Node can test it.

/** Git's blob id for a text: sha1("blob <bytes>\0" + bytes), as `git hash-object` gives. */
export function blobId(text, createHash, toBytes) {
  const bytes = toBytes(text);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** `git cat-file -e <id>` answers 0 when the object exists. */
export const knownArgs = (id) => ["cat-file", "-e", id];

/** The folder to ask Git from: the file's own (a repo's subfolder works). */
export const folderOf = (path) => path.replace(/[\\/][^\\/]*$/, "") || "/";
