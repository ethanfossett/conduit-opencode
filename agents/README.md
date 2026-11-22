# Agent library

Agents are OpenCode agent definitions (description, mode, model, variant, steps, prompt,
permission). This fork can manage them as standalone, portable JSON files.

## Layout

| Location | What it is |
|---|---|
| `agents/defaults/*.json` | Bundled defaults shipped with the app. Read-only templates; import one into your library to customize it. |
| `<Conduit config dir>/agents/*.json` | Your local library — one file per agent. This is the source of truth; copy the folder to back it up. |
| `<project>/.opencode/opencode.json` | Where explicitly **applied** agents are merged so OpenCode loads them for that project. |

A library file is the agent definition plus a `name`:

```json
{
  "name": "my-agent",
  "description": "What this agent does",
  "mode": "primary",
  "model": "provider/model",
  "variant": "max",
  "steps": 40,
  "prompt": "System prompt for the agent.",
  "permission": { "edit": "allow", "bash": "ask" }
}
```

Names must be lowercase letters, digits and dashes (`^[a-z0-9][a-z0-9-]{0,63}$`). All other
fields are passed through to OpenCode as-is, so newer OpenCode fields work without changes here.

## Backup, import, export

- One JSON file per agent means a manual backup is just copying the folder.
- Export from the UI produces a bundle: `{ "version": 1, "agents": [ ...definitions... ] }`.
- Import accepts that bundle; existing agents are kept unless you choose overwrite.
- Deleting from the library never touches OpenCode's global configuration.
- Applying to a project only writes the project overlay; removing undoes exactly that.

Model/variant changes reach OpenCode the next time it loads the project config (restart the
OpenCode instance for model changes; prompts and permissions are re-read on reload).
