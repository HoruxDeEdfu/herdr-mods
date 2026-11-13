# Git panel (etapas 1, 2 y 3)

Panel Git compacto para el panel derecho de Herdr, junto a Files y Changes.
Muestra el repositorio del pane enfocado: rama, upstream, estado del working tree,
ramas, historial y cambios. Permite fetch, checkout seguro, crear, renombrar y
eliminar ramas, y hacer merge con vista previa desde dos puntos de entrada.

## Qué se instaló

| Ruta | Qué es |
|---|---|
| `mods/git-panel/` | Este mod (nuevo). |
| `mods/git-spaces/` | Copia del mod `spaces` de Herdr que añade **●n** (archivos con cambios sin commit) junto a ↑↓ en la lista de espacios, y **⚠ merge·2** en rojo si en ese espacio hay una operación a medias (merge, rebase, cherry-pick, revert, bisect) o archivos en conflicto. |
| `mods/git-tabs/` | Copia del mod `tabs` de Herdr con un botón **Git** añadido. |
| `layouts/main-code.json` | Tu layout. Se añadió el bloque `git` a la pila `panel-body` y la barra superior usa `git-tabs`. |
| `layouts/main-code.json.bak-gitpanel-*` | Copia del layout antes del cambio. |

| `mods/code-files/main.js` | **7 líneas añadidas** (opción A) para que el Git panel abra archivos en tu editor. Están marcadas con el comentario `git-panel integration`. Copia previa: `~/herdr-git-panel-dev/backups/code-files-main.js.bak`. |

No se modificaron `files`, `changes` ni ningún mod o layout de Herdr.

## Uso

- **Abrir:** botón **Git** en la barra superior, junto a Files y Changes. El botón muestra cuántos archivos tienen cambios sin commit, o **⚠n** en rojo si hay una operación a medias o conflictos, aunque el panel esté oculto.
- **Cabecera:**
  - Muestra el repositorio, la rama (HEAD), el upstream con ↑ahead ↓behind y el estado del working tree.
  - Si hay un merge, rebase, cherry-pick, revert o bisect en curso, aparece un aviso con **Ver** y **Abortar** (siempre con confirmación), y **Continuar** en cherry-pick, revert y rebase. El rebase muestra rama, base y progreso ("Rebase de feature sobre main · 2/5"); el bisect se cierra con **Terminar bisect** (`git bisect reset`). Si hay archivos sin guardar en el editor, Continuar y Abortar se bloquean.
  - En un rebase, "ours" es la base (main) y "theirs" es tu commit: las etiquetas del conflicto lo dicen así.
  - Barra de acciones como la de Fork: **Fetch**, **Pull ↓n**, **Push ↑n** (sobre la rama actual; los números aparecen solo si hay algo que traer o publicar, y el botón se resalta), **Merge…** y **⇄** (comparar)
- **Branches:**
  - Clic selecciona; doble clic cambia de rama, siempre con confirmación.
  - Clic derecho o **Acciones ⋯** abre el menú contextual.
  - ◆ indica una rama abierta en otro worktree.
- **History:** los commits se cargan de 200 en 200. Un fast-forward no deja commit propio, así que el panel lee el reflog de cada rama local y marca con `← main antes del ff` el commit donde estaba la rama antes de avanzar (hasta 3 por rama, últimos 30 días); el detalle de ese commit lo explica. Clic sobre un commit muestra el detalle y sus archivos. "Todas las ramas" incluye remotas y tags.
- **Changes:**
  - Grupos: Conflictos, En stage, Modificados y Sin seguimiento, con +/− líneas por archivo.
  - Clic en un archivo: muestra su diff debajo.
  - **+** / **−**: stage o unstage de un archivo. "Stage todo" y "Unstage todo" por grupo. Unstage nunca toca el archivo.
  - **↗** o doble clic: abre el archivo en tu editor Files.
  - **✓** en un conflicto: lo marca como resuelto. Si aún tiene marcadores `<<<<<<<`, pide confirmación.
  - **Commit:** escribe el mensaje y pulsa Commit (Enter también funciona). Durante un merge, sin mensaje, concluye el merge con el mensaje de Git.
  - Si un archivo en stage tiene cambios sin guardar en el editor, avisa de que el commit usará la versión en disco.
- **Pull** (barra de arriba), como en Fork: hace fetch y después:
  - si no hay nada que traer, solo muestra una notificación de Herdr;
  - si es un fast-forward limpio (tus cambios locales no chocan), lo ejecuta directamente y lo notifica;
  - si las ramas divergieron o algo choca, abre la vista previa segura del merge.
