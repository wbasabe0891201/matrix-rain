# matrix-rain

A Claude Code mod that opens a pane with Matrix-style digital rain, made from what Claude is doing right now instead of random glyphs:

| Priority | Source | Color |
|---|---|---|
| 1 | A question Claude asks you, its options, and then your answer; a permission Claude asks for, with the tool and what it wants to run | green; permissions near-white |
| 2 | Lines Claude adds or changes with `Edit` / `Write` | green |
| 3 | Test runs (Maven, Gradle, flutter/dart, Jest, Vitest, pytest, go, cargo, bun, `claude plugin test`...) and errors from any tool | green, failing lines and errors in **red** |
| 4 | What Claude reads: files, shell output, `WebFetch`, `WebSearch`, MCP and other tools, skills it loads | green |
| 5 | Claude's thinking and replies, slash commands, messages from other sessions or background tasks, and the tokens each turn used | green |

On top of that queue:

- **What you type** falls the moment you type it, key by key, in a near-white column that grows with each key and closes after a second and a half of silence.
- **Subagents** fall in a dimmer green, so you can tell another agent's work from Claude's own.
- **`git commit` and `git push`** fall brighter, with longer trails.

Events with an effect of their own:

- **Waiting for you:** while a question or a permission waits for your answer, a `> █` prompt blinks on the bottom row, like the terminal in the film's "Wake up, Neo..." scene.
- **Déjà vu:** when you run `/compact`, or the context is compacted on its own, the rain freezes, flashes, and the last lines fall again, like the black cat that walks by twice.
- **Interrupt:** when you press Esc mid-turn, the rain freezes for an instant, everything still queued is dropped, and what is on screen collapses.

When nothing is happening, nothing falls: the columns finish, the trails fade out and the pane goes black.

The colors follow the film: a black background, a near-white head on each column, and a trail that fades from mint through `#00FF41` to dark green.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install matrix-rain --marketplace wbasabe0891201/matrix-rain
```

From a shell:

```
claude plugin install matrix-rain --marketplace wbasabe0891201/matrix-rain
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `wbasabe0891201/matrix-rain`, then Add plugin. The rain itself only draws in the terminal.

## Use

Type `/matrix` to open or close the pane. If you leave it open, it opens again in your next session. It docks on the right in Claude Code's fullscreen layout. On the main screen (inside tmux, for example) it sits above the prompt.

## Privacy

Nothing from `.env` files, shell rc files, `.netrc`/`.npmrc`, `credentials*`, `.pem`/`.key` files or SSH keys is ever shown. Values that look like keys, tokens or passwords are replaced with `****`. Everything stays on your machine: the mod only draws in your terminal.

## Limits

- Test output arrives when the command finishes. While a test run is in progress, only the command itself falls.
- A permission waits from Claude Code's "ask" verdict until the call starts or is refused. In auto mode a classifier answers most asks first, so the cursor may blink for a moment with no dialog shown.
- If another plugin handles compaction before this one and does not pass it on, automatic compaction shows no déjà vu. `/compact` still shows it.
- Glyphs are not mirrored as in the film, since a terminal cannot flip characters.

## License

MIT
