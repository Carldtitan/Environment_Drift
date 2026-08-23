import type { TeamContract } from "../api.ts";
import { Facts, Mono, shortDigest } from "./primitives.tsx";
import { ContractStatePill, SupportPill } from "./signal-grid.tsx";

/**
 * A contract rendered as what it is: a signed operational document bound to one
 * Git revision. Ruled machine header, a body of facts, the steps it will run in
 * order, and a signature line naming who vouched for it.
 */
export function ContractDocument({
  entry,
  action,
  compact = false,
}: {
  entry: TeamContract;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  const contract = entry.contract;
  const secrets = contract.requirements.secrets;
  const undeclared = contract.requirements.packages.filter((pkg) => !pkg.declared);

  return (
    <article className="doc">
      <header className="doc__header">
        <span className="doc__digest">{shortDigest(contract.digest)}</span>
        <span>
          revision {contract.source.commit.slice(0, 12)}
          {contract.source.branch ? ` · ${contract.source.branch}` : ""}
        </span>
        <ContractStatePill state={contract.state} />
      </header>

      <div className="doc__body">
        <Facts
          rows={[
            ["Support", <SupportPill key="s" support={contract.support} />],
            ["Proof command", <Mono key="p">{contract.proof.argv.join(" ")}</Mono>],
            [
              "Targets",
              contract.targets.map((target) => `${target.os}/${target.arch}`).join(", "),
            ],
            [
              "Runtimes",
              contract.requirements.runtimes.length === 0
                ? "none declared"
                : contract.requirements.runtimes
                    .map((runtime) => `${runtime.runtime} ${runtime.versionSpec}`)
                    .join(", "),
            ],
            [
              "Secrets",
              secrets.length === 0 ? (
                "none required"
              ) : (
                <span>
                  {secrets.map((secret) => secret.name).join(", ")}
                  <span className="hint" style={{ display: "block" }}>
                    Names only. IWOMC never carries a secret value.
                  </span>
                </span>
              ),
            ],
            ...(compact
              ? []
              : ([
                  [
                    "Declared files",
                    contract.source.declaredFileDigests.map((file) => file.path).join(", ") ||
                      "none",
                  ],
                  [
                    "Undeclared packages",
                    undeclared.length === 0
                      ? "none — the repository declares everything the capture observed"
                      : undeclared.map((pkg) => `${pkg.name}@${pkg.versionSpec}`).join(", "),
                  ],
                  ["Adapters", contract.adapters.join(", ") || "none"],
                ] as [string, React.ReactNode][])),
          ]}
        />

        {!compact && contract.steps.length > 0 ? (
          <>
            <p className="section-label" style={{ marginTop: 18 }}>
              What rescue will do, in order
            </p>
            <ol className="doc__steps">
              {contract.steps.map((step) => (
                <li key={step.id}>
                  <b>{step.kind.replace(/_/gu, " ")}</b>
                  <span>{step.description}</span>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>

      <footer className="doc__signature">
        <span>
          {contract.signature
            ? `Signed by the ${contract.signature.signer} key ${contract.signature.keyId.slice(0, 12)}`
            : "Unsigned — this contract cannot be applied"}
        </span>
        <span>
          {contract.approval
            ? `Approved by ${contract.approval.approvedBy}`
            : "No human approval recorded"}
        </span>
        {action}
      </footer>
    </article>
  );
}
