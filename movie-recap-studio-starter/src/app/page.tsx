"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { AuthPanel } from "@/components/auth-panel";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

type ProjectStatus = "Draft" | "Analyzing" | "Ready to edit" | "Rendering" | "Completed";
type RecapProject = {
  id: string;
  title: string;
  sourceUrl: string;
  language: "Myanmar" | "English";
  duration: "3 min" | "5 min" | "10 min";
  voice: "Female" | "Male";
  status: ProjectStatus;
  createdAt: string;
  script: string | null;
};

const STORAGE_KEY = "movie-recap-studio.projects.v1";

type ProjectRow = {
  id: string;
  title: string;
  source_url: string;
  language: "Myanmar" | "English";
  duration: "3 min" | "5 min" | "10 min";
  voice: "Female" | "Male";
  status: ProjectStatus;
  created_at: string;
  source_type: "youtube";
  script: string | null;
};

function fromProjectRow(row: ProjectRow): RecapProject {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    language: row.language,
    script: row.script ?? null,
    duration: row.duration,
    voice: row.voice,
    status: row.status,
    createdAt: row.created_at,
  };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isValidYouTubeUrl(value: string) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    if (hostname === "youtu.be") {
      return parsed.pathname.length > 1;
    }

    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      return (
        (parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"))) ||
        ["/shorts/", "/embed/", "/live/"].some(
          (prefix) => parsed.pathname.startsWith(prefix) && parsed.pathname.length > prefix.length
        )
      );
    }

    return false;
  } catch {
    return false;
  }
}

