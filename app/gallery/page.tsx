"use client";
import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { useWorkflowStore } from "@/lib/store";
import type { User } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GalleryItem {
  id: string;
  url: string;
  mediaType: "image" | "video";
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  quality?: string;
  source: "generation" | "upload";
  created_at: string;
  referenceImageUrls?: string[];
}

interface RefImage {
  id: string;
  objectUrl: string;
  cdnUrl: string | null;
  uploading: boolean;
  error: boolean;
}

interface PendingGen {
  id: string;
  aspectRatio: string;
  prompt: string;
}

type MasonryItem = { kind: "pending"; pg: PendingGen } | { kind: "gallery"; item: GalleryItem };

interface DownloadTask {
  id: string;
  filename: string;
  status: "preparing" | "ready" | "error";
}

type Tab = "images" | "videos";

interface TaggedImage {
  label: string;
  refId: string;
  url: string;
}

function resolveGalleryMentions(
  text: string,
  tagged: TaggedImage[],
): { resolvedPrompt: string; extraUrls: string[] } {
  if (!tagged.length) return { resolvedPrompt: text, extraUrls: [] };
  type Span = { start: number; end: number; url: string };
  const spans: Span[] = [];
  const claimed = new Set<number>();
  for (const t of [...tagged].sort((a, b) => b.label.length - a.label.length)) {
    const escaped = t.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}(?!\\w)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!claimed.has(m.index)) {
        spans.push({ start: m.index, end: m.index + m[0].length, url: t.url });
        claimed.add(m.index);
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  if (!spans.length) return { resolvedPrompt: text, extraUrls: [] };
  const extraUrls: string[] = [];
  let resolvedPrompt = "";
  let lastEnd = 0;
  let n = 1;
  for (const span of spans) {
    resolvedPrompt += text.slice(lastEnd, span.start);
    resolvedPrompt += `<<<image ${n++}>>>`;
    extraUrls.push(span.url);
    lastEnd = span.end;
  }
  resolvedPrompt += text.slice(lastEnd);
  return { resolvedPrompt, extraUrls };
}

function renderGalleryMentions(
  text: string,
  tagged: TaggedImage[],
  onEnter: (tag: TaggedImage, rect: DOMRect) => void,
  onLeave: () => void,
  onMouseDown: (tag: TaggedImage) => void,
): React.ReactNode {
  if (!text) return null;
  if (!tagged.length) return <span style={{ color: "#e8e8e6" }}>{text}</span>;

  const sorted = [...tagged].sort((a, b) => b.label.length - a.label.length);
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    let earliest: { idx: number; tag: TaggedImage } | null = null;
    for (const tag of sorted) {
      const idx = rest.indexOf(`@${tag.label}`);
      if (idx !== -1 && (earliest === null || idx < earliest.idx)) earliest = { idx, tag };
    }
    if (!earliest) { parts.push(<span key={key++} style={{ color: "#e8e8e6" }}>{rest}</span>); break; }
    if (earliest.idx > 0) parts.push(<span key={key++} style={{ color: "#e8e8e6" }}>{rest.slice(0, earliest.idx)}</span>);
    const tag = earliest.tag;
    parts.push(
      <span
        key={key++}
        style={{
          color:        "#77E544",
          fontWeight:   500,
          cursor:       "text",
          pointerEvents: "auto",
          userSelect:   "none",
          background:   "rgba(119,229,68,0.15)",
          boxShadow:    "0 0 0 3px rgba(119,229,68,0.15)",
          borderRadius: "3px",
        }}
        onMouseEnter={e => onEnter(tag, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={onLeave}
        onMouseDown={e => { e.preventDefault(); onMouseDown(tag); }}
      >
        @{tag.label}
      </span>,
    );
    rest = rest.slice(earliest.idx + tag.label.length + 1);
  }
  return <>{parts}</>;
}

function resizeTextarea(el: HTMLTextAreaElement, maxH = 66) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, maxH) + "px";
}

async function getToken(): Promise<string | undefined> {
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token;
}

// ── Module-level cache ────────────────────────────────────────────────────────

const galleryCache    = new Map<string, { items: GalleryItem[]; hasMore: boolean }>();
const loadedImageUrls = new Set<string>();

interface SavedSettings {
  prompt: string; modelId: string; aspectRatio: string;
  quality: string; count: number; duration: number; mode: string;
  refImageUrls?: string[];
}

function loadSettings(tab: Tab): Partial<SavedSettings> | null {
  if (typeof window === "undefined") return null;
  try { const r = localStorage.getItem(`nf-gallery-${tab}`); return r ? JSON.parse(r) : null; }
  catch { return null; }
}

function saveSettings(tab: Tab, s: SavedSettings) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(`nf-gallery-${tab}`, JSON.stringify(s)); } catch {}
}

// ── Inner page ────────────────────────────────────────────────────────────────

