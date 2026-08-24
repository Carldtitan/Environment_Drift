# Running a workspace

## Start the control plane

```bash
iwomc serve
```

This starts the API and the Rescue Console, enrolls this device, and prints a
link carrying a one-time session token. Treat the link like a password.

## Same-Wi-Fi team use

GitHub distributes the source; IWOMC distributes the verified environment
contract. For an in-person team, run the control plane on the owner's laptop
and give it a reachable LAN URL:

```bash
iwomc serve --host 0.0.0.0 --port 4319 --public-url http://192.168.1.42:4319
```

Replace the example address with the owner's actual LAN address. The explicit
public URL prevents invitations from incorrectly containing `0.0.0.0`. Share
only the generated invitation command, never the owner's one-time console URL.
For teams on different networks, use a deliberately deployed HTTPS control
plane; do not expose the local SQLite server directly to the public internet.

Without a GitHub App configured, the workspace is owned by this device's local
owner identity, and the console labels it plainly as a local identity. Once a
GitHub App is configured, `iwomc login` signs people in with their immutable
GitHub numeric id instead — never a mutable login name.

## Roles

| Role | Can |
| --- | --- |
| `owner` | everything, including changing roles and inviting owners |
| `maintainer` | invite, revoke devices and invitations, review recipes |
| `developer` | bind projects, publish receipts and contracts, run rescues |
| `reviewer` | read everything, including the audit log |
| `observer` | read workspace records |

A workspace always keeps at least one owner; the last one cannot be downgraded
or removed.

## Invite a teammate

From the console's Team screen, or:

```
POST /api/invitations   { "role": "developer" }
```

The response contains the raw token exactly once, as a ready-to-paste command:

```
iwomc join <token> --url http://your-control-plane
```

Only the token's hash is stored, so it can never be shown again. Invitations are
single-use and expire after seven days, and acceptance is atomic — two people
racing the same link cannot both join.

After accepting the invite, the teammate runs this from their IWOMC checkout:

```bash
iwomc init --dir /path/to/their/project --proof "<project proof command>"
iwomc agent
```

`agent` is the device-side half of the team feature. It makes an outbound
connection to the shared control plane, registers only that pre-bound checkout,
and receives signed dashboard jobs. It never lets the browser name a local path.

## Devices

A device enrolls by redeeming an invitation. It generates an Ed25519 keypair
locally; the private key never leaves that machine. The control plane stores the
public key and a revocable credential.

Revoking a device takes effect immediately: its next API call is refused, and it
can no longer download contracts, upload receipts, or receive jobs. Removing a
person revokes their devices at the same time.

## Asking a device to do something

The console never touches a filesystem. A request becomes a signed, expiring job
carrying workspace id, project id, action, contract id, and an expiry — and no
path. The device validates the signature, maps the project id to a checkout it
already registered, and refuses if it has none.

An offline device produces no job progress and no optimistic success. The job
expires, and the console says so.

## Contracts in a team

A device publishes a contract it signed. The control plane verifies that
signature against the publishing device's key, refuses a capture from a dirty
worktree, refuses an observe-only contract, and then re-signs the contract with
the service key as the shareable baseline.

When a device asks for a contract for a revision, the strongest verified one
wins: `clean_verified`, then `locally_checked`, then `approved`.

Feature branches may have their own contracts. There is no automatic merging of
competing contracts; a conflict stays an explicit review item.

## Audit

Every capture, contract publication, verification, rescue, promotion, device
enrolment, invitation, and revocation writes an immutable audit event. Events are
hash-chained: each carries the digest of the one before it, so a rewritten or
deleted event is detectable. The Settings screen shows the chain's state and the
most recent events.

## Durable storage

By default the control plane uses a local SQLite store, which needs no
credentials. Setting `IWOMC_DATABASE_URL` selects Postgres; if that database is
not reachable, the control plane refuses to start rather than quietly writing
somewhere else.

## When several people capture the same revision

This is normal on a team and IWOMC does not treat it as a conflict.

**Which contract gets applied.** Not the newest — the one with the most
evidence behind it, and only if it can run on the machine asking. In order:
verified on a clean machine, then checked locally, then approved, then an
unexamined candidate. Recency breaks ties. A contract someone rejected,
revoked, or superseded is never chosen for you; it can still be applied by
name, and you will be told why it was withheld.

This matters more than it sounds. Without it, someone running `iwomc capture`
on the machine that is *broken* produces a fresh candidate that outranks the
contract the team actually verified.

**Mixed operating systems.** A contract records the platform it was captured
on. If teammates have covered a revision on macOS and you are on Windows,
IWOMC says exactly that and names the platforms covered, rather than reporting
that no contract exists — which would send you asking for work already done.
Someone on your platform needs to capture it.

**Where machines disagree.** With two or more comparable captures of one
revision, `iwomc status` and the Contracts screen show where they differ: a
package one person has and nobody else does, or a version two people disagree
about. This is the earliest warning a team gets that its machines have drifted
apart, and it arrives before anyone's checkout breaks.

Only captures for the same platform are compared; a difference between
operating systems is expected, not suspicious, and the platforms left out are
named. IWOMC reports the disagreement and does not decide who is right.

Nothing is shown at all when fewer than two captures are comparable. "Nothing
to compare" and "compared and agreed" are different facts.

## Where work actually runs

Asking the console to verify a contract or repair a checkout sends a job to a
device. On a team of ten that choice matters: "the first active device" means
whichever teammate's laptop happens to sort first, and a job sent to a machine
nobody has switched on for months sits queued until it expires, with no
obvious reason why.

IWOMC picks the machine this console belongs to, when there is one. Failing
that, the device seen most recently — the one most likely to still be there.
The Overview screen lets you choose explicitly, and every request names the
device it went to.

Devices poll for work every few seconds while anything is happening, and back
off to every fifteen once a minute has passed with nothing to do. A team of ten
therefore idles quietly instead of asking the same question, from twenty
machines, all day. Any job resets the pace immediately.

Work that is never collected is closed out rather than left pending forever: a
device that is asleep, revoked, or retired leaves jobs queued, and those are
marked expired once their deadline passes.