export default function HomePage() {
  const [projects, setProjects] = useState<RecapProject[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [language, setLanguage] = useState<"Myanmar" | "English">("Myanmar");
  const [duration, setDuration] = useState<"3 min" | "5 min" | "10 min">("5 min");
  const [recapType, setRecapType] = useState<"review" | "full_recap">("full_recap");
  const [voice, setVoice] = useState<"Female" | "Male">("Female");
  const [formError, setFormError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedScript, setGeneratedScript] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setProjects(JSON.parse(saved) as RecapProject[]);
      } catch {
        setNotice("Could not load saved projects from this browser.");
      } finally {
        setAuthLoading(false);
        setHydrated(true);
      }
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setAuthLoading(false);
      setHydrated(true);
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) setNotice(`Authentication check failed: ${error.message}`);
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
      return;
    }
    if (authLoading) return;
    if (!user) {
      setProjects([]);
      setHydrated(true);
      return;
    }

    let active = true;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setHydrated(false);

    void supabase
      .from("projects")
      .select("id,title,source_url,source_type,language,duration,voice,status,created_at,script")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setNotice(`Could not load cloud projects: ${error.message}`);
          setProjects([]);
        } else {
          setProjects(((data ?? []) as ProjectRow[]).map(fromProjectRow));
        }
        setHydrated(true);
      });

    return () => { active = false; };
  }, [user, authLoading]);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => `${project.title} ${project.sourceUrl} ${project.language}`.toLowerCase().includes(query));
  }, [projects, search]);

  const completedCount = projects.filter((project) => project.status === "Completed").length;
  const inProgressCount = projects.filter((project) => project.status === "Analyzing" || project.status === "Rendering").length;

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isGenerating) return;

    setFormError("");
    setGeneratedScript("");

    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const generateAfterSave = submitter?.value === "generate";

    if (!isValidYouTubeUrl(sourceUrl.trim())) {
      setFormError("Enter a valid YouTube video URL.");
      return;
    }

    const projectTitle = title.trim() || "Untitled movie recap";
    const supabase = getSupabaseBrowserClient();

    if (isSupabaseConfigured && (!supabase || !user)) {
      setFormError("Please sign in again before saving this project.");
      return;
    }

    let savedProject: RecapProject | null = null;

    try {
      if (generateAfterSave) setIsGenerating(true);

      // Save the project once. Generating is a separate, explicitly paid action.
      if (isSupabaseConfigured && supabase && user) {
        const { data, error } = await supabase
          .from("projects")
          .insert({
            user_id: user.id,
            title: projectTitle,
            source_type: "youtube",
            source_url: sourceUrl.trim(),
            storage_path: null,
            language,
            duration,
            voice,
            status: generateAfterSave ? "Analyzing" : "Draft",
            script: null,
          })
          .select(
            "id,title,source_url,source_type,language,duration,voice,status,created_at,script"
          )
          .single();

        if (error) {
          throw new Error("Could not save project: " + error.message);
        }

        savedProject = fromProjectRow(data as ProjectRow);
      } else {
        savedProject = {
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : String(Date.now()),
          title: projectTitle,
          sourceUrl: sourceUrl.trim(),
          language,
          duration,
          voice,
          status: generateAfterSave ? "Analyzing" : "Draft",
          createdAt: new Date().toISOString(),
          script: null,
        };
      }

      setProjects((current) => [savedProject as RecapProject, ...current]);

      if (!generateAfterSave) {
        setTitle("");
        setSourceUrl("");
        setLanguage("Myanmar");
        setDuration("5 min");
        setVoice("Female");
        setModalOpen(false);
        setNotice(
          isSupabaseConfigured
            ? "Project saved securely. Saving a project does not call the AI or incur model usage."
            : "Project saved as a local draft."
        );
        window.setTimeout(() => setNotice(""), 5500);
        return;
      }

      setNotice("Analyzing the YouTube video and generating your recap script...");

      let accessToken: string | null = null;
      if (isSupabaseConfigured && supabase) {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.getSession();
        if (sessionError) throw new Error(sessionError.message);
        accessToken = sessionData.session?.access_token ?? null;
      }

      if (!accessToken) {
        throw new Error("Sign in to your Supabase account before generating a paid AI recap.");
      }

      const response = await fetch("/api/generate-recap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken,
        },
        body: JSON.stringify({
          title: projectTitle,
          videoUrl: sourceUrl.trim(),
          language,
          duration,
          recapType,
        }),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok || !result?.success || typeof result.script !== "string") {
        throw new Error(
          result?.error || "AI generation failed (" + response.status + ")."
        );
      }

      const script = result.script.trim();
      if (!script) throw new Error("The AI returned an empty recap script.");

      // Save the completed script so reopening the project does not require another paid call.
      if (isSupabaseConfigured && supabase && user) {
        const { error: updateError } = await supabase
          .from("projects")
          .update({
            script,
            status: "Ready to edit",
          })
          .eq("id", savedProject.id)
          .eq("user_id", user.id);

        if (updateError) {
          throw new Error(
            "Script was generated but could not be saved: " + updateError.message
          );
        }
      }

      setGeneratedScript(script);
      setProjects((current) =>
        current.map((project) =>
          project.id === savedProject?.id
            ? { ...project, script, status: "Ready to edit" }
            : project
        )
      );

      const actualCost =
        typeof result.usageCost === "number"
          ? " Estimated provider usage: $" + result.usageCost.toFixed(6) + "."
          : "";

      setNotice("Recap script generated and saved." + actualCost);
      window.setTimeout(() => setNotice(""), 7000);
    } catch (caught) {
      if (savedProject) {
        if (isSupabaseConfigured && supabase && user) {
          await supabase
            .from("projects")
            .update({ status: "Draft" })
            .eq("id", savedProject.id)
            .eq("user_id", user.id);
        }

        setProjects((current) =>
          current.map((project) =>
            project.id === savedProject?.id
              ? { ...project, status: "Draft" }
              : project
          )
        );
      }

      setFormError(
        caught instanceof Error ? caught.message : "Something went wrong."
      );
      setNotice("");
    } finally {
      setIsGenerating(false);
    }
  }

  async function deleteProject(id: string) {
    if (isSupabaseConfigured) {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { error } = await supabase.from("projects").delete().eq("id", id);
      if (error) {
        setNotice(`Could not delete project: ${error.message}`);
        return;
      }
    }
    setProjects((current) => current.filter((project) => project.id !== id));
  }

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setNotice(`Could not sign out: ${error.message}`);
  }

  if (authLoading) {
    return <main className="auth-shell"><section className="auth-card"><div className="loader" /><p className="auth-subtitle">Connecting to your workspace…</p></section></main>;
  }
  if (isSupabaseConfigured && !user) return <AuthPanel />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Movie Recap Studio home">
          <span className="brand-mark">M</span>
          <span className="brand-copy"><strong>movie recap</strong><small>STUDIO</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-link active" href="#home"><span className="nav-icon">▦</span> Overview</a>
          <button className="nav-link" onClick={() => { setGeneratedScript(""); setFormError(""); setModalOpen(true); }}><span className="nav-icon">＋</span> New project</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-orb">✦</span>
            <strong>Your creative workspace</strong>
            <p>Turn a permitted video source into a narrated recap.</p>
          </div>
          <div className="profile-row">
            <div className="avatar">O</div>
            <div className="profile-copy"><strong>My workspace</strong><small>Local preview</small></div>
            <span className="more-dots">···</span>
          </div>
        </div>
      </aside>

      <section className="main-panel" id="home">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Overview</div>
          <div className="topbar-right"><span className="status-dot" /> {isSupabaseConfigured ? "Cloud workspace" : "Local development"} <span className="top-avatar">{user?.email?.[0]?.toUpperCase() || "O"}</span></div>
        </header>

        <div className="page-content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR AI VIDEO WORKSPACE</div>
              <h1>Make every story <em>worth sharing.</em></h1>
              <p className="page-subtitle">Create clear, engaging movie recaps with narration and subtitles.</p>
            </div>
            <button className="primary-button" onClick={() => { setGeneratedScript(""); setFormError(""); setModalOpen(true); }}><span>＋</span> Create project</button>
          </div>

          <div className="prototype-notice"><span className="notice-icon">ⓘ</span><span><strong>Foundation build</strong> — {isSupabaseConfigured ? "Your projects are saved in your private Supabase account." : "Draft projects are saved in this browser only. Configure Supabase to sync them across devices."} AI analysis, voice generation and video rendering are next.</span></div>

          <div className="stats-grid">
            <article className="stat-card"><div className="stat-top"><span>Total projects</span><span className="stat-icon purple">▦</span></div><div className="stat-number">{hydrated ? projects.length : "—"}</div><div className="stat-foot">In this browser workspace</div></article>
            <article className="stat-card"><div className="stat-top"><span>In progress</span><span className="stat-icon orange">◷</span></div><div className="stat-number">{hydrated ? inProgressCount : "—"}</div><div className="stat-foot">Analysis or rendering</div></article>
            <article className="stat-card"><div className="stat-top"><span>Completed</span><span className="stat-icon green">✓</span></div><div className="stat-number">{hydrated ? completedCount : "—"}</div><div className="stat-foot">Ready to download</div></article>
          </div>

          <section className="projects-section">
            <div className="section-heading"><div><h2>Recent projects</h2><p>Your latest recap projects in one place.</p></div><div className="project-tools"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" /></label><button className="filter-button" onClick={() => setSearch("")} title="Clear search">↺</button></div></div>

            {!hydrated ? <div className="empty-state"><div className="loader"/><p>Loading your workspace…</p></div> : filteredProjects.length === 0 ? (
              <div className="empty-state">
                <div className="empty-art"><span className="art-spark">✦</span><span className="art-play">▶</span><span className="art-line" /></div>
                <h3>{projects.length === 0 ? "Your first recap starts here" : "No matching projects"}</h3>
                <p>{projects.length === 0 ? "Add a video link to create your first movie recap project." : "Try another title or clear your search."}</p>
                {projects.length === 0 && <button className="secondary-button" onClick={() => { setGeneratedScript(""); setFormError(""); setModalOpen(true); }}>Create your first project <span>→</span></button>}
                {projects.length > 0 && <button className="secondary-button" onClick={() => setSearch("")}>Clear search</button>}
              </div>
            ) : (
              <div className="project-list">
                {filteredProjects.map((project) => (
                  <article className="project-card" key={project.id}>
                    <div className="project-thumb"><span className="thumb-play">▶</span><span className="thumb-label">VIDEO SOURCE</span></div>
                    <div className="project-info"><h3>{project.title}</h3><a href={project.sourceUrl} target="_blank" rel="noreferrer">{project.sourceUrl}</a><div className="project-meta"><span>{project.language}</span><i /> <span>{project.duration}</span><i /> <span>{project.voice} voice</span></div></div>
                    <div className="project-right"><span className={`status-pill ${project.status.toLowerCase().replaceAll(" ", "-")}`}>{project.status}</span><small>{formatDate(project.createdAt)}</small><button className="delete-button" onClick={() => deleteProject(project.id)} aria-label={`Delete ${project.title}`}>Delete</button></div>
                  </article>
                ))}
              </div>
            )}
          </section>
          <footer className="app-footer"><span>Movie Recap Studio <b>·</b> Foundation 0.2</span><span>Built for original, licensed or otherwise authorized source media.</span></footer>
        </div>
      </section>

      {notice && <div className="toast" role="status"><span>✓</span>{notice}<button onClick={() => setNotice("")}>×</button></div>}

      {modalOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <div className="modal-heading"><div><div className="eyebrow">NEW WORKSPACE PROJECT</div><h2 id="create-title">Start a new recap</h2><p>Add a video source and choose your narration settings.</p></div><button className="close-button" onClick={() => setModalOpen(false)} aria-label="Close">×</button></div>
          <form onSubmit={createProject} className="project-form">
            <label className="field-label">Project name <span>Optional</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. The hidden truth behind…" maxLength={90} /></label>
            <label className="field-label">Video URL <span>Required</span><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." type="url" required /></label>
            <div className="form-two-col"><label className="field-label">Recap style<select value={recapType} onChange={(event) => setRecapType(event.target.value as "review" | "full_recap")}><option value="review">Movie Review / Commentary</option><option value="full_recap">Full Movie Recap</option></select></label><label className="field-label">Narration language<select value={language} onChange={(event) => setLanguage(event.target.value as "Myanmar" | "English")}><option>Myanmar</option><option>English</option></select></label></div>
            <label className="field-label">Recap length<select value={duration} onChange={(event) => setDuration(event.target.value as "3 min" | "5 min" | "10 min")}><option>3 min</option><option>5 min</option><option>10 min</option></select></label>
            <div className="field-label">Narrator voice</div><div className="voice-options"><button type="button" className={`voice-option ${voice === "Female" ? "selected" : ""}`} onClick={() => setVoice("Female")}><span className="voice-avatar">♀</span><span><strong>Female</strong><small>Warm narration</small></span><span className="radio-dot" /></button><button type="button" className={`voice-option ${voice === "Male" ? "selected" : ""}`} onClick={() => setVoice("Male")}><span className="voice-avatar male">♂</span><span><strong>Male</strong><small>Deep narration</small></span><span className="radio-dot" /></button></div>
            {isGenerating && (
              <p className="modal-note" role="status">
                AI is analyzing the YouTube video. Keep this window open; do not submit again.
              </p>
            )}
            {generatedScript && (
              <section
                aria-live="polite"
                style={{
                  border: "1px solid #e7e7ed",
                  borderRadius: 9,
                  padding: 13,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                <h3 style={{ fontSize: 12, margin: "0 0 9px" }}>{recapType === "review" ? "Generated review / commentary script" : "Generated full movie recap script"}</h3>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    fontFamily: "inherit",
                    fontSize: 11,
                    lineHeight: 1.7,
                    margin: 0,
                  }}
                >
                  {generatedScript}
                </pre>
              </section>
            )}
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-note"><span>ⓘ</span><p>Save Project is free and only stores the YouTube link. Generate Recap Script sends the public video URL to Gemini's YouTube URL preview, which Google currently lists as no-charge. Free-tier rate limits and regional availability apply. Use media you own or are authorized to process.</p></div>
            <div className="modal-actions">
              <button type="button" className="cancel-button" onClick={() => setModalOpen(false)}>Close</button>
              <button type="submit" name="action" value="save" className="secondary-button" disabled={isGenerating}>
                Save Project
              </button>
              <button type="submit" name="action" value="generate" className="primary-button" disabled={isGenerating}>
                {isGenerating ? "Analyzing..." : "Generate Recap Script →"}
              </button>
            </div>
          </form>
        </section>
      </div>}
    </main>
  );
}