function GalleryInner() {
  const searchParams = useSearchParams();
  const rawTab       = searchParams.get("tab");
  const tab          = (rawTab === "videos" ? "videos" : "images") as Tab;

  const [user, setUser]             = useState<User | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  const [items, setItems]               = useState<GalleryItem[]>([]);
  const [loading, setLoading]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [hasMore, setHasMore]           = useState(true);
  const [lightboxItem, setLightboxItem] = useState<GalleryItem | null>(null);

  const isVideo = tab === "videos";
  const models  = isVideo ? VIDEO_MODELS : IMAGE_MODELS;

  const skipNextModelEffect = useRef(false);

  const [prompt, setPrompt]           = useState<string>(() => loadSettings(tab)?.prompt ?? "");
  const [modelId, setModelId]         = useState<string>(() => {
    const s = loadSettings(tab);
    return (s?.modelId && models.find(m => m.id === s.modelId)) ? s.modelId : models[0].id;
  });
  const [aspectRatio, setAspectRatio] = useState<string>(() => {
    const s   = loadSettings(tab);
    const mId = (s?.modelId && models.find(m => m.id === s.modelId)) ? s.modelId : models[0].id;
    const mdl = models.find(m => m.id === mId) ?? models[0];
    if (s?.aspectRatio && mdl.ratios.includes(s.aspectRatio)) return s.aspectRatio;
    return ("defaultRatio" in mdl ? (mdl as { defaultRatio: string }).defaultRatio : null) ?? mdl.ratios[0] ?? "1:1";
  });
  const [quality, setQuality]         = useState<string>(() => loadSettings(tab)?.quality ?? "2k");
  const [count, setCount]             = useState<number>(() => loadSettings(tab)?.count ?? 1);
  const [duration, setDuration]       = useState<number>(() => loadSettings(tab)?.duration ?? 5);
  const [mode, setMode]               = useState<string>(() => loadSettings(tab)?.mode ?? "");
  const [pendingGens, setPendingGens] = useState<PendingGen[]>([]);
  const [submitting, setSubmitting]   = useState(false);
  const [genError, setGenError]       = useState<string>("");
  const debugMode = useWorkflowStore((s) => s.debugMode);
  const [sourceFilter, setSourceFilter] = useState<"generated" | "uploaded">("generated");
  const [zoom, setZoom]                 = useState(3);
  const [downloads, setDownloads]       = useState<DownloadTask[]>([]);
  const [refError, setRefError]         = useState("");

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  // Reference images — restored from localStorage on mount
  const [refImages, setRefImages] = useState<RefImage[]>(() => {
    const s = loadSettings(tab);
    return (s?.refImageUrls ?? []).map(url => ({
      id: url, objectUrl: url, cdnUrl: url, uploading: false, error: false,
    }));
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prompt expansion
  const [promptExpanded, setPromptExpanded] = useState(false);

  // @ mention state — tagged images also restored from localStorage
  const [taggedImages, setTaggedImages] = useState<TaggedImage[]>(() => {
    const s = loadSettings(tab);
    const urls = s?.refImageUrls ?? [];
    const p    = s?.prompt ?? "";
    return urls.flatMap((url, idx) => {
      const label = `img${idx + 1}`;
      return p.includes(`@${label}`) ? [{ label, refId: url, url }] : [];
    });
  });
  const [mentionQuery, setMentionQuery]   = useState<string | null>(null);
  const [mentionSelIdx, setMentionSelIdx] = useState(0);
  const inputRef                          = useRef<HTMLTextAreaElement>(null);
  const promptBarRef                      = useRef<HTMLDivElement>(null);
  const overlayInnerRef                   = useRef<HTMLDivElement>(null);
  const [chipPreview, setChipPreview]     = useState<{ tag: TaggedImage; rect: DOMRect } | null>(null);

  const pageRef     = useRef(0);
  const tabRef      = useRef<Tab>(tab);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [windowWidth, setWindowWidth] = useState(0);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => { refImages.forEach(r => URL.revokeObjectURL(r.objectUrl)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setAuthLoaded(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Load items ────────────────────────────────────────────────────────────

  const loadItems = useCallback(async (currentTab: Tab, page: number, replace = false) => {
    const token = await getToken();
    if (!token) return;
    if (replace) {
      const cached = galleryCache.get(currentTab);
      if (cached) { setItems(cached.items); setHasMore(cached.hasMore); }
      else setLoading(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const genType = currentTab === "videos" ? "video" : "image";
      const res = await fetch(`/api/gallery?type=${genType}&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const { items: newItems, hasMore: more } = await res.json() as { items: GalleryItem[]; hasMore: boolean };
      if (replace) {
        setItems(newItems);
        galleryCache.set(currentTab, { items: newItems, hasMore: more });
      } else {
        setItems(prev => {
          const merged = [...prev, ...newItems];
          galleryCache.set(currentTab, { items: merged, hasMore: more });
          return merged;
        });
      }
      setHasMore(more);
      pageRef.current = page;
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (authLoaded && user) loadItems(tab, 0, true);
    if (authLoaded && !user) setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded]);

  useEffect(() => {
    tabRef.current = tab;
    pageRef.current = 0;
    setHasMore(true);
    const cached = galleryCache.get(tab);
    if (cached) { setItems(cached.items); setHasMore(cached.hasMore); } else setItems([]);
    if (user) loadItems(tab, 0, true);
    const newModels = tab === "videos" ? VIDEO_MODELS : IMAGE_MODELS;
    const saved  = loadSettings(tab);
    const model  = (saved?.modelId ? newModels.find(m => m.id === saved.modelId) : null) ?? newModels[0];
    const savedAR = saved?.aspectRatio && model.ratios.includes(saved.aspectRatio) ? saved.aspectRatio : null;
    skipNextModelEffect.current = true;
    setModelId(model.id);
    setPrompt(saved?.prompt ?? "");
    setAspectRatio(savedAR ?? ("defaultRatio" in model ? (model as { defaultRatio: string }).defaultRatio : null) ?? model.ratios[0] ?? "16:9");
    setQuality(saved?.quality ?? "2k");
    setCount(saved?.count ?? 1);
    if ("defaultDuration" in model) setDuration(saved?.duration ?? (model as { defaultDuration: number }).defaultDuration ?? 5);
    if ("defaultMode" in model) setMode(saved?.mode ?? (model as { defaultMode: string }).defaultMode ?? "");
    const savedUrls = saved?.refImageUrls ?? [];
    const savedPrompt = saved?.prompt ?? "";
    setRefImages(prev => {
      prev.forEach(r => URL.revokeObjectURL(r.objectUrl));
      return savedUrls.map(url => ({ id: url, objectUrl: url, cdnUrl: url, uploading: false, error: false }));
    });
    setTaggedImages(
      savedUrls.flatMap((url, idx) => {
        const label = `img${idx + 1}`;
        return savedPrompt.includes(`@${label}`) ? [{ label, refId: url, url }] : [];
      })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (skipNextModelEffect.current) { skipNextModelEffect.current = false; return; }
    const m = models.find(m => m.id === modelId);
    if (!m) return;
    setAspectRatio(("defaultRatio" in m ? m.defaultRatio : null) ?? m.ratios[0] ?? "1:1");
    if ("defaultDuration" in m) setDuration(m.defaultDuration ?? 5);
    if ("defaultMode" in m) setMode(m.defaultMode ?? "");
    if (!("supportsImages" in m) || !m.supportsImages) {
      setRefImages(prev => { prev.forEach(r => URL.revokeObjectURL(r.objectUrl)); return []; });
      setTaggedImages([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  // Infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
        loadItems(tabRef.current, pageRef.current + 1);
      }
    }, { rootMargin: "400px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loading, loadItems]);

  // Persist settings
  useEffect(() => {
    const refImageUrls = refImages
      .filter(r => r.cdnUrl && !r.uploading && !r.error)
      .map(r => r.cdnUrl!);
    saveSettings(tab, { prompt, modelId, aspectRatio, quality, count, duration, mode, refImageUrls });
  }, [tab, prompt, modelId, aspectRatio, quality, count, duration, mode, refImages]);

  // Track window width; set initial zoom from breakpoints
  useEffect(() => {
    const w = window.innerWidth;
    setWindowWidth(w);
    setZoom(w >= 1400 ? 5 : w >= 900 ? 4 : w >= 640 ? 3 : 2);
    const handler = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // ── Image upload ──────────────────────────────────────────────────────────

  const imgModel   = IMAGE_MODELS.find(m => m.id === modelId);
  const maxImgs    = imgModel?.maxImages ?? 0;
  const canAddImgs = !isVideo && !!imgModel?.supportsImages && refImages.length < maxImgs;

  const handleFilePick = async (files: FileList) => {
    if (!imgModel?.supportsImages) return;
    const remaining = maxImgs - refImages.length;
    const toAdd     = Array.from(files).slice(0, remaining).filter(f => f.type.startsWith("image/"));
    if (toAdd.length === 0) return;

    const newEntries: RefImage[] = toAdd.map(f => ({
      id:        crypto.randomUUID(),
      objectUrl: URL.createObjectURL(f),
      cdnUrl:    null,
      uploading: true,
      error:     false,
    }));
    setRefImages(prev => [...prev, ...newEntries]);

    const token = await getToken();
    await Promise.all(toAdd.map(async (file, i) => {
      const entry = newEntries[i];
      try {
        const res  = await fetch("/api/upload-asset", {
          method:  "POST",
          headers: {
            "Content-Type": file.type,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: file,
        });
        const data = await res.json() as { cdnUrl?: string; error?: string };
        if (!res.ok || !data.cdnUrl) throw new Error(data.error ?? "Upload failed");
        setRefImages(prev => prev.map(r => r.id === entry.id ? { ...r, cdnUrl: data.cdnUrl!, uploading: false } : r));
      } catch {
        setRefImages(prev => prev.map(r => r.id === entry.id ? { ...r, uploading: false, error: true } : r));
      }
    }));
  };

  const removeImage = (id: string) => {
    const el = document.querySelector(`[data-refimg-id="${id}"]`) as HTMLElement | null;
    if (el) {
      // Synchronous DOM write — zero frame delay, starts before React scheduler
      el.style.transition = "opacity 170ms cubic-bezier(0.4,0,1,1), transform 170ms cubic-bezier(0.4,0,1,1)";
      el.style.opacity    = "0";
      el.style.transform  = "translateY(-10px) scale(0.92)";
    }
    // React state as a backup so any re-render in the window doesn't reset the styles
    setRemovingIds(prev => new Set(prev).add(id));
    setTimeout(() => {
      setRemovingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
      setRefImages(prev => {
        const img = prev.find(r => r.id === id);
        if (img) URL.revokeObjectURL(img.objectUrl);
        return prev.filter(r => r.id !== id);
      });
    }, 190);
  };

  // ── Generate ──────────────────────────────────────────────────────────────

  const generateOne = async (token: string): Promise<string> => {
    if (!isVideo) {
      const { resolvedPrompt, extraUrls } = resolveGalleryMentions(prompt, taggedImages);
      const refUrls   = refImages.filter(r => r.cdnUrl && !r.error).map(r => r.cdnUrl!);
      const imageUrls = [...extraUrls, ...refUrls];
      const res = await fetch("/api/generate", {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ prompt: resolvedPrompt, model: modelId, aspectRatio, quality, imageUrls }),
      });
      const d = await res.json() as { taskId?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed");
      return d.taskId!;
    } else {
      const vm = VIDEO_MODELS.find(m => m.id === modelId);
      const res = await fetch("/api/generate-video", {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          videoModel:  modelId,
          prompt,
          aspectRatio,
          duration,
          mode:        mode || vm?.defaultMode || "pro",
          resolution:  vm && "defaultResolution" in vm ? vm.defaultResolution : undefined,
        }),
      });
      const d = await res.json() as { taskId?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed");
      return d.taskId!;
    }
  };

  const pollTask = async (taskId: string): Promise<void> => {
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 3_000));
      const poll   = await fetch(`/api/job-status?taskId=${taskId}`);
      const result = await poll.json() as { status: string; error?: string };
      if (result.status === "done") return;
      if (result.status === "error") throw new Error(result.error ?? "Generation failed");
    }
    throw new Error("Timed out");
  };

  const generate = async () => {
    if (!prompt.trim() && !isVideo) return;
    if (refImages.some(r => r.uploading)) { setGenError("Images still uploading…"); setTimeout(() => setGenError(""), 3_000); return; }
    setGenError("");

    const n = isVideo ? 1 : count;
    const newPendings: PendingGen[] = Array.from({ length: n }, () => ({
      id: crypto.randomUUID(), aspectRatio, prompt,
    }));
    setPendingGens(prev => [...prev, ...newPendings]);

    // ── Debug mode: log + simulate, no real API call ────────────────────────
    if (debugMode) {
      const { resolvedPrompt: dbgPrompt, extraUrls: dbgExtra } = resolveGalleryMentions(prompt, taggedImages);
      const dbgRefUrls = refImages.filter(r => r.cdnUrl && !r.error).map(r => r.cdnUrl!);
      console.log("[Gallery Debug] Generate request:", {
        type: isVideo ? "video" : "image",
        prompt: dbgPrompt, model: modelId, aspectRatio, quality,
        ...(isVideo
          ? { duration, mode }
          : { imageUrls: [...dbgExtra, ...dbgRefUrls], count: n }),
      });
      setTimeout(() => {
        setPendingGens(prev => prev.filter(p => !newPendings.some(np => np.id === p.id)));
      }, 3_000);
      return;
    }

    // ── Submit ────────────────────────────────────────────────────────────
    const token = await getToken();
    if (!token) {
      setPendingGens(prev => prev.filter(p => !newPendings.some(np => np.id === p.id)));
      setGenError("Please sign in to generate.");
      return;
    }

    setSubmitting(true);
    let taskIds: string[];
    try {
      taskIds = await Promise.all(newPendings.map(() => generateOne(token)));
    } catch (e: unknown) {
      setSubmitting(false);
      setPendingGens(prev => prev.filter(p => !newPendings.some(np => np.id === p.id)));
      setGenError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setGenError(""), 6_000);
      return;
    }
    setSubmitting(false); // re-enable button — polling happens in background

    // ── Poll each task independently ───────────────────────────────────────
    taskIds.forEach(async (taskId, i) => {
      const pending = newPendings[i];
      try {
        await pollTask(taskId);
      } catch (e: unknown) {
        setGenError(e instanceof Error ? e.message : String(e));
        setTimeout(() => setGenError(""), 6_000);
      } finally {
        setPendingGens(prev => prev.filter(p => p.id !== pending.id));
        await loadItems(tabRef.current, 0, true);
        window.dispatchEvent(new Event("credits-refresh"));
      }
    });
  };

  // ── @ mention derived + helpers ───────────────────────────────────────────

  const mentionableImages = useMemo(() =>
    refImages.filter(r => !r.uploading && !r.error && r.cdnUrl),
  [refImages]);

  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return [];
    return mentionableImages.slice(0, 8);
  }, [mentionableImages, mentionQuery]);

  const atMenuOpen = !isVideo && mentionQuery !== null && filteredMentions.length > 0;

  useEffect(() => { setMentionSelIdx(0); }, [filteredMentions.length]);

  // Sync: remove chips whose @label was deleted from the prompt
  useEffect(() => {
    setTaggedImages(prev => prev.filter(t => prompt.includes(`@${t.label}`)));
    if (inputRef.current) {
      if (!promptExpanded) resizeTextarea(inputRef.current);
      if (!promptExpanded) inputRef.current.scrollTop = 0;
    }
    if (!promptExpanded && overlayInnerRef.current) overlayInnerRef.current.style.transform = "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  // Close @ menu on outside click
  useEffect(() => {
    if (!atMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-at-menu]") &&
          !(e.target as HTMLElement).closest("[data-prompt-input]")) {
        setMentionQuery(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [atMenuOpen]);

  const insertMention = (ref: RefImage) => {
    const pos   = refImages.findIndex(r => r.id === ref.id);
    const label = `img${pos + 1}`;
    if (!taggedImages.some(t => t.refId === ref.id))
      setTaggedImages(prev => [...prev, { label, refId: ref.id, url: ref.cdnUrl! }]);

    const input  = inputRef.current;
    const cursor = input?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, cursor);
    const after  = prompt.slice(cursor);
    const lastAt = before.lastIndexOf("@");
    const newText = lastAt >= 0
      ? `${before.slice(0, lastAt)}@${label} ${after}`
      : `${before}@${label} ${after}`;
    const newPos = (lastAt >= 0 ? lastAt : cursor) + label.length + 2;

    setPrompt(newText);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      if (!input) return;
      input.focus();
      input.setSelectionRange(newPos, newPos);
    });
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const vidModel    = VIDEO_MODELS.find(m => m.id === modelId);
  const ratios      = (isVideo ? vidModel?.ratios : imgModel?.ratios) ?? [];
  const supportsQ   = !isVideo && !!imgModel?.supportsQuality;
  const qualityOpts = imgModel?.apiInput.qualityOptions ?? ["2k", "4k"];
  const durations   = vidModel?.durations ?? [];
  const vidModes    = vidModel?.modes ?? [];
  const activeModel = models.find(m => m.id === modelId);
  const hasRefImgs  = refImages.length > 0;
  const allUploaded = refImages.every(r => !r.uploading);

  const canGenerate = submitting ? false : isVideo ? true : prompt.trim().length > 0;

  const handleAddReference = useCallback((url: string) => {
    if (refImages.some(r => r.cdnUrl === url || r.objectUrl === url)) {
      setRefError("Already added as a reference.");
      setTimeout(() => setRefError(""), 3000);
      return;
    }
    if (refImages.length >= maxImgs) return;
    setRefImages(prev => [...prev, { id: crypto.randomUUID(), objectUrl: url, cdnUrl: url, uploading: false, error: false }]);
  }, [refImages, maxImgs]);

  const handleCopyPrompt = useCallback((text: string) => {
    setPrompt(text);
  }, []);

  const handleDelete = useCallback(async (id: string, source: "generation" | "upload") => {
    const token = await getToken();
    if (!token) return;
    await fetch("/api/gallery", {
      method:  "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ id, source }),
    });
    setItems(prev => {
      const updated = prev.filter(i => i.id !== id);
      galleryCache.set(tabRef.current, { items: updated, hasMore });
      return updated;
    });
  }, [hasMore]);

  const handleDownload = useCallback(async (url: string, itemIsVideo: boolean): Promise<void> => {
    const ext      = itemIsVideo ? "mp4" : "jpg";
    const filename = `${Date.now()}.${ext}`;
    const taskId   = crypto.randomUUID();
    setDownloads(prev => [...prev, { id: taskId, filename, status: "preparing" }]);
    try {
      const res = await fetch(`/api/download?url=${encodeURIComponent(url)}&filename=${filename}`);
      if (!res.ok) throw new Error("Failed");
      const blob      = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a         = document.createElement("a");
      a.href          = objectUrl;
      a.download      = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      setDownloads(prev => prev.map(t => t.id === taskId ? { ...t, status: "ready" } : t));
    } catch {
      setDownloads(prev => prev.map(t => t.id === taskId ? { ...t, status: "error" } : t));
    }
  }, []);

  // Auto-dismiss download toast when all tasks complete
  useEffect(() => {
    if (downloads.length > 0 && downloads.every(d => d.status !== "preparing")) {
      const timer = setTimeout(() => setDownloads([]), 4000);
      return () => clearTimeout(timer);
    }
  }, [downloads]);

  const colCount = zoom;

  const filteredItems = useMemo(() =>
    sourceFilter === "generated"
      ? items.filter(item => item.source === "generation")
      : items.filter(item => item.source === "upload"),
  [items, sourceFilter]);

  const masonryColumns = useMemo<MasonryItem[][]>(() => {
    const all: MasonryItem[] = [
      ...pendingGens.map(pg   => ({ kind: "pending" as const, pg })),
      ...filteredItems.map(item => ({ kind: "gallery" as const, item })),
    ];
    const cols: MasonryItem[][] = Array.from({ length: colCount }, () => []);
    const heights               = new Array<number>(colCount).fill(0);
    for (const mi of all) {
      const col = heights.indexOf(Math.min(...heights));
      cols[col].push(mi);
      let ar = 1;
      if (mi.kind === "pending") {
        const [ws, hs] = mi.pg.aspectRatio.split(":");
        const w = parseFloat(ws), h = parseFloat(hs);
        if (w && h) ar = h / w;
      } else {
        const arStr = mi.item.aspect_ratio;
        if (arStr && arStr !== "auto") {
          const [ws, hs] = arStr.split(":");
          const w = parseFloat(ws), h = parseFloat(hs);
          if (w && h) ar = h / w;
        }
      }
      heights[col] += ar;
    }
    return cols;
  }, [pendingGens, filteredItems, colCount]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!authLoaded) return <div style={{ flex: 1, background: "#080A0C" }} />;

  if (!user) {
    return (
      <div style={{ flex: 1, background: "#080A0C", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "16px" }}>
        <p style={{ color: "#4A4A45", fontSize: "14px" }}>Sign in to view your gallery</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, background: "#080A0C", display: "flex", flexDirection: "column", overflow: "hidden", color: "#fff" }}>

      {/* ── Sub-navbar ── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        justifyContent: "space-between",
        padding:      "0 14px",
        height:       "44px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        flexShrink:   0,
      }}>
        {/* Left: source tabs */}
        <div style={{ display: "flex", gap: "2px" }}>
          {(["generated", "uploaded"] as const).map(src => (
            <button
              key={src}
              onClick={() => setSourceFilter(src)}
              style={{
                display:      "flex",
                alignItems:   "center",
                gap:          "6px",
                padding:      "5px 12px",
                borderRadius: "8px",
                border:       "none",
                background:   sourceFilter === src ? "rgba(255,255,255,0.08)" : "transparent",
                color:        sourceFilter === src ? "#ffffff" : "rgba(255,255,255,0.38)",
                fontSize:     "13px",
                fontWeight:   sourceFilter === src ? 500 : 400,
                cursor:       "pointer",
                transition:   "background 140ms, color 140ms",
                fontFamily:   "inherit",
                letterSpacing: "-0.01em",
              }}
              onMouseEnter={e => { if (sourceFilter !== src) e.currentTarget.style.color = "rgba(255,255,255,0.65)"; }}
              onMouseLeave={e => { if (sourceFilter !== src) e.currentTarget.style.color = "rgba(255,255,255,0.38)"; }}
            >
              {src === "generated" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              )}
              {src === "generated" ? "Generated" : "Uploaded"}
            </button>
          ))}
        </div>

        {/* Right: zoom slider */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35M8 11h6" />
          </svg>
          <input
            type="range"
            min={1} max={6} step={1}
            value={7 - zoom}
            onChange={e => setZoom(7 - Number(e.target.value))}
            className="gallery-zoom-slider"
          />
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35M11 8v6M8 11h6" />
          </svg>
        </div>
      </div>

      {/* ── Grid ── */}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: "160px" }}>
        {/* ── Gallery grid ── */}
        {!loading && filteredItems.length === 0 && pendingGens.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          <div style={{ display: "flex", gap: "3px", padding: "3px" }}>
            {masonryColumns.map((col, ci) => (
              <div key={ci} style={{ flex: 1, display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 }}>
                {col.map(mi => {
                  if (mi.kind === "pending") {
                    const pg = mi.pg;
                    const [ws, hs] = pg.aspectRatio.split(":");
                    const w = parseFloat(ws), h = parseFloat(hs);
                    return (
                      <div key={pg.id} className="gallery-item" style={{
                        aspectRatio: (w && h) ? `${w} / ${h}` : "1 / 1",
                        background: "#0D1012",
                      }}>
                        <div style={{
                          position: "absolute", inset: 0,
                          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px",
                        }}>
                          <div style={{
                            width: "20px", height: "20px", borderRadius: "50%",
                            border: "2px solid rgba(119,229,68,0.15)", borderTopColor: "#77E544",
                            animation: "spin 0.9s linear infinite",
                          }} />
                          <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.22)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                            Generating
                          </span>
                        </div>
                        {pg.prompt && (
                          <div style={{
                            position: "absolute", bottom: 0, left: 0, right: 0,
                            padding: "24px 10px 10px",
                            background: "linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 100%)",
                          }}>
                            <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.35)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                              {pg.prompt}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <GalleryCard
                      key={mi.item.id}
                      item={mi.item}
                      onOpen={mi.item.mediaType === "image" ? () => setLightboxItem(mi.item) : undefined}
                      onAddReference={mi.item.mediaType === "image" && canAddImgs ? handleAddReference : undefined}
                      onCopyPrompt={handleCopyPrompt}
                      onDownload={handleDownload}
                      onDelete={handleDelete}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <div ref={sentinelRef} style={{ height: "1px" }} />
      </div>

      {/* ── Hidden file input ── */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={e => { if (e.target.files) { handleFilePick(e.target.files); e.target.value = ""; } }}
      />

      {/* ── Prompt bar ── */}
      <div
        ref={promptBarRef}
        style={{
          position:  "fixed",
          bottom:    "20px",
          left:      "50%",
          transform: "translateX(-50%)",
          width:     "min(860px, calc(100vw - 32px))",
          zIndex:    200,
        }}
      >

        {/* Toast */}
        {genError && (
          <div style={{
            marginBottom: "8px",
            padding:      "8px 14px",
            background:   "rgba(248,113,113,0.1)",
            border:       "1px solid rgba(248,113,113,0.2)",
            borderRadius: "10px",
            fontSize:     "12px",
            color:        "#f87171",
          }}>
            {genError}
          </div>
        )}

        <div style={{
          background:           "rgba(14,16,18,0.97)",
          backdropFilter:       "blur(32px)",
          WebkitBackdropFilter: "blur(32px)",
          border:               "1px solid rgba(255,255,255,0.08)",
          borderRadius:         "18px",
          boxShadow:            "0 28px 80px rgba(0,0,0,0.9), 0 4px 20px rgba(0,0,0,0.5)",
          overflow:             "hidden",
        }}>

          {/* ── Reference image thumbnails ── */}
          {!isVideo && (hasRefImgs || canAddImgs) && (
            <div style={{
              padding:    "14px 16px 0",
              display:    "flex",
              gap:        "10px",
              flexWrap:   "wrap",
              alignItems: "flex-start",
            }}>
              {refImages.map(img => {
                const isRemoving = removingIds.has(img.id);
                return (
                <div key={img.id} data-refimg-id={img.id} style={{
                  position:     "relative",
                  width:        "88px",
                  height:       "80px",
                  borderRadius: "10px",
                  overflow:     "hidden",
                  background:   "#1A1C1F",
                  flexShrink:   0,
                  border:       img.error ? "1px solid rgba(248,113,113,0.4)" : "1px solid rgba(255,255,255,0.08)",
                  // Entry: spring animation on mount
                  animation:    isRemoving ? "none" : "refImgIn 260ms cubic-bezier(0.16,1,0.3,1)",
                  // Exit: CSS transition driven by React state (same values as DOM manipulation — no conflict)
                  ...(isRemoving ? {
                    transition: "opacity 170ms cubic-bezier(0.4,0,1,1), transform 170ms cubic-bezier(0.4,0,1,1)",
                    opacity:    0,
                    transform:  "translateY(-10px) scale(0.92)",
                  } : {}),
                }}>
                  {/* Thumbnail */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.objectUrl}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                  {/* Upload overlay */}
                  {img.uploading && (
                    <div style={{
                      position:        "absolute",
                      inset:           0,
                      background:      "rgba(0,0,0,0.55)",
                      display:         "flex",
                      alignItems:      "center",
                      justifyContent:  "center",
                    }}>
                      <span style={{
                        width:        "18px",
                        height:       "18px",
                        borderRadius: "50%",
                        border:       "2px solid rgba(255,255,255,0.2)",
                        borderTopColor: "#77E544",
                        display:      "inline-block",
                        animation:    "spin 0.75s linear infinite",
                      }} />
                    </div>
                  )}
                  {/* Error overlay */}
                  {img.error && (
                    <div style={{
                      position:       "absolute",
                      inset:          0,
                      background:     "rgba(0,0,0,0.55)",
                      display:        "flex",
                      alignItems:     "center",
                      justifyContent: "center",
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
                      </svg>
                    </div>
                  )}
                  {/* X button */}
                  <button
                    onClick={() => removeImage(img.id)}
                    style={{
                      position:       "absolute",
                      top:            "5px",
                      right:          "5px",
                      width:          "20px",
                      height:         "20px",
                      borderRadius:   "50%",
                      background:     "rgba(0,0,0,0.7)",
                      border:         "1px solid rgba(255,255,255,0.15)",
                      color:          "rgba(255,255,255,0.85)",
                      cursor:         "pointer",
                      display:        "flex",
                      alignItems:     "center",
                      justifyContent: "center",
                      lineHeight:     1,
                      padding:        0,
                      fontSize:       "12px",
                      transition:     "background 120ms",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,0,0,0.9)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "rgba(0,0,0,0.7)"; }}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );})}

              {/* Add-more button */}
              {canAddImgs && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={submitting}
                  style={{
                    width:          "88px",
                    height:         "80px",
                    borderRadius:   "10px",
                    border:         "1.5px dashed rgba(255,255,255,0.4)",
                    background:     "rgba(255,255,255,0.025)",
                    cursor:         submitting ? "not-allowed" : "pointer",
                    display:        "flex",
                    flexDirection:  "column",
                    alignItems:     "center",
                    justifyContent: "center",
                    gap:            "6px",
                    color:          "rgba(255,255,255,0.75)",
                    flexShrink:     0,
                    transition:     "border-color 140ms, background 140ms, color 140ms",
                  }}
                  onMouseEnter={e => {
                    if (!submitting) {
                      e.currentTarget.style.borderColor = "rgba(255,255,255,0.6)";
                      e.currentTarget.style.background  = "rgba(255,255,255,0.05)";
                      e.currentTarget.style.color       = "#ffffff";
                    }
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.4)";
                    e.currentTarget.style.background  = "rgba(255,255,255,0.025)";
                    e.currentTarget.style.color       = "rgba(255,255,255,0.75)";
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="m21 15-5-5L5 21" />
                    <path d="M19 3v6M22 6h-6" />
                  </svg>
                  <span style={{ fontSize: "10px", letterSpacing: "0.02em" }}>
                    {maxImgs - refImages.length} left
                  </span>
                </button>
              )}
            </div>
          )}

          {/* ── Input + Controls + Generate ── */}
          <div style={{
            padding:    hasRefImgs ? "12px 14px 14px 16px" : "16px 14px 14px 16px",
            display:    "flex",
            alignItems: "flex-start",
            gap:        "12px",
          }}>
            {/* Left column: input + controls */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "10px" }}>
            {/* Prompt input with inline mention chips */}
            <div style={{ position: "relative", flex: "none" }}>
              {/* Transparent textarea — editing layer */}
              <textarea
                ref={inputRef}
                data-prompt-input=""
                value={prompt}
                rows={1}
                onChange={e => {
                  const text   = e.target.value;
                  const cursor = e.target.selectionStart ?? text.length;
                  setPrompt(text);
                  if (!promptExpanded) resizeTextarea(e.target);
                  if (!isVideo) {
                    const match = text.slice(0, cursor).match(/@(\w*)$/);
                    setMentionQuery(match ? match[1] : null);
                  }
                }}
                onSelect={e => {
                  if (isVideo) return;
                  const ta     = e.currentTarget;
                  const cursor = ta.selectionStart ?? ta.value.length;
                  const match  = ta.value.slice(0, cursor).match(/@(\w*)$/);
                  setMentionQuery(match ? match[1] : null);
                }}
                onScroll={e => {
                  if (overlayInnerRef.current)
                    overlayInnerRef.current.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`;
                }}
                onKeyDown={e => {
                  if (atMenuOpen) {
                    if (e.key === "ArrowDown") { e.preventDefault(); setMentionSelIdx(i => (i + 1) % filteredMentions.length); return; }
                    if (e.key === "ArrowUp")   { e.preventDefault(); setMentionSelIdx(i => (i - 1 + filteredMentions.length) % filteredMentions.length); return; }
                    if (e.key === "Enter")     { e.preventDefault(); insertMention(filteredMentions[mentionSelIdx]); return; }
                    if (e.key === "Escape")    { setMentionQuery(null); return; }
                  }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitting) { e.preventDefault(); generate(); }
                }}
                disabled={submitting}
                style={{
                  position:      "relative",
                  display:       "block",
                  width:         "100%",
                  background:    "transparent",
                  border:        "none",
                  outline:       "none",
                  color:         "transparent",
                  caretColor:    "#77E544",
                  fontSize:      "14.5px",
                  fontFamily:    "inherit",
                  lineHeight:    "22px",
                  letterSpacing: "-0.01em",
                  padding:       0,
                  resize:        "none",
                  maxHeight:     promptExpanded ? "none" : "66px",
                  overflowY:     "auto",
                  scrollbarWidth: "none",
                } as React.CSSProperties}
              />
              {/* Chip overlay — visually replaces the transparent text */}
              <div
                aria-hidden
                style={{
                  position:      "absolute",
                  inset:         0,
                  overflow:      "hidden",
                  pointerEvents: "none",
                }}
              >
                <div
                  ref={overlayInnerRef}
                  style={{
                    display:       "block",
                    fontSize:      "14.5px",
                    fontFamily:    "inherit",
                    lineHeight:    "22px",
                    letterSpacing: "-0.01em",
                    whiteSpace:    "pre-wrap",
                    wordBreak:     "break-word",
                    willChange:    "transform",
                  }}
                >
                  {renderGalleryMentions(
                    prompt, taggedImages,
                    (tag, rect) => setChipPreview({ tag, rect }),
                    () => setChipPreview(null),
                    tag => {
                      const idx = prompt.indexOf(`@${tag.label}`);
                      const pos = idx >= 0 ? idx + tag.label.length + 1 : prompt.length;
                      inputRef.current?.focus();
                      inputRef.current?.setSelectionRange(pos, pos);
                    },
                  )}
                </div>
              </div>
              {/* Placeholder */}
              {!prompt && (
                <div
                  aria-hidden
                  style={{
                    position:      "absolute",
                    inset:         0,
                    display:       "block",
                    lineHeight:    "22px",
                    fontSize:      "14.5px",
                    fontFamily:    "inherit",
                    letterSpacing: "-0.01em",
                    color:         "rgba(255,255,255,0.3)",
                    pointerEvents: "none",
                  }}
                >
                  {isVideo ? "Describe the video you imagine…" : "Describe the scene you imagine…"}
                </div>
              )}
              {/* Expand / collapse button */}
              <button
                type="button"
                onClick={() => {
                  const next = !promptExpanded;
                  setPromptExpanded(next);
                  requestAnimationFrame(() => {
                    const el = inputRef.current;
                    if (!el) return;
                    if (next) {
                      el.style.height = Math.min(Math.round(window.innerHeight * 0.45), 380) + "px";
                    } else {
                      resizeTextarea(el);
                      el.scrollTop = 0;
                      if (overlayInnerRef.current) overlayInnerRef.current.style.transform = "";
                    }
                  });
                }}
                title={promptExpanded ? "Collapse" : "Expand prompt"}
                style={{
                  position:   "absolute",
                  top:        4,
                  right:      0,
                  width:      18,
                  height:     18,
                  padding:    0,
                  border:     "none",
                  background: "transparent",
                  color:      "rgba(255,255,255,0.3)",
                  cursor:     "pointer",
                  display:    "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "color 140ms",
                  lineHeight: 1,
                  pointerEvents: "auto",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.7)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.3)"; }}
              >
                {promptExpanded ? (
                  /* Collapse: arrows pointing inward */
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 1V4H1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M8 11V8H11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  /* Expand: arrows pointing outward */
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 4V1H4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M11 8V11H8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            </div>
            {/* Controls group */}
            <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
            {/* Count stepper (image only) — leftmost */}
            {!isVideo && (
              <div style={{
                display:      "flex",
                alignItems:   "center",
                height:       "36px",
                borderRadius: "8px",
                border:       "1px solid rgba(255,255,255,0.1)",
                background:   "rgba(255,255,255,0.05)",
                overflow:     "hidden",
                flexShrink:   0,
              }}>
                <button
                  onClick={() => setCount(c => Math.max(1, c - 1))}
                  disabled={submitting || count <= 1}
                  style={{
                    width: "34px", height: "100%", border: "none", background: "transparent",
                    color: count <= 1 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.55)",
                    cursor: submitting || count <= 1 ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "16px", fontFamily: "inherit", transition: "color 140ms",
                  }}
                >−</button>
                <span style={{
                  fontSize: "12.5px", color: "#ffffff",
                  minWidth: "30px", textAlign: "center",
                  fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em",
                }}>
                  {count}/4
                </span>
                <button
                  onClick={() => setCount(c => Math.min(4, c + 1))}
                  disabled={submitting || count >= 4}
                  style={{
                    width: "34px", height: "100%", border: "none", background: "transparent",
                    color: count >= 4 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.55)",
                    cursor: submitting || count >= 4 ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "16px", fontFamily: "inherit", transition: "color 140ms",
                  }}
                >+</button>
              </div>
            )}

            {/* Model picker */}
            <CustomDropdown
              value={modelId}
              onChange={setModelId}
              disabled={submitting}
              options={models.map(m => ({
                value: m.id,
                label: m.name,
                group: ("provider" in m ? (m as { provider: string }).provider : undefined),
              }))}
              showChevron
            />

            {/* Quality */}
            {supportsQ && (
              <CustomDropdown
                value={quality}
                onChange={setQuality}
                disabled={submitting}
                options={qualityOpts.map(q => ({ value: q, label: q.toUpperCase() }))}
                icon={<DiamondIcon />}
              />
            )}

            {/* Aspect ratio */}
            {ratios.length > 0 && (
              <CustomDropdown
                value={aspectRatio}
                onChange={setAspectRatio}
                disabled={submitting}
                options={ratios.map(r => ({ value: r, label: r, preview: <RatioPreview ratio={r} /> }))}
                icon={<AspectIcon />}
              />
            )}

            {/* Duration (video) */}
            {isVideo && durations.length > 0 && (
              <CustomDropdown
                value={String(duration)}
                onChange={v => setDuration(Number(v))}
                disabled={submitting}
                options={durations.map(d => ({ value: String(d), label: `${d}s` }))}
              />
            )}

            {/* Mode (video) */}
            {isVideo && vidModes.length > 0 && (
              <CustomDropdown
                value={mode}
                onChange={setMode}
                disabled={submitting}
                options={vidModes.map(m => ({ value: m.value, label: m.label }))}
              />
            )}
            </div>{/* end controls group */}
            </div>{/* end left column */}

            {/* Generate button */}
            <button
              onClick={generate}
              disabled={!canGenerate}
              style={{
                display:        "flex",
                flexDirection:  "row",
                alignItems:     "center",
                justifyContent: "center",
                gap:            "7px",
                padding:        "0 26px",
                height:         "40px",
                borderRadius:   "14px",
                border:         "none",
                background:     "#77E544",
                color:          "#060A06",
                fontSize:       "15px",
                fontWeight:     700,
                cursor:         !canGenerate ? "not-allowed" : "pointer",
                opacity:        !canGenerate ? 0.45 : 1,
                transition:     "opacity 150ms, background 150ms",
                fontFamily:     "inherit",
                flexShrink:     0,
                letterSpacing:  "-0.02em",
                whiteSpace:     "nowrap",
                alignSelf:      "flex-start",
              }}
              onMouseEnter={e => { if (canGenerate) e.currentTarget.style.background = "#8FEE60"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "#77E544"; }}
            >
              {submitting ? (
                <>
                  <span style={{
                    width: "12px", height: "12px", borderRadius: "50%",
                    border: "2px solid rgba(6,10,6,0.25)", borderTopColor: "#060A06",
                    display: "inline-block", animation: "spin 0.75s linear infinite",
                  }} />
                  Sending…
                </>
              ) : (
                <>Generate <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" stroke="none" style={{ display: "inline", verticalAlign: "middle" }}><path d="M11.8525 4.21651L11.7221 3.2387C11.6906 3.00226 11.4889 2.82568 11.2504 2.82568C11.0118 2.82568 10.8102 3.00226 10.7786 3.23869L10.6483 4.21651C10.2658 7.0847 8.00939 9.34115 5.14119 9.72358L4.16338 9.85396C3.92694 9.88549 3.75037 10.0872 3.75037 10.3257C3.75037 10.5642 3.92694 10.7659 4.16338 10.7974L5.14119 10.9278C8.00938 11.3102 10.2658 13.5667 10.6483 16.4349L10.7786 17.4127C10.8102 17.6491 11.0118 17.8257 11.2504 17.8257C11.4889 17.8257 11.6906 17.6491 11.7221 17.4127L11.8525 16.4349C12.2349 13.5667 14.4913 11.3102 17.3595 10.9278L18.3374 10.7974C18.5738 10.7659 18.7504 10.5642 18.7504 10.3257C18.7504 10.0872 18.5738 9.88549 18.3374 9.85396L17.3595 9.72358C14.4913 9.34115 12.2349 7.0847 11.8525 4.21651Z"/><path d="M4.6519 14.7568L4.82063 14.2084C4.84491 14.1295 4.91781 14.0757 5.00037 14.0757C5.08292 14.0757 5.15582 14.1295 5.1801 14.2084L5.34883 14.7568C5.56525 15.4602 6.11587 16.0108 6.81925 16.2272L7.36762 16.3959C7.44652 16.4202 7.50037 16.4931 7.50037 16.5757C7.50037 16.6582 7.44652 16.7311 7.36762 16.7554L6.81926 16.9241C6.11587 17.1406 5.56525 17.6912 5.34883 18.3946L5.1801 18.9429C5.15582 19.0218 5.08292 19.0757 5.00037 19.0757C4.91781 19.0757 4.84491 19.0218 4.82063 18.9429L4.65191 18.3946C4.43548 17.6912 3.88486 17.1406 3.18147 16.9241L2.63311 16.7554C2.55421 16.7311 2.50037 16.6582 2.50037 16.5757C2.50037 16.4931 2.55421 16.4202 2.63311 16.3959L3.18148 16.2272C3.88486 16.0108 4.43548 15.4602 4.6519 14.7568Z"/></svg></>
              )}
            </button>
          </div>
        </div>
      </div>

      <style>{GALLERY_CSS}</style>

      {/* ── @ image picker menu ── */}
      {atMenuOpen && promptBarRef.current && createPortal(
        <div
          data-at-menu=""
          style={{
            position:    "fixed",
            left:        promptBarRef.current.getBoundingClientRect().left,
            bottom:      window.innerHeight - promptBarRef.current.getBoundingClientRect().top + 6,
            width:       promptBarRef.current.getBoundingClientRect().width,
            background:  "#0E1012",
            border:      "1px solid rgba(255,255,255,0.1)",
            borderRadius: "14px",
            boxShadow:   "0 8px 48px rgba(0,0,0,0.75), 0 2px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
            overflow:    "hidden",
            zIndex:      9999,
            animation:   "dropIn 130ms cubic-bezier(0.16,1,0.3,1)",
          }}
          onMouseDown={e => e.preventDefault()}
        >
          <div style={{ padding: "6px 12px 4px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>
              Gallery images
            </span>
          </div>
          <div style={{ maxHeight: "280px", overflowY: "auto", padding: "4px" }}>
            {filteredMentions.map((ref, idx) => (
              <button
                key={ref.id}
                onClick={() => insertMention(ref)}
                onMouseEnter={() => setMentionSelIdx(idx)}
                style={{
                  display:    "flex",
                  alignItems: "center",
                  gap:        "10px",
                  width:      "100%",
                  padding:    "7px 10px",
                  borderRadius: "9px",
                  border:     "none",
                  background: idx === mentionSelIdx ? "rgba(119,229,68,0.07)" : "transparent",
                  color:      idx === mentionSelIdx ? "#77E544" : "rgba(255,255,255,0.65)",
                  fontSize:   "13px",
                  fontFamily: "inherit",
                  cursor:     "pointer",
                  textAlign:  "left",
                  transition: "background 80ms",
                  letterSpacing: "-0.01em",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ref.objectUrl}
                  alt=""
                  style={{ width: "30px", height: "30px", borderRadius: "6px", objectFit: "cover", flexShrink: 0, background: "#1a1c1f" }}
                />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Image {idx + 1}
                </span>
                {idx === mentionSelIdx && (
                  <span style={{ marginLeft: "auto", fontSize: "10px", color: "rgba(255,255,255,0.2)", flexShrink: 0 }}>↵</span>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}

      {/* ── Chip hover preview ── */}
      {chipPreview && createPortal(
        /* Outer: positioning only — no animation so transform stays stable */
        <div
          style={{
            position:      "fixed",
            left:          chipPreview.rect.left + chipPreview.rect.width / 2,
            bottom:        window.innerHeight - chipPreview.rect.top + 8,
            transform:     "translateX(-50%)",
            zIndex:        99999,
            pointerEvents: "none",
          }}
        >
          {/* Inner: animation only — no positioning transform */}
          <div
            style={{
              borderRadius: "10px",
              overflow:     "hidden",
              boxShadow:    "0 8px 32px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.4)",
              border:       "1px solid rgba(255,255,255,0.08)",
              animation:    "dropIn 140ms cubic-bezier(0.16,1,0.3,1)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={chipPreview.tag.url}
              alt=""
              style={{ display: "block", maxWidth: "200px", maxHeight: "160px", width: "auto", height: "auto", objectFit: "contain" }}
            />
          </div>
        </div>,
        document.body,
      )}

      {lightboxItem && (
        <Lightbox item={lightboxItem} onClose={() => setLightboxItem(null)} />
      )}

      <DownloadToast downloads={downloads} onClear={() => setDownloads([])} />

      {refError && (
        <div style={{
          position:             "fixed",
          top:                  "64px",
          right:                "16px",
          zIndex:               9600,
          display:              "flex",
          alignItems:           "center",
          gap:                  "8px",
          padding:              "10px 14px",
          borderRadius:         "12px",
          background:           "rgba(16,18,20,0.97)",
          backdropFilter:       "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border:               "1px solid rgba(248,113,113,0.25)",
          boxShadow:            "0 8px 32px rgba(0,0,0,0.55)",
          fontSize:             "13px",
          color:                "#f87171",
          fontFamily:           "inherit",
          letterSpacing:        "-0.01em",
          animation:            "dropIn 160ms cubic-bezier(0.16,1,0.3,1)",
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
          </svg>
          {refError}
        </div>
      )}
    </div>
  );
}

export default function GalleryPage() {
  return (
    <Suspense fallback={<div style={{ flex: 1, background: "#080A0C" }} />}>
      <GalleryInner />
    </Suspense>
  );
}

// ── CustomDropdown ────────────────────────────────────────────────────────────

interface DropOption {
  value: string;
  label: string;
  group?: string;
  preview?: React.ReactNode;
}

function CustomDropdown({
  value,
  onChange,
  disabled,
  options,
  icon,
  showChevron = true,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  options: DropOption[];
  icon?: React.ReactNode;
  showChevron?: boolean;
}) {
  const [open, setOpen]     = useState(false);
  const [pos, setPos]       = useState({ left: 0, bottom: 0, minW: 0 });
  const triggerRef          = useRef<HTMLButtonElement>(null);
  const dropRef             = useRef<HTMLDivElement>(null);

  const label = options.find(o => o.value === value)?.label ?? value;

  const openDrop = () => {
    if (disabled || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ left: r.left, bottom: window.innerHeight - r.top + 6, minW: r.width });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !dropRef.current?.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Group options by group field
  const groups = options.reduce<Record<string, DropOption[]>>((acc, o) => {
    const g = o.group ?? "";
    (acc[g] ??= []).push(o);
    return acc;
  }, {});
  const groupKeys    = Object.keys(groups);
  const hasGroups    = groupKeys.some(k => k !== "");

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => open ? setOpen(false) : openDrop()}
        disabled={disabled}
        style={{
          display:      "flex",
          alignItems:   "center",
          gap:          "6px",
          height:       "36px",
          padding:      "0 12px",
          borderRadius: "8px",
          border:       open
            ? "1px solid rgba(255,255,255,0.18)"
            : "1px solid rgba(255,255,255,0.1)",
          background:   open
            ? "rgba(255,255,255,0.08)"
            : "rgba(255,255,255,0.05)",
          flexShrink:   0,
          cursor:       disabled ? "not-allowed" : "pointer",
          fontFamily:   "inherit",
          transition:   "border-color 140ms, background 140ms",
          userSelect:   "none",
        }}
        onMouseEnter={e => {
          if (!disabled && !open) {
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.16)";
            e.currentTarget.style.background  = "rgba(255,255,255,0.07)";
          }
        }}
        onMouseLeave={e => {
          if (!open) {
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
            e.currentTarget.style.background  = "rgba(255,255,255,0.05)";
          }
        }}
      >
        {icon && (
          <span style={{ display: "flex", alignItems: "center", color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>
            {icon}
          </span>
        )}
        <span style={{ fontSize: "13px", color: "#ffffff", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>
          {label}
        </span>
        {showChevron && (
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="rgba(255,255,255,0.35)" strokeWidth="2.5" strokeLinecap="round"
            style={{ flexShrink: 0, transition: "transform 140ms", transform: open ? "rotate(180deg)" : "none" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          style={{
            position:     "fixed",
            left:         pos.left,
            bottom:       pos.bottom,
            minWidth:     Math.max(pos.minW, 160),
            background:   "#0E1012",
            border:       "1px solid rgba(255,255,255,0.1)",
            borderRadius: "14px",
            boxShadow:    "0 8px 48px rgba(0,0,0,0.75), 0 2px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
            overflow:     "hidden",
            zIndex:       9999,
            animation:    "dropIn 130ms cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          <div style={{ padding: "5px", maxHeight: "300px", overflowY: "auto" }}>
            {hasGroups ? (
              groupKeys.map((gk, gi) => (
                <div key={gk}>
                  {gi > 0 && (
                    <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", margin: "4px 8px" }} />
                  )}
                  {gk && (
                    <div style={{
                      padding:       "5px 10px 3px",
                      fontSize:      "10px",
                      color:         "rgba(255,255,255,0.22)",
                      textTransform: "uppercase",
                      letterSpacing: "0.09em",
                      fontWeight:    500,
                    }}>
                      {gk}
                    </div>
                  )}
                  {groups[gk].map(opt => (
                    <DropItem
                      key={opt.value}
                      label={opt.label}
                      active={opt.value === value}
                      onClick={() => { onChange(opt.value); setOpen(false); }}
                      preview={opt.preview}
                    />
                  ))}
                </div>
              ))
            ) : (
              options.map(opt => (
                <DropItem
                  key={opt.value}
                  label={opt.label}
                  active={opt.value === value}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  preview={opt.preview}
                />
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function DropItem({ label, active, onClick, preview }: { label: string; active: boolean; onClick: () => void; preview?: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display:      "flex",
        alignItems:   "center",
        gap:          "8px",
        width:        "100%",
        padding:      "7px 10px",
        borderRadius: "9px",
        border:       "none",
        background:   active
          ? "rgba(255,255,255,0.09)"
          : hovered ? "rgba(255,255,255,0.06)" : "transparent",
        color:        active ? "#ffffff" : hovered ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.55)",
        fontSize:     "13px",
        fontWeight:   active ? 500 : 400,
        cursor:       "pointer",
        textAlign:    "left",
        transition:   "background 100ms, color 100ms",
        fontFamily:   "inherit",
        letterSpacing: "-0.01em",
        whiteSpace:   "nowrap",
      }}
    >
      {preview}
      {label}
    </button>
  );
}

function RatioPreview({ ratio }: { ratio: string }) {
  const [ws, hs] = ratio.split(":");
  const w = parseFloat(ws), h = parseFloat(hs);
  if (!w || !h) return null;
  const maxW = 36, maxH = 22;
  let rw = maxW, rh = (h / w) * maxW;
  if (rh > maxH) { rh = maxH; rw = (w / h) * maxH; }
  return (
    <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "44px", flexShrink: 0 }}>
      <span style={{
        display:     "inline-block",
        width:       `${Math.round(rw)}px`,
        height:      `${Math.round(rh)}px`,
        border:      "1.5px solid rgba(255,255,255,0.75)",
        borderRadius: "5px",
        flexShrink:  0,
      }} />
    </span>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function DiamondIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0Z" />
    </svg>
  );
}

function AspectIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
    </svg>
  );
}

// ── Gallery card ──────────────────────────────────────────────────────────────

function GalleryCard({
  item,
  onOpen,
  onAddReference,
  onCopyPrompt,
  onDownload,
  onDelete,
}: {
  item: GalleryItem;
  onOpen?: () => void;
  onAddReference?: (url: string) => void;
  onCopyPrompt?: (prompt: string) => void;
  onDownload?: (url: string, isVideo: boolean) => Promise<void>;
  onDelete?: (id: string, source: "generation" | "upload") => Promise<void>;
}) {
  const videoRef                        = useRef<HTMLVideoElement>(null);
  const cardRef                         = useRef<HTMLDivElement>(null);
  const preloaded                       = loadedImageUrls.has(item.url);
  const [playing, setPlaying]           = useState(false);
  const [failed, setFailed]             = useState(false);
  const [imgLoaded, setImgLoaded]       = useState(preloaded);
  const [shouldLoad, setShouldLoad]     = useState(preloaded);
  const [copied, setCopied]             = useState(false);
  const [downloading, setDownloading]   = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const isVideo                         = item.mediaType === "video";

  useEffect(() => {
    if (preloaded) return;
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setShouldLoad(true); observer.disconnect(); } },
      { rootMargin: "80px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cssRatio = (() => {
    const ar = item.aspect_ratio;
    if (!ar || ar === "auto") return null;
    const [w, h] = ar.split(":");
    return w && h ? `${w} / ${h}` : null;
  })();

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try { await onDownload?.(item.url, isVideo); } finally { setDownloading(false); }
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.prompt) return;
    onCopyPrompt?.(item.prompt);
    if (onAddReference && item.referenceImageUrls?.length) {
      item.referenceImageUrls.forEach(url => onAddReference(url));
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleAddRef = (e: React.MouseEvent) => {
    e.stopPropagation();
    onAddReference?.(item.url);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try { await onDelete?.(item.id, item.source); } finally { setDeleting(false); }
  };

  if (failed) {
    return (
      <div className="gallery-item" style={{ aspectRatio: cssRatio ?? "1 / 1", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className="gallery-item"
      style={cssRatio ? { aspectRatio: cssRatio } : undefined}
      onMouseEnter={() => { if (isVideo) videoRef.current?.play().then(() => setPlaying(true)).catch(() => {}); }}
      onMouseLeave={() => { if (isVideo && videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; setPlaying(false); } }}
      onClick={onOpen}
    >
      {isVideo ? (
        <>
          <video ref={videoRef} src={item.url} muted loop playsInline preload="metadata" onError={() => setFailed(true)} />
          {!playing && (
            <div className="gallery-play-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" stroke="none"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </div>
          )}
        </>
      ) : (
        <>
          {(!shouldLoad || !imgLoaded) && <div className="gallery-shimmer" />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shouldLoad ? `/_next/image?url=${encodeURIComponent(item.url)}&w=828&q=75` : undefined}
            alt={item.prompt ?? ""}
            decoding="async"
            onLoad={() => { setImgLoaded(true); loadedImageUrls.add(item.url); }}
            onError={() => setFailed(true)}
            style={{ display: "block", width: "100%", height: "auto", opacity: imgLoaded ? 1 : 0, transition: "opacity 280ms ease" }}
          />
        </>
      )}

      {/* ── Gradient overlay + prompt ── */}
      <div className="gallery-overlay">
        {item.prompt && (
          <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.85)", lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", marginBottom: "4px" }}>
            {item.prompt}
          </p>
        )}
        <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>
          {[item.model, item.aspect_ratio].filter(Boolean).join(" · ") || (item.source === "upload" ? "Uploaded" : "")}
        </p>
      </div>

      {/* ── Top-right icon buttons ── */}
      <div className="gallery-actions-top">
        {item.prompt && onCopyPrompt && (
          <button className="gallery-action-btn" title={copied ? "Copied!" : "Copy prompt"} onClick={handleCopy}>
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#77E544" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        )}
        <button
          className="gallery-action-btn"
          title={downloading ? "Downloading…" : "Download"}
          onClick={handleDownload}
          disabled={downloading}
          style={{ opacity: downloading ? 0.65 : undefined }}
        >
          {downloading ? (
            <div style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "#fff", animation: "spin 0.75s linear infinite", flexShrink: 0 }} />
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
        </button>
        {onDelete && (
          <button
            className="gallery-action-btn gallery-delete-btn"
            title="Delete"
            onClick={handleDelete}
            disabled={deleting}
            style={{ opacity: deleting ? 0.65 : undefined }}
          >
            {deleting ? (
              <div style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "#fff", animation: "spin 0.75s linear infinite", flexShrink: 0 }} />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* ── Bottom-left Reference button (images only) ── */}
      {!isVideo && onAddReference && (
        <div className="gallery-actions-bottom">
          <button className="gallery-ref-btn" onClick={handleAddRef}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
            </svg>
            Reference
          </button>
        </div>
      )}
    </div>
  );
}

// ── DownloadToast ─────────────────────────────────────────────────────────────

function DownloadToast({ downloads, onClear }: { downloads: DownloadTask[]; onClear: () => void }) {
  const [collapsed, setCollapsed] = useState(false);

  if (downloads.length === 0) return null;

  const allDone     = downloads.every(d => d.status !== "preparing");
  const title       = allDone ? "Download complete" : "Preparing download";

  return (
    <div style={{
      position:             "fixed",
      top:                  "64px",
      right:                "16px",
      width:                "300px",
      background:           "rgba(16,18,20,0.97)",
      backdropFilter:       "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      borderRadius:         "18px",
      border:               "1px solid rgba(255,255,255,0.07)",
      boxShadow:            "0 12px 48px rgba(0,0,0,0.7), 0 2px 12px rgba(0,0,0,0.4)",
      zIndex:               9500,
      overflow:             "hidden",
      fontFamily:           "inherit",
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{ display: "flex", alignItems: "center", gap: "10px", padding: "14px 14px 14px 14px", cursor: "pointer", userSelect: "none" }}
      >
        {/* Animated icon */}
        <div style={{ position: "relative", width: "28px", height: "28px", flexShrink: 0 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" style={{ position: "absolute", inset: 0 }}>
            <circle cx="14" cy="14" r="12" stroke="rgba(119,229,68,0.2)" strokeWidth="2" />
            <circle
              cx="14" cy="14" r="12"
              stroke="#77E544" strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 12}`}
              strokeDashoffset={allDone ? 0 : `${2 * Math.PI * 12 * 0.25}`}
              style={{ transformOrigin: "center", transform: "rotate(-90deg)", transition: "stroke-dashoffset 0.4s ease" }}
              className={allDone ? undefined : "dl-ring-spin"}
            />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#77E544" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
        </div>
        <span style={{ flex: 1, fontSize: "14px", fontWeight: 600, color: "#ffffff", letterSpacing: "-0.01em" }}>{title}</span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2.5" strokeLinecap="round"
          style={{ flexShrink: 0, transition: "transform 200ms", transform: collapsed ? "rotate(180deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      {/* Items */}
      {!collapsed && (
        <div style={{ padding: "0 8px 8px" }}>
          {downloads.map(task => (
            <div key={task.id} style={{
              display:       "flex",
              alignItems:    "center",
              gap:           "10px",
              padding:       "9px 10px",
              background:    "rgba(255,255,255,0.035)",
              borderRadius:  "10px",
              marginBottom:  "4px",
            }}>
              {/* File icon */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={task.status === "preparing" ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.45)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M3 6h18M3 12h18M3 18h18" />
                <rect x="2" y="4" width="20" height="16" rx="2" />
              </svg>
              {/* Label */}
              <span style={{ flex: 1, fontSize: "13px", color: task.status === "preparing" ? "rgba(255,255,255,0.35)" : "#ffffff", letterSpacing: "-0.01em" }}>
                {task.status === "preparing" ? "Preparing…" : task.status === "error" ? "Failed" : "Ready"}
              </span>
              {/* Status indicator */}
              {task.status === "preparing" ? (
                <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: "2px solid rgba(255,255,255,0.12)", borderTopColor: "rgba(255,255,255,0.45)", animation: "spin 0.9s linear infinite", flexShrink: 0 }} />
              ) : task.status === "error" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
                </svg>
              ) : (
                <div style={{ width: "20px", height: "20px", borderRadius: "50%", background: "#77E544", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#060A06" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function Lightbox({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const [visible, setVisible]       = useState(false);
  const [fullLoaded, setFullLoaded] = useState(false);

  useEffect(() => { const id = requestAnimationFrame(() => setVisible(true)); return () => cancelAnimationFrame(id); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => { setVisible(false); setTimeout(onClose, 200); };
  const meta = [item.model, item.aspect_ratio, item.quality?.toUpperCase()].filter(Boolean).join(" · ");

  return createPortal(
    <div onClick={handleClose} style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: `rgba(0,0,0,${visible ? 0.88 : 0})`,
      backdropFilter: visible ? "blur(12px)" : "none",
      WebkitBackdropFilter: visible ? "blur(12px)" : "none",
      transition: "background 200ms ease, backdrop-filter 200ms ease",
      padding: "24px",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        position: "relative",
        maxWidth: "min(1200px, calc(100vw - 48px))", maxHeight: "calc(100vh - 120px)",
        transform: visible ? "scale(1)" : "scale(0.96)", transition: "transform 200ms ease",
        borderRadius: "10px", overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.8)",
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/_next/image?url=${encodeURIComponent(item.url)}&w=828&q=75`} alt="" aria-hidden style={{
          display: "block", maxWidth: "min(1200px, calc(100vw - 48px))", maxHeight: "calc(100vh - 120px)",
          width: "100%", height: "auto", objectFit: "contain",
          filter: fullLoaded ? "none" : "blur(12px)", transform: fullLoaded ? "scale(1)" : "scale(1.04)",
          transition: "filter 320ms ease, transform 320ms ease",
        }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.url} alt={item.prompt ?? ""} onLoad={() => setFullLoaded(true)} style={{
          position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", objectFit: "contain",
          opacity: fullLoaded ? 1 : 0, transition: "opacity 320ms ease",
        }} />
      </div>
      {(item.prompt || meta) && (
        <div onClick={e => e.stopPropagation()} style={{
          marginTop: "14px", maxWidth: "min(1200px, calc(100vw - 48px))", width: "100%",
          opacity: visible ? 1 : 0, transition: "opacity 250ms ease 100ms",
        }}>
          {item.prompt && <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.6)", lineHeight: 1.5, marginBottom: meta ? "5px" : 0, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{item.prompt}</p>}
          {meta && <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.25)" }}>{meta}</p>}
        </div>
      )}
      <button onClick={handleClose} style={{
        position: "fixed", top: "16px", right: "16px", width: "34px", height: "34px", borderRadius: "50%",
        border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.5)", color: "rgba(255,255,255,0.6)",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        opacity: visible ? 1 : 0, transition: "opacity 200ms ease, background 150ms",
      }}
        onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(0,0,0,0.5)"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>,
    document.body,
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: Tab }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "320px", gap: "10px" }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#252523" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        {tab === "images" ? (
          <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>
        ) : (
          <><rect x="2" y="5" width="15" height="14" rx="2" /><path d="m17 8 5-3v14l-5-3V8Z" /></>
        )}
      </svg>
      <p style={{ color: "#3A3A38", fontSize: "13px" }}>No {tab === "images" ? "images" : "videos"} yet</p>
      <p style={{ color: "#252523", fontSize: "11px" }}>Use the prompt below to generate your first {tab === "images" ? "image" : "video"}</p>
    </div>
  );
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const GALLERY_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes dlRingSpin {
    from { stroke-dashoffset: 75.4; transform: rotate(-90deg); }
    to   { stroke-dashoffset: 0;    transform: rotate(270deg); }
  }
  .dl-ring-spin { animation: dlRingSpin 1.4s linear infinite; transform-origin: center; }
  @keyframes dropIn {
    from { opacity: 0; transform: translateY(6px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)   scale(1);    }
  }
  @keyframes shimmer {
    0%   { background-position: -400px 0; }
    100% { background-position:  400px 0; }
  }
  @keyframes refImgIn {
    from { opacity: 0; transform: translateY(14px) scale(0.91); }
    to   { opacity: 1; transform: translateY(0)    scale(1);    }
  }
  .gallery-zoom-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 90px;
    height: 3px;
    border-radius: 2px;
    background: rgba(255,255,255,0.14);
    outline: none;
    cursor: pointer;
  }
  .gallery-zoom-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: #ffffff;
    cursor: pointer;
    transition: transform 120ms;
  }
  .gallery-zoom-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
  .gallery-zoom-slider::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: #ffffff;
    cursor: pointer;
    border: none;
  }
  .gallery-item {
    position: relative;
    overflow: hidden;
    cursor: pointer;
    background: #111416;
    width: 100%;
  }
  .gallery-actions-top {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    opacity: 0;
    transition: opacity 180ms ease;
    z-index: 5;
    pointer-events: none;
  }
  .gallery-item:hover .gallery-actions-top {
    opacity: 1;
    pointer-events: auto;
  }
  .gallery-action-btn {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(0,0,0,0.62);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: rgba(255,255,255,0.8);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms, color 120ms;
    flex-shrink: 0;
    padding: 0;
  }
  .gallery-action-btn:hover {
    background: rgba(255,255,255,0.16);
    color: #ffffff;
  }
  .gallery-delete-btn:hover {
    background: rgba(255,255,255,0.16);
    color: #ef4444 !important;
  }
  .gallery-actions-bottom {
    position: absolute;
    bottom: 10px;
    left: 10px;
    opacity: 0;
    transition: opacity 180ms ease;
    z-index: 5;
    pointer-events: none;
  }
  .gallery-item:hover .gallery-actions-bottom {
    opacity: 1;
    pointer-events: auto;
  }
  .gallery-ref-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 11px 5px 9px;
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(0,0,0,0.62);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: #ffffff;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 120ms;
    font-family: inherit;
    letter-spacing: -0.01em;
    white-space: nowrap;
    padding: 5px 11px 5px 9px;
  }
  .gallery-ref-btn:hover {
    background: rgba(255,255,255,0.16);
  }
  .gallery-shimmer {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, #111416 25%, #1a1d20 50%, #111416 75%);
    background-size: 800px 100%;
    animation: shimmer 1.6s infinite linear;
  }
  .gallery-item img, .gallery-item video { display: block; width: 100%; height: auto; }
  [data-at-menu] { font-family: inherit; }
  .gallery-overlay {
    position: absolute; inset: 0;
    background: linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 55%);
    opacity: 0; transition: opacity 180ms ease;
    display: flex; flex-direction: column; justify-content: flex-end; padding: 10px;
  }
  .gallery-item:hover .gallery-overlay { opacity: 1; }
  .gallery-play-icon {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 36px; height: 36px; border-radius: 50%;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity 180ms ease; pointer-events: none;
  }
  .gallery-item:hover .gallery-play-icon { opacity: 1; }
`;
