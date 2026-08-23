# Writing an ecosystem adapter

An adapter teaches IWOMC one ecosystem. The protocol lives in
`packages/adapters/src/types.ts`; `npm.ts` and `python.ts` are the reference
implementations.

## The rule that shapes everything

> An adapter never runs an executable command merely because a repository
> contains a file with a familiar name.

Detection, declared-state reading, and inventory are **filesystem reads**. A
command runs only for a step the adapter itself compiled, from a contract a
human or a policy approved.

## The protocol

```ts
interface EnvironmentAdapter {
  manifest: AdapterManifest;

  detect(files): Detection;                     // file-shaped only
  readDeclaredState(ctx): DeclaredState;        // manifests, lockfiles, pins
  inventory(ctx): InventoryResult;              // what is installed, no commands
  observeProcess(process): ObservedEffect[];    // a package manager that ran
  deriveObservedEffects(ctx): ObservedEffect[]; // what the filesystem alone proves
  compile(bundle): ContractFragment | Unsupported;
  preflight(ctx, steps): PreflightResult;
  planCommand(step, ctx): CommandPlan | null;   // one step -> one bounded argv
  verifyAfterMaterialize(ctx): AdapterVerification;
  proposeRepair(bundle, finding, pending): ProposedFileChange[];
}
```

### `detect`

Return `detected: false` when another manager clearly owns the project — npm
stands down when it sees a `pnpm-lock.yaml`, pip stands down when it sees a
`uv.lock`. Say why in `note`; the UI shows it verbatim.

### `inventory` and `deriveObservedEffects`

Inventory reads what is installed project-locally. `deriveObservedEffects` is
where the useful signal comes from: a package that is installed, is not
declared, and is required by no declared package was installed here directly.
That reachability check is what stops an ordinary transitive dependency from
being mistaken for something an agent added.

### `compile`

Turn evidence into typed steps. The available kinds are:

`ensure_runtime` · `ensure_system_tool` · `create_virtual_environment` ·
`install_project_dependencies` · `apply_package_overlay` ·
`write_project_local_file` · `run_reviewed_recipe`

There is no free-form shell step. If your ecosystem needs one, it is a
`run_reviewed_recipe`: argv only, with a working directory, an environment
allowlist, a timeout, expected exit codes, and a review that binds a reviewer to
the exact command digest.

Return `Unsupported` rather than guessing. `observe_only` is a legitimate and
useful answer; a fabricated setup is not.

### `planCommand`

One step becomes one argv array. Two rules:

- **Never modify a tracked file.** npm's overlay uses `--no-save`; uv's uses
  `uv pip install`, which leaves `pyproject.toml` and `uv.lock` alone.
- **Prefer the frozen form.** `npm ci` over `npm install`, `uv sync --frozen`
  over `uv sync`. A rescue reproduces; it does not resolve.

### `proposeRepair`

Given a drift finding, return the repository change that would remove it, as a
before/after pair. The `pending` map carries content earlier findings already
proposed for the same file, so several repairs compose into one coherent diff
instead of overwriting each other.

## Claiming support honestly

`manifest.support` may be `native` only when every capability is implemented
*and* `conformanceTested` is true, backed by a test that proves the whole loop
on a project created at test time. `pnpm run capability-matrix` regenerates the
published matrix from this metadata and fails if a claim outruns the code.

Register the adapter in `defaultRegistry()` and add a row to `ECOSYSTEM_PROBES`.
Recognition and support are separate fields, deliberately.

## Machine-wide managers stay observe-only

Homebrew, apt, Chocolatey, winget, Conda, asdf, mise, Volta, and SDKMAN change
state outside the project. IWOMC reports what a project needs from them and
blocks with that name when it is missing. Making one of them `native` would
break the promise that a rescue cannot alter a machine outside its checkout.

## Testing an adapter

Unit-test detection, parsing, and command planning with the in-memory
`ProjectFiles` view — no disk, no processes. Then add a conformance test that
uses `@iwomc/testkit` to create a project at test time and runs the full
capture → verify → rescue loop against it. Only that second test earns
`conformanceTested: true`.
