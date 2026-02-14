# Assemble extension prompts

This folder contains recommended prompt templates for the four agents used by `/assemble`:

- `agent-prompts/scout.md`
- `agent-prompts/planner.md`
- `agent-prompts/worker.md`
- `agent-prompts/reviewer.md`

The extension expects these agents to exist at `~/.pi/agent/agents/<agent-name>.md` when `/assemble` runs.

`assemble` will call them in this flow:

1. `scout` (discovery)
2. `planner` (plan creation)
3. `worker` → `reviewer` (iterative implementation/review loop)

## Add these prompts to Pi

1. Open the files above and copy each one to your agent directory:

```bash
mkdir -p ~/.pi/agent/agents
cp extensions/assemble/docs/agent-prompts/*.md ~/.pi/agent/agents/
```

2. Reload pi so the agent files are picked up:

```bash
/reload
```

3. Run:

```bash
/assemble ENG-123
```

## What each prompt should do

- `scout`: gather relevant code context and constraints quickly.
- `planner`: produce a concise, concrete implementation plan with files, risks, and acceptance criteria.
- `worker`: implement the plan exactly with minimal surface-area changes.
- `reviewer`: validate parity with the plan, correctness, edge cases, and suggest fixes.

Keep these prompts repo-checked as they are now to make `/assemble` behavior consistent across environments.

