// Lanes for a compact commit graph. Pure. Input: commits in --topo-order
// (each { hash, parents }). Output per commit:
//   { col, top: [cols], bottom: [cols], links: [cols], lanes }
//   col     the commit's own lane;
//   top     lanes drawn from the row's top edge to its middle (coming in);
//   bottom  lanes drawn from the middle to the bottom edge (going on);
//   links   lanes joined to `col` by a horizontal line at the middle
//           (branches merging into this commit, or its extra parents);
//   lanes   width of the row in lanes.
// Lanes are reused as soon as they free up, so the graph stays narrow.

export function layoutGraph(commits) {
  const lanes = []; // lanes[i] = hash expected next in lane i, or null
  const out = [];
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    const top = [];
    lanes.forEach((h, i) => { if (h !== null) top.push(i); });
    if (col < 0) { col = free(lanes); lanes[col] = c.hash; }
    const links = [];
    // Other lanes that were waiting for this commit end here (it had several children).
    lanes.forEach((h, i) => { if (h === c.hash && i !== col) { links.push(i); lanes[i] = null; } });
    // First parent continues in this lane; others go to an existing lane or a new one.
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) { k = free(lanes); lanes[k] = p; }
      if (k !== col && !links.includes(k)) links.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const bottom = [];
    lanes.forEach((h, i) => { if (h !== null) bottom.push(i); });
    const width = Math.max(col + 1, ...top.map((i) => i + 1), ...bottom.map((i) => i + 1), ...links.map((i) => i + 1));
    out.push({ col, top, bottom, links, lanes: width });
  }
  return out;
}

function free(lanes) {
  const i = lanes.indexOf(null);
  if (i >= 0) return i;
  lanes.push(null);
  return lanes.length - 1;
}
