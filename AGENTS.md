<!-- pithy:begin — pithy upgrade rewrites this block. Edit outside it. -->
## Pithy

This project is built on Pithy. Drive it through the `pithy` CLI.

- Run `pithy schema --json` for every command, flag and `--json` payload the installed version takes, or name one command after `schema` for that one.
- Set `PITHY_JSON=compact` so every `--json` document is one line, at a terminal or not.
- Set `PITHY_NONINTERACTIVE=1` so no prompt waits on you. A question with no default fails `input/required` and names the flag that answers it.
- Run a command that changes anything with `--dry-run` first, where it takes one, and show a person the plan.
- `pithy remove` and every typed confirmation phrase belong to a person. Exit 5 means stop and ask. Never try variations.

An app route is an MCP tool for its users' agents only when its `describeRoute` says so: `operation` names it, and `tool: true` on a `GET` or `tool: { effect }` on anything else opts it in, with `power` for the role a caller must hold. `operation` is permanent, because an agent calls the tool by that name.

To administer a deployed environment, a person runs `pithy mcp connect` with `--scope manifest:read` and only the read scopes needed, never `--scope all` or `keys:rotate` at first, and it serves the Worker's admin routes as tools. With no `--scope` it grants every read plus `keys:rotate`. Ask a person before each call that is not a read, and leave `pithy mcp disconnect` to them.

Each failure exits by kind, so test for non-zero, not `1`. Under `--json` a failure is one `error` line on stderr, carrying `exit`, `retryable`, and `fix` when a command fixes it.

The exception is a report. `pithy doctor`, `pithy deploy`, `pithy upgrade` and `pithy ui sync` write their report on stdout and no `error` line when they find something: read the report. Each exits 1, except that a `pithy deploy` whose failed Worker row carries `exit` exits with the first such row's `exit`.

| Exit | Meaning | Do |
|---|---|---|
| 0 | Done | Continue |
| 1 | Unclassified failure | Read the error |
| 2 | Usage or validation | Fix the call |
| 3 | Precondition unmet | Run the `fix` command |
| 4 | Upstream or transient | Retry with backoff |
| 5 | Needs a person | Stop and ask |
| 130 | Interrupted | Stop |
| 141 | Output closed early | Read what arrived |
<!-- pithy:end -->
