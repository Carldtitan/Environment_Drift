import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Overview, type Session } from "./api.ts";
import {
  IconContract,
  IconDrift,
  IconMenu,
  IconOverview,
  IconRun,
  IconSettings,
  IconTeam,
  IconTimeline,
  Wordmark,
} from "./components/icons.tsx";
import { Loading, Notice } from "./components/primitives.tsx";
import { OverviewRoute } from "./routes/overview.tsx";
import { ContractsRoute } from "./routes/contracts.tsx";
import { RunsRoute } from "./routes/runs.tsx";
import { DriftRoute } from "./routes/drift.tsx";
import { TimelineRoute } from "./routes/timeline.tsx";
import { TeamRoute } from "./routes/team.tsx";
import { SettingsRoute } from "./routes/settings.tsx";

const ROUTES = [
  { id: "overview", label: "Overview", question: "Can this checkout be rescued now?", Icon: IconOverview },
  { id: "contracts", label: "Contracts", question: "What setup is approved for which revision?", Icon: IconContract },
  { id: "runs", label: "Rescue runs", question: "What happened on this device?", Icon: IconRun },
  { id: "drift", label: "Drift", question: "What is used here that the repository does not declare?", Icon: IconDrift },
  {
    id: "timeline",
    label: "Timeline",
    question: "What was installed here at a given moment, or at a given revision?",
    Icon: IconTimeline,
  },
  { id: "team", label: "Team", question: "Who and which devices can reach this workspace?", Icon: IconTeam },
  { id: "settings", label: "Settings", question: "Which integrations are actually active?", Icon: IconSettings },
] as const;

type RouteId = (typeof ROUTES)[number]["id"];

