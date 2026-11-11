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
};

function fromProjectRow(row: ProjectRow): RecapProject {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    language: row.language,
    duration: row.duration,
    voice: row.voice,
    status: row.status,
    createdAt: row.created_at,
  };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export default function HomePage() {
  const [projects, setProjects] = useState<RecapProject[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured);
  const [hydrated, setHydrated] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [language, setLanguage] = useState<"Myanmar" | "English">("Myanmar");
  const [duration, setDuration] = useState<"3 min" | "5 min" | "10 min">("5 min");
  const [voice, setVoice] = useState<"Female" | "Male">("Female");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setProjects(JSON.parse(saved) as RecapProject[]);
      } catch {
        setNotice("Could not load saved projects from this browser.");
      } finally {
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
      .select("id,title,source_url,language,duration,voice,status,created_at")
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
    setFormError("");
    if (!isValidHttpUrl(sourceUrl.trim())) {
      setFormError("Enter a valid http:// or https:// video URL.");
      return;
    }

    const projectTitle = title.trim() || "Untitled movie recap";
    if (isSupabaseConfigured) {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || !user) {
        setFormError("Please sign in again before saving this project.");
        return;
      }
      const { data, error } = await supabase
        .from("projects")
        .insert({
          user_id: user.id,
          title: projectTitle,
          source_url: sourceUrl.trim(),
          language,
          duration,
          voice,
          status: "Draft",
        })
        .select("id,title,source_url,language,duration,voice,status,created_at")
        .single();
      if (error) {
        setFormError(`Could not save project: ${error.message}`);
        return;
      }
      setProjects((current) => [fromProjectRow(data as ProjectRow), ...current]);
    } else {
      const project: RecapProject = {
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        title: projectTitle,
        sourceUrl: sourceUrl.trim(),
        language,
        duration,
        voice,
        status: "Draft",
        createdAt: new Date().toISOString(),
      };
      setProjects((current) => [project, ...current]);
    }

    setTitle("");
    setSourceUrl("");
    setLanguage("Myanmar");
    setDuration("5 min");
    setVoice("Female");
    setModalOpen(false);
    setNotice(isSupabaseConfigured ? "Project saved securely to your Supabase account." : "Project saved as a local draft. Connect Supabase to sync it across devices.");
    window.setTimeout(() => setNotice(""), 5500);
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
          <button className="nav-link" onClick={() => setModalOpen(true)}><span className="nav-icon">＋</span> New project</button>
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
            <button className="primary-button" onClick={() => setModalOpen(true)}><span>＋</span> Create project</button>
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
                {projects.length === 0 && <button className="secondary-button" onClick={() => setModalOpen(true)}>Create your first project <span>→</span></button>}
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
            <div className="form-two-col"><label className="field-label">Narration language<select value={language} onChange={(event) => setLanguage(event.target.value as "Myanmar" | "English")}><option>Myanmar</option><option>English</option></select></label><label className="field-label">Recap length<select value={duration} onChange={(event) => setDuration(event.target.value as "3 min" | "5 min" | "10 min")}><option>3 min</option><option>5 min</option><option>10 min</option></select></label></div>
            <div className="field-label">Narrator voice</div><div className="voice-options"><button type="button" className={`voice-option ${voice === "Female" ? "selected" : ""}`} onClick={() => setVoice("Female")}><span className="voice-avatar">♀</span><span><strong>Female</strong><small>Warm narration</small></span><span className="radio-dot" /></button><button type="button" className={`voice-option ${voice === "Male" ? "selected" : ""}`} onClick={() => setVoice("Male")}><span className="voice-avatar male">♂</span><span><strong>Male</strong><small>Deep narration</small></span><span className="radio-dot" /></button></div>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-note"><span>ⓘ</span><p>{isSupabaseConfigured ? "This project will be saved to your private Supabase account. AI analysis and generation will be connected next." : "For this preview, the project is saved in this browser only. Connect Supabase to store projects in the cloud."}</p></div>
            <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setModalOpen(false)}>Cancel</button><button type="submit" className="primary-button">Save project <span>→</span></button></div>
          </form>
        </section>
      </div>}
    </main>
  );
}