- **Editor Files después de un checkout o merge:** las pestañas sin cambios siguen al disco solas. Si una pestaña con texto sin guardar ve cambiar su archivo y ese texto es una versión que Git ya guarda (la de otra rama), la barra lo dice y **Reload** recarga sin preguntar, porque no se pierde nada. Nunca recarga sola; una edición real conserva la barra roja.
- **Notificaciones:** los éxitos y los avisos informativos salen como notificaciones nativas de Herdr. Las advertencias y los errores se quedan en el panel hasta que los cierras.
- **Push** (barra de arriba): revisión de los commits que se van a publicar y confirmación. Nunca hace force push. Si el remoto tiene commits que tú no tienes, lo explica y ofrece Pull.
- **Menú de una rama:**
  - Rama actual: **Pull** y **Push**.
  - Otra rama: **Actualizar ↓n** (fast-forward a su upstream sin cambiar de rama; si divergió, te lo dice) y **Push ↑n**.
  - Merge con flechas origen → destino: `Fusionar dev → main…` (cambia a main, con confirmación) y `Fusionar main → dev…` (en la rama actual).
- **Diffs desde History y Compare:** clic en un archivo del detalle de un commit o de una comparación.
- **History, grafo:** carriles de color con bifurcaciones y merges (círculo hueco = commit de merge). Se oculta con "Ocultar grafo" o la tecla `g`, y desaparece solo en paneles de menos de 380 px.
- **Cherry-pick y revert:** clic derecho en un commit, o los botones de su detalle.
  - Vista previa con simulación real de conflictos (`git merge-tree --merge-base`).
  - Bloquea si el commit ya está incluido, si sus cambios ya están en la rama (resultado vacío), si hay cambios locales en los archivos que toca, si hay archivos en stage o si hay otra operación en curso.
  - En un commit de merge usa `-m 1` y lo explica.
  - Si hay conflictos: la cabecera muestra **Continuar** y **Abortar**.
- **Conflictos:** clic en un archivo en conflicto (en Changes) abre el archivo con sus bloques coloreados: tu versión (ours) y lo que llega (theirs). Opciones:
  - **Abrir en Files**.
  - **Usar una versión entera**, con confirmación.
  - **Marcar resuelto**, que avisa si quedan marcadores.
- **Worktrees:** grupo propio en Branches cuando hay más de uno.
  - Doble clic: verlo en el panel.
  - Menú: abrirlo en un espacio de Herdr, eliminarlo (sin `--force`; Git se niega si tiene cambios) y podar los huérfanos.
  - Desde una rama: "Abrir en un worktree nuevo"; desde un commit: "Nuevo worktree desde aquí". Usan la misma carpeta que Herdr: `~/.herdr/worktrees/<repo>/<rama>`.
- **Teclado** (con el panel enfocado y fuera de los campos de texto):
  - `1` `2` `3`: cambiar de pestaña.
  - `↑` `↓` (o `j` `k`): moverse por la lista.
  - `Enter`: acciones de la rama, o detalle del commit.
  - `Espacio`: menú del commit.
  - `/`: filtrar ramas.
  - `f`: Fetch. `m`: Merge. `g`: grafo.
  - `Esc`: cerrar o volver.
- **Cuenta por proyecto** (si trabajas con varias cuentas de GitHub):
  - La píldora de la cabecera dice con qué cuenta se hará push: `○` cuenta global de gh, `◉` fijada a este proyecto, `⚠` si el correo del autor es de otra cuenta. El tooltip muestra también el autor de los commits.
  - Clic → **Fijar este proyecto a …**: pide nombre y correo (se recuerdan por cuenta) y los escribe solo en el `.git/config` de este repo, junto con la credencial de esa cuenta. Tu `~/.gitconfig` y los demás proyectos no cambian.
  - **Quitar la fijación** deja `.git/config` como estaba. **Cuenta global de gh → …** cambia la cuenta de todos los proyectos sin fijación (`gh auth switch`).
  - Push muestra la cuenta y el autor antes de confirmar, y la barra de commit muestra el autor.
  - Necesita GitHub CLI (`gh`). Con remotos SSH solo se fija el autor.
- **Log:** todos los comandos de escritura que ejecutó el panel (y las lecturas que fallaron), con su salida.

### Merge: dos entradas, una sola lógica

- **A. Desde la rama actual:** **Merge…** → elige la rama de origen → vista previa → *Fusionar X en (rama actual)*. No hay checkout.
- **B. Desde el menú de otra rama T:**
  - **"Integrar mi rama (actual) en T"**:
    1. Comprueba si se puede cambiar a T.
    2. Pide confirmación del checkout.
    3. Hace el checkout y verifica que T es la rama activa.
    4. Muestra la vista previa y pide una segunda confirmación para el merge.
  - **"Fusionar T en la actual"**: integra T en HEAD sin cambiar de rama.

