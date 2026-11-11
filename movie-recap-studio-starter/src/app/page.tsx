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
  voiceoverPath: string | null;
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
  voiceover_path: string | null;
};

function fromProjectRow(row: ProjectRow): RecapProject {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    language: row.language,
    script: row.script ?? null,
    voiceoverPath: row.voiceover_path ?? null,
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
  const [selectedProject, setSelectedProject] = useState<RecapProject | null>(null);
  const [voiceoverUrl, setVoiceoverUrl] = useState("");
  const [isGeneratingVoiceover, setIsGeneratingVoiceover] = useState(false);

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
      .select("id,title,source_url,source_type,language,duration,voice,status,created_at,script,voiceover_path")
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
    if (isGenerating || isGeneratingVoiceover) return;

    setVoiceoverUrl("");
    setFormError("");
    setGeneratedScript("");

    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const generateAfterSave = submitter?.value === "generate";

    if (selectedProject) {
      if (!isValidYouTubeUrl(sourceUrl.trim())) {
        setFormError("Enter a valid YouTube video URL.");
        return;
      }

      const updatedProject: RecapProject = {
        ...selectedProject,
        title: title.trim() || "Untitled movie recap",
        sourceUrl: sourceUrl.trim(),
        language,
        duration,
        voice,
      };

      if (generateAfterSave) {
        await generateScriptForProject(updatedProject);
        return;
      }

      const supabase = getSupabaseBrowserClient();
      if (isSupabaseConfigured && (!supabase || !user)) {
        setFormError("Please sign in again before saving this project.");
        return;
      }

      if (isSupabaseConfigured && supabase && user) {
        const { error } = await supabase
          .from("projects")
          .update({
            title: updatedProject.title,
            source_url: updatedProject.sourceUrl,
            language: updatedProject.language,
            duration: updatedProject.duration,
            voice: updatedProject.voice,
          })
          .eq("id", updatedProject.id)
          .eq("user_id", user.id);

        if (error) {
          setFormError("Could not update project: " + error.message);
          return;
        }
      }

      setProjects((current) =>
        current.map((project) => project.id === updatedProject.id ? updatedProject : project)
      );
      setSelectedProject(updatedProject);
      setGeneratedScript(updatedProject.script ?? "");
      setModalOpen(false);
      setNotice("Project changes saved. No AI generation was performed.");
      window.setTimeout(() => setNotice(""), 5500);
      return;
    }

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
          voiceoverPath: null,
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
      const scriptedProject = { ...savedProject, script, status: "Ready to edit" as ProjectStatus };
      setSelectedProject(scriptedProject);
      setProjects((current) =>
        current.map((project) =>
          project.id === savedProject?.id ? scriptedProject : project
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

  async function generateScriptForProject(project: RecapProject) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !user) {
      setFormError("Please sign in again before generating a recap script.");
      return;
    }

    setIsGenerating(true);
    setFormError("");
    setNotice("Analyzing the saved YouTube project and generating your recap script...");

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error(sessionError.message);
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Your session expired. Please sign in again.");

      const response = await fetch("/api/generate-recap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken,
        },
        body: JSON.stringify({
          title: project.title,
          videoUrl: project.sourceUrl,
          language: project.language,
          duration: project.duration,
        }),
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || typeof result.script !== "string") {
        throw new Error(result?.error || "AI generation failed (" + response.status + ").");
      }

      const script = result.script.trim();
      if (!script) throw new Error("The AI returned an empty recap script.");

      const { error: updateError } = await supabase
        .from("projects")
        .update({ script, status: "Ready to edit" })
        .eq("id", project.id)
        .eq("user_id", user.id);

      if (updateError) {
        throw new Error("Script was generated but could not be saved: " + updateError.message);
      }

      const completedProject = { ...project, script, status: "Ready to edit" as ProjectStatus };
      setProjects((current) =>
        current.map((item) => item.id === project.id ? completedProject : item)
      );
      setSelectedProject(completedProject);
      setGeneratedScript(script);
      setNotice("Recap script generated and saved to this project.");
      window.setTimeout(() => setNotice(""), 7000);
    } catch (caught) {
      setNotice("");
      setFormError(caught instanceof Error ? caught.message : "Could not generate the recap script.");
    } finally {
      setIsGenerating(false);
    }
  }

  function openProject(project: RecapProject) {
    setSelectedProject(project);
    setTitle(project.title);
    setSourceUrl(project.sourceUrl);
    setLanguage(project.language);
    setDuration(project.duration);
    setVoice(project.voice);
    setGeneratedScript(project.script ?? "");
    setVoiceoverUrl("");
    setFormError("");
    if (project.voiceoverPath) {
      void (async () => {
        const supabase = getSupabaseBrowserClient();
        const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
        const token = data.session?.access_token;
        if (!token) return;
        const response = await fetch("/api/generate-voiceover?projectId=" + encodeURIComponent(project.id), {
          headers: { Authorization: "Bearer " + token },
        });
        const result = await response.json().catch(() => null);
        if (response.ok && result?.success && typeof result.signedUrl === "string") setVoiceoverUrl(result.signedUrl);
      })();
    }
    setModalOpen(true);
  }


  async function generateVoiceover() {
    if (!selectedProject || !generatedScript.trim() || isGeneratingVoiceover) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !user) {
      setFormError("Sign in before generating a voiceover.");
      return;
    }
    setIsGeneratingVoiceover(true);
    setFormError("");
    setVoiceoverUrl("");
    setNotice("Generating Burmese voiceover with MyanmarTTS. The free CPU service may take a few minutes; please do not click again.");
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error(sessionError.message);
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session expired. Please sign in again.");
      const response = await fetch("/api/generate-voiceover", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ projectId: selectedProject.id }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || typeof result.signedUrl !== "string") {
        throw new Error(result?.error || "Voiceover generation failed (" + response.status + ").");
      }
      setVoiceoverUrl(result.signedUrl);
      const updated = { ...selectedProject, voiceoverPath: result.voiceoverPath };
      setSelectedProject(updated);
      setProjects((current) => current.map((p) => p.id === updated.id ? updated : p));
      setNotice("Voiceover generated and saved privately. Open the audio player below to preview.");
      window.setTimeout(() => setNotice(""), 7000);
    } catch (error) {
      setNotice("");
      setFormError(error instanceof Error ? error.message : "Could not generate voiceover.");
    } finally {
      setIsGeneratingVoiceover(false);
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
          <button className="nav-link" onClick={() => { setSelectedProject(null); setTitle(""); setSourceUrl(""); setLanguage("Myanmar"); setDuration("5 min"); setVoice("Female"); setGeneratedScript(""); setFormError(""); setModalOpen(true); }}><span className="nav-icon">＋</span> New project</button>
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
            <button className="primary-button" onClick={() => { setSelectedProject(null); setTitle(""); setSourceUrl(""); setLanguage("Myanmar"); setDuration("5 min"); setVoice("Female"); setGeneratedScript(""); setFormError(""); setModalOpen(true); }}><span>＋</span> Create project</button>
          </div>

          <div className="prototype-notice"><span className="notice-icon">ⓘ</span><span><strong>Foundation build</strong> — {isSupabaseConfigured ? "Your projects are saved in your private Supabase account." : "Draft projects are saved in this browser only. Configure Supabase to sync them across devices."} Voiceover generation is available for saved scripts; subtitles and video rendering are next.</span></div>

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
                {projects.length === 0 && <button className="secondary-button" onClick={() => { setSelectedProject(null); setTitle(""); setSourceUrl(""); setLanguage("Myanmar"); setDuration("5 min"); setVoice("Female"); setGeneratedScript(""); setFormError(""); setModalOpen(true); }}>Create your first project <span>→</span></button>}
                {projects.length > 0 && <button className="secondary-button" onClick={() => setSearch("")}>Clear search</button>}
              </div>
            ) : (
              <div className="project-list">
                {filteredProjects.map((project) => (
                  <article className="project-card" key={project.id}>
                    <div className="project-thumb"><span className="thumb-play">▶</span><span className="thumb-label">VIDEO SOURCE</span></div>
                    <div className="project-info"><h3>{project.title}</h3><a href={project.sourceUrl} target="_blank" rel="noreferrer">{project.sourceUrl}</a><div className="project-meta"><span>{project.language}</span><i /> <span>{project.duration}</span><i /> <span>{project.voice} voice</span></div></div>
                    <div className="project-right"><span className={`status-pill ${project.status.toLowerCase().replaceAll(" ", "-")}`}>{project.status}</span><small>{formatDate(project.createdAt)}</small><button className="secondary-button" onClick={() => openProject(project)}>Open project</button><button className="delete-button" onClick={() => deleteProject(project.id)} aria-label={`Delete ${project.title}`}>Delete</button></div>
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
          <div className="modal-heading"><div><div className="eyebrow">{selectedProject ? "SAVED WORKSPACE PROJECT" : "NEW WORKSPACE PROJECT"}</div><h2 id="create-title">{selectedProject ? selectedProject.title : "Start a new recap"}</h2><p>{selectedProject ? "Review the saved settings and script, or generate a script for this project." : "Add a video source and choose your narration settings."}</p></div><button className="close-button" onClick={() => setModalOpen(false)} aria-label="Close">×</button></div>
          <form onSubmit={createProject} className="project-form">
            <label className="field-label">Project name <span>Optional</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. The hidden truth behind…" maxLength={90} /></label>
            <label className="field-label">Video URL <span>Required</span><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." type="url" required /></label>
            <div className="form-two-col"><label className="field-label">Recap style<select value={recapType} onChange={(event) => setRecapType(event.target.value as "review" | "full_recap")}><option value="review">Movie Review / Commentary</option><option value="full_recap">Full Movie Recap</option></select></label><label className="field-label">Narration language<select value={language} onChange={(event) => setLanguage(event.target.value as "Myanmar" | "English")}><option>Myanmar</option><option>English</option></select></label></div>
            <label className="field-label">Recap length<select value={duration} onChange={(event) => setDuration(event.target.value as "3 min" | "5 min" | "10 min")}><option>3 min</option><option>5 min</option><option>10 min</option></select></label>
            <div className="field-label">Narrator voice</div><div className="voice-options"><button type="button" className={`voice-option ${voice === "Female" ? "selected" : ""}`} onClick={() => setVoice("Female")}><span className="voice-avatar">♀</span><span><strong>Female</strong><small>Warm narration</small></span><span className="radio-dot" /></button><button type="button" className={`voice-option ${voice === "Male" ? "selected" : ""}`} onClick={() => setVoice("Male")}><span className="voice-avatar male">♂</span><span><strong>Male</strong><small>Deep narration</small></span><span className="radio-dot" /></button></div><p className="modal-note">MyanmarTTS currently uses one built-in Burmese voice. The Male/Female setting is saved for future voice options but does not change this model's output yet.</p>
            {(isGenerating || isGeneratingVoiceover) && (
              <p className="modal-note" role="status">
                {isGeneratingVoiceover ? "AI is generating your voiceover. Keep this window open; do not submit again." : "AI is analyzing the YouTube video. Keep this window open; do not submit again."}
              </p>
            )}
            {selectedProject && !generatedScript && (
              <p className="modal-note" role="status">
                This saved project does not have a recap script yet. Choose Generate Recap Script when you are ready. Saving changes will not use AI.
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
            {generatedScript && selectedProject && (
              <section style={{ border: "1px solid #e7e7ed", borderRadius: 9, padding: 13, display: "grid", gap: 10 }}>
                <div>
                  <h3 style={{ fontSize: 12, margin: "0 0 5px" }}>Myanmar Voiceover · Open Source</h3>
                  <p style={{ fontSize: 11, color: "#747484", margin: 0 }}>MyanmarTTS open-source Burmese model. Audio is saved in your private storage. The free CPU host may sleep between uses.</p>
                </div>
                {voiceoverUrl && <audio controls preload="none" src={voiceoverUrl} style={{ width: "100%" }}>Your browser does not support audio playback.</audio>}
                <button type="button" className="secondary-button" onClick={generateVoiceover} disabled={isGenerating || isGeneratingVoiceover}>
                  {isGeneratingVoiceover ? "Generating voiceover..." : selectedProject.voiceoverPath ? "Regenerate Voiceover" : "Generate Voiceover →"}
                </button>
                {isGeneratingVoiceover && <p className="modal-note">One voice generation request is running. The first request may take longer while the free service wakes up.</p>}
              </section>
            )}
                        {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-note"><span>ⓘ</span><p>Save Project is free and only stores the YouTube link. Generate Recap Script sends the public video URL to Gemini's YouTube URL preview, which Google currently lists as no-charge. Free-tier rate limits and regional availability apply. Use media you own or are authorized to process.</p></div>
            <div className="modal-actions">
              <button type="button" className="cancel-button" onClick={() => setModalOpen(false)}>Close</button>
              <button type="submit" name="action" value="save" className="secondary-button" disabled={isGenerating || isGeneratingVoiceover}>
                {selectedProject ? "Save Changes" : "Save Project"}
              </button>
              <button type="submit" name="action" value="generate" className="primary-button" disabled={isGenerating || isGeneratingVoiceover}>
                {isGenerating ? "Analyzing..." : selectedProject?.script ? "Regenerate Recap Script →" : "Generate Recap Script →"}
              </button>
            </div>
          </form>
        </section>
      </div>}
    </main>
  );
}
