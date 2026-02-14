# Assemble extension prompts

This folder contains snapshots of the prompts currently used by this repo:

- `agent-prompts/scout.md`
- `agent-prompts/planner.md`
- `agent-prompts/worker.md`
- `agent-prompts/reviewer.md`

The runtime behavior of `/assemble` is controlled by the live agent files in:

- `~/.pi/agent/agents/scout.md`
- `~/.pi/agent/agents/planner.md`
- `~/.pi/agent/agents/worker.md`
- `~/.pi/agent/agents/reviewer.md`

`/assemble` calls `scout`, `planner`, `worker`, `reviewer` by name from
`buildAssemblePrompt` in `extensions/assemble/index.ts`, and those names resolve
to your agent files loaded by pi.

## Keep them in sync (optional)

The files in this folder are snapshots for documentation/reproducibility.

To refresh snapshots from your live prompts:

```bash
mkdir -p extensions/assemble/docs/agent-prompts
cp ~/.pi/agent/agents/scout.md extensions/assemble/docs/agent-prompts/
cp ~/.pi/agent/agents/planner.md extensions/assemble/docs/agent-prompts/
cp ~/.pi/agent/agents/worker.md extensions/assemble/docs/agent-prompts/
cp ~/.pi/agent/agents/reviewer.md extensions/assemble/docs/agent-prompts/
```

To apply these prompts to pi (so `/assemble` uses them), edit/copy into:

```bash
mkdir -p ~/.pi/agent/agents
cp extensions/assemble/docs/agent-prompts/*.md ~/.pi/agent/agents/
```

Then reload pi:

```bash
/reload
```

Then run:

```bash
/assemble ENG-123
```
