# Rules for AI agents

Repository is **public**. Every commit is visible.

## Never commit

- Real names, emails, phones, messenger handles
- Absolute home paths — use `~` or relative
- Real hosts / IPs of prod/dev servers, public domains — use placeholders
- `.env` contents, tokens, keys, passwords (Discord bot token, OAuth client secret)
- Output of `whoami`, `hostname`, `id`, `env`

## Git

- Conventional commits (`feat:`, `fix:`, `chore:`).
- No `--amend` on published commits, no force-push to `master`.