La vista previa muestra:
- Origen y destino.
- Commits que entran y si es posible un fast-forward.
- Divergencia y sincronización con los upstreams.
- Archivos afectados.
- Conflictos según una simulación real (`git merge-tree`, que no toca tus archivos).
- Si es posible un fast-forward, el modo (`--ff`, `--no-ff`, `--ff-only`) y una línea que dice qué verás en el grafo: con fast-forward la rama solo avanza al último commit, **sin commit de merge**, y en clientes como Fork parece que no pasó nada; elige "Siempre crear commit de merge" si quieres verlo. El resultado del merge lo repite con el hash nuevo.
- El modo empieza en el último que confirmaste en ese repositorio (compartido por sus worktrees) y lo indica con "Modo recordado…". Pull no lo usa ni lo cambia: sigue haciendo fast-forward. Si las ramas divergieron, siempre hay commit de merge y el modo no aplica.
- Avisos y bloqueos.

Justo antes de ejecutar, el panel vuelve a leer el repositorio. Si algo cambió (por ejemplo, un agente hizo commit), muestra la vista previa actualizada en lugar de fusionar.

### Seguridad

- Nunca usa `stash`, `reset --hard`, `clean`, `--force` ni force push. Borrar una rama sin integrar (`-D`) requiere una segunda confirmación explícita.
- Bloquea la operación si:
  - hay un merge, rebase, cherry-pick, revert o bisect en curso;
  - hay archivos en conflicto;
  - hay cambios locales en archivos que el merge modifica;
  - hay archivos sin guardar en el editor Files (lo lee de `mods/code-files/.drafts/drafts.json` sin modificarlo);
  - la rama está abierta en otro worktree. En ese caso ofrece hacer el merge allí, sin checkout.
- Cada acción queda ligada al repositorio en que se abrió su confirmación. Cambiar de espacio o de pane no la redirige a otro repositorio.
- Las escrituras de un mismo repositorio se ejecutan de una en una. Las lecturas no bloquean el índice (`--no-optional-locks`), así que no estorban a los agentes.
- Fetch se ejecuta con `GIT_TERMINAL_PROMPT=0`: si el remoto pide credenciales, falla con un mensaje claro en vez de quedarse esperando.

### Actualización con agentes

- Vigila con `watchFolder` la carpeta del worktree y el `git-common-dir`, que es donde viven las refs que comparten todos los worktrees.
- Los eventos se agrupan y el panel se refresca como máximo cada 1,5 s.
- Si el watcher no dispara, hay un respaldo por tiempo: cada 10 s en local, cada 20 s en remoto y cada 60 s si el panel está oculto.
- Las selecciones se identifican por nombre de ref y hash, así que sobreviven a los refrescos.
- Cada agente puede trabajar en su propio worktree: el panel sigue el pane enfocado, o el worktree que fijes desde una rama (◆ → "Ver ese worktree en el panel").

## Reversión

**Solo el parche del editor:** `cp ~/herdr-git-panel-dev/backups/code-files-main.js.bak ~/.config/herdr-app/mods/code-files/main.js`. También puedes borrar a mano el bloque `git-panel integration`. Sin él, ↗ muestra Files pero no abre el archivo.

**Todo el panel:**

1. Restaura el layout desde la copia de seguridad:
   `cp ~/.config/herdr-app/layouts/main-code.json.bak-gitpanel-* ~/.config/herdr-app/layouts/main-code.json`
   También puedes editarlo a mano: quita el bloque con `"id": "git"` vuelve a poner `"mod": "tabs"` en el bloque `tabs` y `"mod": "spaces"` en el bloque `spaces`.
2. Borra `~/.config/herdr-app/mods/git-panel`, `~/.config/herdr-app/mods/git-spaces` y `~/.config/herdr-app/mods/git-tabs`.

Herdr aplica los cambios al momento. Si algo falla, `ctrl-alt-shift-escape` vuelve al layout por defecto.

## Pruebas

Están en `~/herdr-git-panel-dev/test/` (`git.test.mjs`, `stage2.test.mjs` y `stage3.test.mjs`). Se ejecutan con `node --test ~/herdr-git-panel-dev/test/*.mjs` y usan solo repos temporales.

## Límites conocidos

- Rebase y bisect no se inician desde el panel, y el panel nunca omite commits (`rebase --skip`): eso queda para la terminal.
- El grafo dibuja hasta 6 carriles; los demás se agrupan en el último, en gris.
- En espacios de otras máquinas no hay watcher: el panel se refresca cada 20 s.