function currentRoute(): RouteId {
  const raw = window.location.hash.replace(/^#\/?/u, "").split("?")[0] ?? "";
  const found = ROUTES.find((route) => route.id === raw);
  return found?.id ?? "overview";
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteId>(currentRoute);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches,
  );

  useEffect(() => {
    const onHashChange = () => {
      setRoute(currentRoute());
      setDrawerOpen(false);
    };
    window.addEventListener("hashchange", onHashChange);
    const query = window.matchMedia("(max-width: 900px)");
    const onLayoutChange = (event: MediaQueryListEvent) => {
      setCompact(event.matches);
      if (!event.matches) setDrawerOpen(false);
    };
    query.addEventListener("change", onLayoutChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      query.removeEventListener("change", onLayoutChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .session()
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSession({
          authenticated: false,
          ...(error instanceof ApiError && error.loginUrl ? { loginUrl: error.loginUrl } : {}),
        });
        setSessionError(
          error instanceof ApiError
            ? error.message
            : "The control plane did not answer. Is `iwomc serve` still running?",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadOverview = useCallback(async () => {
    try {
      const value = await api.overview(projectId);
      setOverview(value);
      setOverviewError(null);
      if (projectId === null && value.selectedProjectId) setProjectId(value.selectedProjectId);
    } catch (error) {
      setOverviewError(error instanceof ApiError ? error.message : String(error));
    }
  }, [projectId]);

  useEffect(() => {
    if (!session?.authenticated) return;
    void reloadOverview();
    // Bounded polling: the console reflects device work that happens out of
    // band, and a fixed interval keeps that load predictable.
    const timer = window.setInterval(() => void reloadOverview(), 5000);
    return () => window.clearInterval(timer);
  }, [session?.authenticated, reloadOverview]);

  // Mobile drawer behaves as a modal: focus moves in, Escape closes, focus
  // returns to the trigger.
  useEffect(() => {
    if (!drawerOpen) return;
    const rail = railRef.current;
    rail?.querySelector<HTMLElement>("a, button, select")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        drawerTrigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const activeRoute = useMemo(() => ROUTES.find((entry) => entry.id === route) ?? ROUTES[0], [route]);
  const jobsInFlight = useMemo(
    () => (overview?.jobs ?? []).filter((job) => job.state === "queued" || job.state === "delivered" || job.state === "running").length,
    [overview],
  );

  if (session === null) {
    return (
      <main className="canvas">
        <div className="canvas__inner">
          <Loading label="Opening the Rescue Console" />
        </div>
      </main>
    );
  }

  if (!session.authenticated) {
    return <SignedOut detail={sessionError ?? session.detail ?? null} loginUrl={session.loginUrl ?? null} />;
  }

  return (
    <div className="shell" data-drawer={drawerOpen ? "open" : "closed"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <button
        ref={drawerTrigger}
        type="button"
        className="rail__toggle"
        aria-expanded={drawerOpen}
        aria-controls="rail"
        onClick={() => setDrawerOpen((open) => !open)}
      >
        <IconMenu />
        {activeRoute.label}
      </button>

      <nav
        id="rail"
        ref={railRef}
        className="rail"
        aria-label="Rescue Console"
        // Off-canvas and closed means genuinely unreachable, not merely
        // invisible: a closed drawer must not hold keyboard focus.
        inert={compact && !drawerOpen}
      >
        <a className="rail__mark" href="#/overview">
          <Wordmark />
          <span>
            <span className="rail__wordmark">IWOMC Rescue</span>
            <span className="rail__tagline">{session.workspace?.name ?? "workspace"}</span>
          </span>
        </a>

        <div className="rail__project">
          <label htmlFor="project-switcher">Project</label>
          <select
            id="project-switcher"
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value || null)}
          >
            {(overview?.projects ?? []).length === 0 ? (
              <option value="">No project registered yet</option>
            ) : null}
            {(overview?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="rail__nav">
          {ROUTES.map(({ id, label, Icon }) => (
            <a
              key={id}
              className="rail__link"
              href={`#/${id}`}
              aria-current={route === id ? "page" : undefined}
            >
              <Icon />
              {label}
              {id === "runs" && jobsInFlight > 0 ? (
                <span className="rail__count" aria-label={`${jobsInFlight} in flight`}>
                  {jobsInFlight}
                </span>
              ) : null}
            </a>
          ))}
        </div>

        <div className="rail__foot">
          <span className="rail__identity">{session.person?.displayName ?? session.personId}</span>
          <span>
            {session.role} ·{" "}
            {session.personId?.startsWith("local:")
              ? "local identity — sign in with GitHub to share this workspace"
              : "signed in with GitHub"}
          </span>
          {session.personId?.startsWith("local:") ? (
            <span>Local pairing works on this network; GitHub carries the source.</span>
          ) : null}
        </div>
      </nav>

      {drawerOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="Close navigation"
          onClick={() => {
            setDrawerOpen(false);
            drawerTrigger.current?.focus();
          }}
        />
      ) : null}

      <main className="canvas" id="main">
        <div className="canvas__inner">
          <header className="page-head">
            <h1>{activeRoute.label}</h1>
            {/*
              The Overview's own panel asks the question next to its answer, so
              repeating it here would say the same sentence twice. This line
              carries scope instead: which checkout the screen is about.
            */}
            <p>{route === "overview" ? scopeLine(overview) : activeRoute.question}</p>
          </header>

          {overviewError ? <Notice tone="danger">{overviewError}</Notice> : null}

          {route === "overview" ? (
            <OverviewRoute overview={overview} onChanged={reloadOverview} localDeviceId={session?.localDeviceId ?? null} />
          ) : null}
          {route === "contracts" ? (
            <ContractsRoute overview={overview} onChanged={reloadOverview} localDeviceId={session?.localDeviceId ?? null} />
          ) : null}
          {route === "runs" ? <RunsRoute overview={overview} /> : null}
          {route === "drift" ? <DriftRoute projectId={projectId} overview={overview} onChanged={reloadOverview} localDeviceId={session?.localDeviceId ?? null} /> : null}
          {route === "timeline" ? <TimelineRoute projectId={projectId} /> : null}
          {route === "team" ? <TeamRoute /> : null}
          {route === "settings" ? <SettingsRoute /> : null}
        </div>
      </main>
    </div>
  );
}

/** Which checkout this screen is about, in one operational line. */
function scopeLine(overview: Overview | null): string {
  const local = overview?.local;
  if (local?.bound && local.project) {
    return [
      local.project.projectName,
      local.project.commit.slice(0, 12),
      local.project.branch ?? "detached HEAD",
      local.project.worktreeDirty
        ? `${local.project.dirtyPathCount} uncommitted change(s)`
        : "worktree clean",
    ].join("  ·  ");
  }
  const project = overview?.projects.find((entry) => entry.id === overview.selectedProjectId);
  if (project) return `${project.name}  ·  no Companion on this host, so no local checkout state`;
  return "One project, one revision, one action.";
}

function SignedOut({ detail, loginUrl }: { detail: string | null; loginUrl: string | null }) {
  return (
    <main className="canvas" id="main">
      <div className="canvas__inner" style={{ maxWidth: 620, paddingTop: 40 }}>
        <div className="row" style={{ marginBottom: 22 }}>
          <Wordmark />
          <strong style={{ fontSize: "1.0625rem" }}>IWOMC Rescue Console</strong>
        </div>
        <div className="card">
          <h2>This browser is not signed in</h2>
          <p style={{ marginTop: 10, color: "var(--ink-600)" }}>
            {detail ??
              "The console needs a session. Every action it offers is also available from the iwomc command line."}
          </p>
          {loginUrl ? (
            <a className="btn btn--primary" href={loginUrl} style={{ display: "inline-flex", marginTop: 18 }}>
              Sign in with GitHub
            </a>
          ) : (
            <ol style={{ marginTop: 16, paddingLeft: 20, color: "var(--ink-600)" }}>
              <li>Run <code>iwomc serve</code> on the machine that holds your checkout.</li>
              <li style={{ marginTop: 6 }}>Open the one-time link it prints.</li>
            </ol>
          )}
        </div>
      </div>
    </main>
  );
}
