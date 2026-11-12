---
description: The interactive terminal UI - the service picker, the run screen, its footer, keys and mouse, and what the memory figures mean.
---

# Terminal UI

```bash
pnpm sctl
```

With no arguments, stackctl opens its terminal UI: a picker to choose services, then a run
screen with their combined log. Everything in it works with the keyboard or the mouse.

## Choosing services

<llm-exclude><TerminalPlayer src="/casts/picker-1794447091.cast" label="The service picker: picking the frontend selects the backend it needs, then the list is filtered" /></llm-exclude>
<llm-only>

```text
── example ⎇ main ───────────────────────────────────── choose services ──
  space select   ↑↓ move   / filter   n none   ⏎ start   ^c quit

    ◉ backend     needed by frontend
    ◉ frontend
  ❯ ◉ worker

──────────────────────────────────────────────────────────────────────────
  will start  frontend · worker · backend   │   infra: db · mail
```

</llm-only>

- **`space`** selects the service under the cursor. So does a click on its row.
- **A dependency says what needs it** (`needed by frontend`), and stays selected while that
  service is.
- **The "will start" line** is exactly what `⏎` starts: your picks, their deps and the infra.
- **`/`** filters the list as you type. **`n`** clears the selection.
- **`⏎`** starts the session and remembers the selection for next time.

Skip the picker with `-s <service>` (repeatable), or `--last-answers` to reuse the saved
selection.

## The run screen

The log fills the screen, above a footer:

<llm-exclude><TerminalPlayer src="/casts/run-screen-1794447119.cast" label="The run screen: the focus moves across the services in the footer, then the backend restarts" /></llm-exclude>
<llm-only>

```text
── example ⎇ main ────────────────────────────────────────────────────────
● backend 62M   ● frontend 242M   ● worker 23M
infra: ● db 12M   ● mail 6M
←→ select   r restart   s stop   m commands
logs: f filter   c clear  │  ^c quit
backend ↗   public ↗   frontend ↗   root ↗   inbox ↗   mail ↗
```

</llm-only>

- **The rule line** names the workspace and its git branch.
- **The services rows** list each application service, then the [infra](../config/infra.md)
  services, with a state dot and the memory each uses.
- **The keys row** shows what the keys do for the focused service.
- **The links row** has each service's [`urls`](../config/urls.md#links-in-the-footer). Open
  one with Cmd+click, or your terminal's own link gesture.

| Dot                 | State                                                   |
| ------------------- | ------------------------------------------------------- |
| green `●`           | running, and healthy if it has a healthcheck            |
| blinking yellow `●` | starting, restarting, or running but not healthy yet    |
| cyan `○`            | waiting for a service it depends on                     |
| gray `○`            | pending                                                 |
| red `○`             | stopped or exited                                       |

Startup happens on this screen too. If it fails (the proxy's port is taken, an infra service
never gets healthy), nothing else starts, the reason is in the log, and the screen stays up for
reading. Ctrl+C then exits with code `1`.

## Keys

| Key                       | Action                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `←` `→` `↑` `↓`           | Focus another service.                                                                  |
| `r`                       | Restart the focused service.                                                            |
| `s`                       | Stop it, or start it when it isn't running.                                             |
| `m`                       | Open the commands menu: the service's scripts, and a custom shell command.              |
| `R`                       | Reset the focused infra service, **deleting its data**. Asks for a second `R`.          |
| `f`                       | Filter the log: type terms, `⏎` to apply, `esc` to clear.                               |
| `c`                       | Clear the log on screen. The log file keeps every line.                                 |
| PageUp/PageDown, Home/End | Scroll the log. End follows the newest line again.                                      |
| `esc`                     | Drop the text selection, then the newest notice, then the filter.                       |
| Ctrl+C                    | Quit. Asks for a second press within two seconds once services are running.             |

In the commands menu, `↑↓` choose a script, `←→` switch service, `⏎` runs it with the
service's environment, and `esc` closes the menu.

## Mouse

- **Click a service** to focus it, and **click a key hint** to do what its key does.
- **The wheel** scrolls the log.
- **Drag over the log** to select text. It is copied when you let go. Double-click selects a
  word, triple-click a line.

## Memory figures

- **A service's figure covers everything it runs**: its dev process and whatever that started
  (Vite's esbuild, the `node` under `node --watch`).
- **On macOS it is the number Activity Monitor shows.** On Linux it is the memory the processes
  hold privately, in RAM or swapped out. `906M` is 906 MiB.
- **An infra service's figure** is its containers' memory as `docker stats` reports it.

## Without a terminal

The UI needs a TTY. In a script, a CI job or an agent's shell, use
[`--headless`](../reference/cli.md#stackctl-start), which streams the same log to stdout.
