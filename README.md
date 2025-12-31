# zagi

> a better git interface for agents

## Why use zagi?

- 121 git compatible commands
- ~50% smaller output that doesn't overflow context windows
- 1.5-2x faster than git in all implemented commands
- Agent friendly features like `fork`, `prompt` and `guardrails`
- Git passthrough for non implemented commands

## Installation

```bash
curl -fsSL zagi.sh/install | sh
```

This downloads the binary and sets up `git` as an alias to `zagi`. Restart your shell after installation.

### From source

```bash
git clone https://github.com/mattzcarey/zagi.git
cd zagi
zig build -Doptimize=ReleaseFast
./zig-out/bin/zagi alias  # set up the alias
```

#### Windows

Building on Windows requires **Developer Mode** enabled (Settings > Privacy & Security > For developers > Developer Mode). This is needed for libgit2 symlink creation during build.

```powershell
git clone https://github.com/mattzcarey/zagi.git
cd zagi
zig build -Doptimize=ReleaseFast
```

To set up `git` alias in PowerShell, add this to your profile (`$PROFILE`):

```powershell
# Create profile if it doesn't exist
if (!(Test-Path -Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }

# Add zagi alias
Add-Content -Path $PROFILE -Value "function git { C:\path\to\zagi.exe @args }"
```

Restart PowerShell after adding the alias.

## Usage

Use git as normal:

```bash
git status         # compact status
git log            # concise commit history
git diff           # minimal diff format
git add .          # confirms what was staged
git commit -m "x"  # shows commit stats
```

Any commands or flags not yet implemented in zagi pass through to git. zagi also comes with its own set of features for managing code written by agents.

### Easy worktrees

zagi ships with a wrapper around worktrees called `fork`:

```bash
# Create named forks for different approaches your agent could take
git fork nodejs-based
git fork bun-based

# Work in each fork
cd .forks/nodejs-based
# ... make changes, commit ...

cd .forks/bun-based
# ... make changes, commit ...

# Compare results, then pick the winner
cd ../..
git fork                       # list forks with commit counts
git fork --pick bun-based      # merge fork into base (keeps both histories)
git fork --promote bun-based   # replace base with fork (discards base commits)

# Clean up
git fork --delete-all
```

### Agent mode

Set `ZAGI_AGENT` to enable agent-specific features.

```bash
export ZAGI_AGENT=claude-code
```

The value can be any string describing your agent (e.g. `claude-code`, `cursor`, `opencode`) - this will be used in future features for agent-specific behavior.

This enables:
- **Prompt tracking**: `git commit` requires `--prompt` to record the user request that created the commit
- **Guardrails**: Blocks destructive commands (`reset --hard`, `checkout .`, `clean -f`, `push --force`) to prevent data loss

```bash
git commit -m "Add feature" --prompt "Add a logout button to the header.."
git log --prompts  # view prompts
```

To prevent child processes from overriding `ZAGI_AGENT`, make it readonly:

```bash
# bash/zsh
export ZAGI_AGENT=claude-code
readonly ZAGI_AGENT
```

### Strip co-authors

Remove `Co-Authored-By:` lines that AI tools like Claude Code add to commit messages:

```bash
export ZAGI_STRIP_COAUTHORS=1
git commit -m "Add feature

Co-Authored-By: Claude <claude@anthropic.com>"  # stripped automatically
```

### Git passthrough

Commands zagi doesn't implement pass through to git or use `-g` to force standard git output:

```bash
git -g log         # native git log output
git --git diff     # native git diff output
```

## Output comparison

Standard git log:

```
commit abc123f4567890def1234567890abcdef12345
Author: Alice Smith <alice@example.com>
Date:   Mon Jan 15 14:32:21 2025 -0800

    Add user authentication system
```

zagi log:

```
abc123f (2025-01-15) Alice: Add user authentication system
```

## Development

Requirements: Zig 0.15, Bun

```bash
zig build                           # build
zig build test                      # run zig tests
cd test && bun i && bun run test    # run integration tests
```

See [AGENTS.md](AGENTS.md) for contribution guidelines.

## License

MIT
