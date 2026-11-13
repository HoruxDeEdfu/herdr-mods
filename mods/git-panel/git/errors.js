// Git's stderr → a sentence a person can act on. The raw text stays in the log.

const RULES = [
  [/index\.lock|Unable to create .*\.lock|another git process/i, "Otro proceso de Git (quizá un agente) está usando este repositorio. Espera a que termine y vuelve a intentarlo."],
  [/would be overwritten by (checkout|merge|switch)/i, (m, s) => `Git se detuvo para no sobrescribir cambios locales en: ${files(s)}. Haz commit o guárdalos tú mismo antes de continuar.`],
  [/untracked working tree files would be (overwritten|removed)/i, (m, s) => `Hay archivos sin seguimiento que la operación sobrescribiría: ${files(s)}.`],
  [/is already (checked out|used by worktree) at '([^']+)'/i, (m) => `Esa rama ya está abierta en otro worktree (${m[2]}). Git no permite tenerla en dos sitios a la vez.`],
  [/refusing to merge unrelated histories/i, "Las ramas no comparten historia. Git no las fusiona sin una opción explícita."],
  [/Not possible to fast-forward|Diverging branches can't be fast-forwarded/i, "No es posible avanzar en línea recta (fast-forward): las ramas divergieron."],
  [/not something we can merge|unknown revision|bad revision|invalid reference/i, "La rama o el commit ya no existe. Actualiza el panel."],
  [/You have not concluded your merge|MERGE_HEAD exists/i, "Hay un merge sin terminar. Termínalo o abórtalo antes de continuar."],
  [/not fully merged/i, "La rama tiene commits que no están integrados en ninguna otra. Borrarla los dejaría inaccesibles."],
  [/already exists/i, "Ya existe una rama con ese nombre."],
  [/is not a valid branch name/i, "Ese nombre no es válido para una rama."],
  [/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey/i, "El remoto pidió credenciales. Ejecuta la operación una vez desde una terminal para autenticarte."],
  [/Could not resolve host|unable to access|Connection (timed out|refused)|Could not read from remote/i, "No se pudo contactar con el remoto. Revisa la conexión o la URL."],
  [/timed out|timeout/i, "La operación tardó demasiado y se detuvo."],
  [/No changes - did you forget to use 'git add'|nothing to commit|The previous cherry-pick is now empty/i, "Después de resolver, este commit ya no cambia nada. Git no puede continuar con un commit vacío: aborta, o termínalo desde la terminal (git rebase --skip lo omite)."],
  [/patch does not apply|while searching for:|corrupt patch/i, "El archivo cambió desde que se mostró el diff. Se actualizó: vuelve a elegir el fragmento."],
  [/remote rejected.*(protected|deletion of the current branch|refusing to delete)|protected branch|cannot delete/i, "El remoto rechazó eliminar la rama (puede estar protegida o ser su rama principal). No se cambió nada."],
  [/unable to delete '[^']*': remote ref does not exist/i, "La rama ya no existe en el remoto: alguien la eliminó antes."],
  [/CONFLICT/, "El merge tiene conflictos. Resuélvelos o aborta el merge."],
  [/not a git repository/i, "Esta carpeta no es un repositorio Git."],
];

function files(stderr) {
  const list = stderr.split("\n").filter((l) => /^\t/.test(l)).map((l) => l.trim());
  return list.length ? list.slice(0, 5).join(", ") + (list.length > 5 ? ` y ${list.length - 5} más` : "") : "varios archivos";
}

export function explain(error) {
  if (error?.plain) return error.message; // the panel's own sentence, not Git's
  const text = String(error?.stderr || error?.message || error || "");
  for (const [re, msg] of RULES) {
    const m = re.exec(text);
    if (m) return typeof msg === "function" ? msg(m, text) : msg;
  }
  const first = text.split("\n").map((l) => l.replace(/^(fatal|error): /, "")).find((l) => l.trim());
  return first ? `Git: ${first.trim()}` : "Git falló sin dar detalles.";
}
