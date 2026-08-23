# Why the existing IWOMC checkout cannot install

This records the diagnosis of the dependency-install failure in the sibling
`IWOMC/` directory, and why the new implementation lives in `src/` rather than
being grafted onto it. No file in `IWOMC/` was modified, and no lockfile was
deleted.

## Reproduction

```
$ cd IWOMC
$ pnpm install --frozen-lockfile
...
ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/miniREDACTED/-/miniREDACTED-7.1.3.tgz: Not Found
```

## Cause

The checkout is a **redaction-scrubbed copy**, not a working repository. A
secret-scrubbing pass ran over it and replaced a set of words with the literal
string `REDACTED`, everywhere, including inside identifiers, filenames, SQL, and
the lockfile.

The failing package makes the mechanism unambiguous: `minipass@7.1.3` is a real,
extremely common transitive dependency. In `pnpm-lock.yaml` it appears as
`miniREDACTED@7.1.3`, so pnpm asks the registry for a package that does not
exist and gets a 404.

The scrubber replaced more than one word. Each of these is a distinct token
collapsed to the same placeholder:

| Evidence in the tree | The word it replaced |
| --- | --- |
| `miniREDACTED-7.1.3.tgz` | `pass` |
| `@aws-sdk/REDACTED-provider-env` | `credential` |
| `"REDACTEDs such as CLOUDFLARE_API_TOKEN"` | `secret` |
| `github_REDACTED_REDACTEDs_REDACTED_id_REDACTEDs_id_fk` | `user` and `secret` |
| `const REDACTEDId = options.REDACTEDId ?? currentUserId()` | `user` |

Because several different words became the same placeholder, the transformation
is **lossy**. Nothing in the tree records which word each `REDACTED` was, so it
cannot be reversed by any rule.

### Second effect: quarantined filenames

The same pass renamed 34 files, appending a twelve-hex-character suffix:

```
packages/REDACTED/package.json-b9e7cee933a0
packages/REDACTED/src/index.ts-9feb35ace2aa
crates/companion/src/REDACTEDs.rs-f30112b81faa
apps/worker/src/github/REDACTED.ts-bc889b0b3c0e
...
```

`packages/REDACTED/package.json` therefore does not exist, so the pnpm workspace
cannot resolve the `@environment-REDACTED/REDACTED` links its lockfile declares —
a second, independent reason the install cannot complete.

## Scope of the damage

- `pnpm-lock.yaml`: 121 lines contain `REDACTED`, including package names for
  `minipass` and the `@aws-sdk/credential-provider-*` family.
- Source: identifiers, type names, and string literals across the worker, the
  extension, the Rust companion, and one whole workspace package.
- `packages/db/migrations/*.sql`: table names, column names, and foreign-key
  constraint names.
- 34 files renamed out of the paths that reference them.

## Why it was not repaired

Repair would mean guessing which of at least five words each occurrence was, in
identifiers, table names, filenames, and package names, with no ground truth in
the tree. A wrong guess in a migration file or a lockfile is worse than the
current visible failure: it produces a repository that installs and then
misbehaves.

The constraints were also explicit: do not delete lockfiles, do not replace the
stack, and do not work around the problem. Reconstructing the lockfile by hand
would violate the first; regenerating it would violate it too.

## What was done instead

The new implementation is a self-contained workspace in `src/`, built to the
same specification, with the parts of the old tree that survived redaction used
as design reference:

- the npm and Python declaration/inventory logic in `packages/adapters` informed
  the new native adapters;
- the workspace, membership, device, and audit shapes informed the control
  plane;
- the old static dashboard is what the Rescue Console replaces.

## To repair the original

Whoever holds the pre-redaction copy can restore it directly. Failing that, the
recoverable order is:

1. Restore file names by stripping the twelve-hex suffixes.
2. Recover `pnpm-lock.yaml` from a pre-redaction commit, or regenerate it from
   the manifests once package names are correct.
3. Recover source identifiers from a pre-redaction commit. There is no
   mechanical path for this step.

None of that is required to run what is in `src/`, which has its own lockfile
and no dependency on the old tree.
