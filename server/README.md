# zagi-server

Git proxy server that makes a single branch feel like a whole repo.

## Why?

As software gets more customisable per user, each user needs version control akin to a whole repo - branches they can switch between, merging to main, commits they can step through.

In most apps this functionality will be hidden from the user directly, but it will still be needed under the hood. 

GitHub doesn't handle this well. Every git instance is just one repo. Making infinite git repos is what Lovable has had to do - one for each project. This won't scale to the web.

Instead: what if each user just gets a branch in GitHub (`user-alice`, `user-bob`), but our proxy makes that branch feel like a complete repo? Users get local branches stored in SQLite. When they push to `main`, it syncs to their GitHub branch.

The benefit: when you want to upgrade everyone, you rebase all user branches onto the new `main` in GitHub.

## How it works

```
User's View                     What Actually Happens
────────────────────────        ─────────────────────────────────────────────
git clone .../app/alice    →    Pulls user-alice branch from GitHub
                                Creates alice.sqlite for local branches

git checkout -b feature    →    Branch stored in SQLite only
git commit                 →    Commit stored in SQLite only
git push origin feature    →    Still just SQLite (not GitHub)

git checkout main          →
git merge feature          →
git push origin main       →    Syncs to user-alice branch on GitHub
```

Users get infinite branches locally. GitHub only sees their `main` as `user-alice`.

## Usage

```bash
bun run dev

# Clone as a user
git clone http://localhost:3000/my-app/alice
cd my-app

# Work with branches (all local to proxy)
git checkout -b feature
echo "new code" > file.txt
git add . && git commit -m "Add feature"
git push origin feature

# Merge to main (syncs to GitHub)
git checkout main
git merge feature
git push origin main
```

## Storage

```
GitHub (origin)              Proxy (SQLite)
───────────────              ────────────────────────────
main ─────────────────       .data/dbs/my-app/
user-alice ───────────  ←→     alice.sqlite (main + feature branches)
user-bob ─────────────  ←→     bob.sqlite (main + other branches)
user-charlie ─────────  ←→     charlie.sqlite
```

SQLite stores git objects (blobs, trees, commits) and refs (branches). No git binary needed.

## Architecture

```
┌─────────────┐
│   git CLI   │
└──────┬──────┘
       │ HTTP (smart protocol)
       ▼
┌─────────────────────────────────────┐
│           zagi-server               │
│                                     │
│  git-http-sqlite.ts  ←── protocol   │
│  git-storage.ts      ←── objects    │
│  git-pack.ts         ←── packfiles  │
│         │                           │
│         ▼                           │
│  ┌─────────────┐                    │
│  │   SQLite    │  per-user DBs      │
│  └─────────────┘                    │
│         │                           │
│         ▼ (on push to main)         │
│  ┌─────────────┐                    │
│  │   GitHub    │  user-xxx branches │
│  └─────────────┘                    │
└─────────────────────────────────────┘
```

## API

Git protocol (used by git CLI):
- `GET /<repo>/<user>/info/refs`
- `POST /<repo>/<user>/git-upload-pack`
- `POST /<repo>/<user>/git-receive-pack`

HTTP:
- `GET /health`
- `GET /`

## Development

```bash
bun i
bun run dev
bun test
```

## Future: Durable Objects

Each user = one Durable Object with SQLite storage:

```typescript
export class UserRepo extends DurableObject {
  sql: SqlStorage;

  async fetch(request: Request) {
    return handleGitHttpSqlite(request, url, {
      getDb: () => this.sql,
    });
  }
}
```

## Current status

- [x] Git clone/push/pull working
- [x] Unlimited branches per user
- [x] Pure SQLite storage (no git binary)
- [ ] GitHub upstream sync (coming next)
- [ ] Admin rebase all users onto new main
