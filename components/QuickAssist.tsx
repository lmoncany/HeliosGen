"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { getToken } from "@/lib/galleryUtils";

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

const SYSTEM_PROMPT = `
You are an elite AI prompt crafter specialized in image and video generation prompts.

Your ONLY job is to help users craft, improve, or generate prompts for AI image and video generation models.

STRICT SCOPE RULE:
- If the user asks ANYTHING outside of prompt crafting, prompt improvement, or image/video generation prompts (e.g. coding, general knowledge, math, writing, advice, opinions, or any unrelated topic), you MUST refuse politely and say exactly this:
  "I'm a prompt crafting assistant. I can only help you create or improve prompts for AI image and video generation. Share an idea and I'll craft the perfect prompt for you!"
- Do NOT answer off-topic questions under any circumstance.

For on-topic requests (prompt crafting and generation):

- If the user provides a prompt or idea:
  - Return ONLY the improved prompt
  - Do NOT add introductions
  - Do NOT explain anything
  - Do NOT use quotes
  - Do NOT say "Here is the improved prompt"
  - Do NOT use markdown titles
  - Output the final optimized prompt directly

- If the user asks for help, inspiration, ideas, or does not provide enough details:
  - Create a complete original prompt based on their request
  - Make it creative, detailed, and visually powerful

- Always enhance:
  - visual details
  - lighting
  - atmosphere
  - composition
  - camera angles
  - cinematic feel
  - textures
  - colors
  - realism/stylization
  - motion (for video prompts)
  - environment details

- For video prompts:
  - include camera movement
  - motion details
  - pacing
  - cinematic transitions
  - environment animation
  - subject movement

- Adapt automatically to the requested style:
  - cinematic, anime, realistic, 3D, cyberpunk, fantasy, horror, luxury, fashion, advertisement, documentary, etc.

- Keep prompts concise but highly descriptive.
- Never ask follow-up questions.
- Always generate the best possible final prompt immediately.
`.trim();

const SUGGESTED = [
  "A luxury fashion portrait at golden hour",
  "Cinematic sci-fi city at night, rain",
  "Fantasy forest with glowing particles",
];

const MODEL_GROUPS = [
  {
    label: "Anthropic",
    models: [
      { id: "claude-opus-4-7",   label: "Opus 4.7",       desc: "Best"     },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6",     desc: "Powerful" },
      { id: "claude-haiku-4-5",  label: "Haiku 4.5",      desc: "Fast"     },
    ],
  },
  {
    label: "Google",
    models: [
      { id: "gemini-3.1-pro",  label: "Gemini 3.1 Pro", desc: "Pro"   },
      { id: "gemini-3-flash",  label: "Gemini Flash",   desc: "Fast"  },
    ],
  },
  {
    label: "OpenAI",
    models: [
      { id: "gpt-5-2", label: "GPT 5.2", desc: "Latest" },
    ],
  },
] as const;

const MODELS = MODEL_GROUPS.flatMap(g => g.models);
type ModelId = typeof MODELS[number]["id"];

export function QuickAssist() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<ModelId>("claude-sonnet-4-6");
  const [modelOpen, setModelOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === "Escape") { setOpen(false); setModelOpen(false); }
    }
    function onPointer(e: PointerEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-model-picker]")) setModelOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages([...newMessages, { role: "assistant", content: "", streaming: true }]);
    setInput("");
    setStreaming(true);

    const assistantIdx = newMessages.length;
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const token = await getToken();
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...newMessages.map(m => ({ role: m.role, content: m.content })),
          ],
          stream: true,
          thinkingFlag: true,
          max_tokens: 1024,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => "Unknown error");
        setMessages(prev =>
          prev.map((m, i) => i === assistantIdx ? { ...m, content: `Error: ${err}`, streaming: false } : m)
        );
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Accumulate into buffer so lines split across chunks are handled correctly
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? ""; // keep any incomplete trailing line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") continue;
          try {
            const parsed = JSON.parse(json);
            // Claude SSE format
            const claudeChunk = parsed.type === "content_block_delta" ? parsed.delta?.text : null;
            // OpenAI/Gemini SSE format
            const openaiChunk = parsed.choices?.[0]?.delta?.content ?? null;
            const chunk = claudeChunk ?? openaiChunk ?? null;
            if (chunk) {
              accumulated += chunk;
              setMessages(prev =>
                prev.map((m, i) => i === assistantIdx ? { ...m, content: accumulated } : m)
              );
            }
          } catch { /* skip malformed lines */ }
        }
      }

      setMessages(prev =>
        prev.map((m, i) => i === assistantIdx ? { ...m, streaming: false } : m)
      );
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError") {
        setMessages(prev =>
          prev.map((m, i) => i === assistantIdx ? { ...m, content: "Request failed.", streaming: false } : m)
        );
      }
    } finally {
      setStreaming(false);
    }
  }, [messages, streaming, model]);

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
    if (e.key === "Escape") setOpen(false);
  }

  const isEmpty = messages.length === 0;

  return (
    <>
      {/* Floating trigger pill */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: "fixed",
          bottom: "8px",
          right: "24px",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "0 16px 0 12px",
          height: "40px",
          borderRadius: "999px",
          background: "rgba(22,24,27,0.95)",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.55), 0 1px 4px rgba(0,0,0,0.3)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          color: "rgba(255,255,255,0.88)",
          fontSize: "13.5px",
          fontWeight: 500,
          fontFamily: "inherit",
          letterSpacing: "-0.01em",
          cursor: "pointer",
          transition: "background 150ms, border-color 150ms",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(32,35,40,0.98)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(22,24,27,0.95)"; }}
      >
        <SpinnerIcon />
        <span>Prompt Crafter</span>
        <span style={{
          marginLeft: "2px",
          padding: "2px 6px",
          borderRadius: "6px",
          background: "rgba(255,255,255,0.08)",
          fontSize: "11px",
          color: "rgba(255,255,255,0.45)",
          fontWeight: 500,
        }}>⌘K</span>
      </button>

      {/* Panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: "56px",
            right: "24px",
            zIndex: 1001,
            width: "380px",
            maxHeight: "560px",
            display: "flex",
            flexDirection: "column",
            borderRadius: "20px",
            background: "rgba(14,16,18,0.97)",
            border: "1px solid rgba(255,255,255,0.09)",
            boxShadow: "0 32px 80px rgba(0,0,0,0.8), 0 4px 24px rgba(0,0,0,0.5)",
            backdropFilter: "blur(40px)",
            WebkitBackdropFilter: "blur(40px)",
            overflow: "hidden",
            animation: "qaSlideUp 180ms cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          {/* Header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 16px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            flexShrink: 0,
          }}>
            <SpinnerIcon color="rgba(255,80,140,0.85)" />
            <span style={{ marginLeft: "8px", fontSize: "14px", fontWeight: 600, color: "#fff", letterSpacing: "-0.02em" }}>
              Prompt Crafter
            </span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
              {!isEmpty && (
                <button
                  onClick={() => { abortRef.current?.abort(); setMessages([]); setInput(""); setStreaming(false); }}
                  title="New chat"
                  style={{
                    width: "28px", height: "28px",
                    borderRadius: "8px",
                    border: "none",
                    background: "rgba(255,255,255,0.06)",
                    color: "rgba(255,255,255,0.45)",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 0,
                    transition: "background 120ms, color 120ms",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.11)"; (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.9)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.45)"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5H9a7 7 0 1 0 6.928 8" /><path d="M15 2l4 3-4 3" />
                  </svg>
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                style={{
                  width: "28px", height: "28px",
                  borderRadius: "8px",
                  border: "none",
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(255,255,255,0.45)",
                  cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0,
                  transition: "background 120ms, color 120ms",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.11)"; (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.9)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.45)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: isEmpty ? "32px 24px 16px" : "16px",
              display: "flex",
              flexDirection: "column",
              gap: isEmpty ? "0" : "12px",
            }}
          >
            {isEmpty ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                <div style={{
                  width: "52px", height: "52px",
                  borderRadius: "14px",
                  background: "rgba(255,80,140,0.1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: "16px",
                }}>
                  <SpinnerIcon size={22} color="rgba(255,80,140,0.85)" />
                </div>
                <p style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 700, color: "#fff", letterSpacing: "-0.02em" }}>
                  Craft your prompt
                </p>
                <p style={{ margin: "0 0 24px", fontSize: "13px", color: "rgba(255,255,255,0.4)", lineHeight: 1.5, letterSpacing: "-0.01em" }}>
                  Describe your idea — get a cinematic, detailed prompt ready to generate.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
                  {SUGGESTED.map(s => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "11px 14px",
                        borderRadius: "11px",
                        border: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.04)",
                        color: "rgba(255,255,255,0.75)",
                        fontSize: "13px",
                        fontFamily: "inherit",
                        cursor: "pointer",
                        textAlign: "left",
                        letterSpacing: "-0.01em",
                        transition: "background 120ms, border-color 120ms, color 120ms",
                      }}
                      onMouseEnter={e => { const b = e.currentTarget; b.style.background = "rgba(255,255,255,0.08)"; b.style.color = "#fff"; b.style.borderColor = "rgba(255,255,255,0.14)"; }}
                      onMouseLeave={e => { const b = e.currentTarget; b.style.background = "rgba(255,255,255,0.04)"; b.style.color = "rgba(255,255,255,0.75)"; b.style.borderColor = "rgba(255,255,255,0.08)"; }}
                    >
                      {s}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.4, flexShrink: 0 }}>
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{
                    maxWidth: "85%",
                    padding: "9px 13px",
                    borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                    background: m.role === "user" ? "rgba(255,80,140,0.15)" : "rgba(255,255,255,0.06)",
                    border: m.role === "user" ? "1px solid rgba(255,80,140,0.2)" : "1px solid rgba(255,255,255,0.07)",
                    fontSize: "13px",
                    color: m.role === "user" ? "rgba(255,200,220,0.95)" : "rgba(255,255,255,0.85)",
                    lineHeight: 1.55,
                    letterSpacing: "-0.01em",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}>
                    {m.content}
                    {m.streaming && !m.content && (
                      <span style={{ display: "inline-flex", gap: "3px", alignItems: "center" }}>
                        {[0, 1, 2].map(d => (
                          <span key={d} style={{
                            width: "4px", height: "4px", borderRadius: "50%",
                            background: "rgba(255,255,255,0.4)",
                            animation: `qaDot 1s ${d * 0.2}s infinite`,
                          }} />
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "12px", flexShrink: 0 }}>
            <div style={{
              display: "flex",
              alignItems: "flex-end",
              gap: "8px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: "12px",
              padding: "8px 8px 8px 12px",
            }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Describe your idea…"
                rows={1}
                disabled={streaming}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  color: "rgba(255,255,255,0.88)",
                  fontSize: "13.5px",
                  fontFamily: "inherit",
                  letterSpacing: "-0.01em",
                  lineHeight: "22px",
                  maxHeight: "96px",
                  overflowY: "auto",
                  padding: 0,
                  cursor: streaming ? "not-allowed" : "text",
                }}
                onInput={e => {
                  const t = e.currentTarget;
                  t.style.height = "auto";
                  t.style.height = Math.min(t.scrollHeight, 96) + "px";
                }}
              />
              <button
                onClick={() => send(input)}
                disabled={!input.trim() || streaming}
                style={{
                  width: "32px", height: "32px",
                  borderRadius: "8px",
                  border: "none",
                  background: input.trim() && !streaming ? "rgba(255,80,140,0.25)" : "rgba(255,255,255,0.07)",
                  color: input.trim() && !streaming ? "rgba(255,120,160,0.9)" : "rgba(255,255,255,0.25)",
                  cursor: input.trim() && !streaming ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0,
                  flexShrink: 0,
                  transition: "background 150ms, color 150ms",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "8px",
              padding: "0 2px",
            }}>
              <div data-model-picker="" style={{ position: "relative" }}>
                <button
                  onClick={() => setModelOpen(o => !o)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "2px 7px 2px 8px",
                    borderRadius: "6px",
                    background: modelOpen ? "rgba(255,255,255,0.09)" : "transparent",
                    border: "1px solid transparent",
                    fontSize: "10px",
                    color: "rgba(255,255,255,0.35)",
                    fontWeight: 500,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "background 120ms, color 120ms",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.09)"; (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.65)"; }}
                  onMouseLeave={e => { if (!modelOpen) { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.35)"; } }}
                >
                  {MODELS.find(m => m.id === model)?.label}
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ opacity: 0.6 }}>
                    <path d="m6 15 6-6 6 6" />
                  </svg>
                </button>
                {modelOpen && (
                  <div style={{
                    position: "absolute",
                    bottom: "calc(100% + 6px)",
                    left: 0,
                    minWidth: "160px",
                    background: "rgba(18,20,23,0.98)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "12px",
                    boxShadow: "0 -8px 32px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)",
                    overflow: "hidden",
                    zIndex: 10,
                    animation: "qaSlideDown 120ms cubic-bezier(0.16,1,0.3,1)",
                  }}>
                    <div style={{ padding: "4px" }}>
                      {MODEL_GROUPS.map((group, gi) => (
                        <div key={group.label}>
                          {gi > 0 && (
                            <div style={{ height: "1px", background: "rgba(255,255,255,0.07)", margin: "4px 0" }} />
                          )}
                          <div style={{ padding: "4px 8px 2px", fontSize: "10px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)" }}>
                            {group.label}
                          </div>
                          {group.models.map(m => (
                            <button
                              key={m.id}
                              onClick={() => { setModel(m.id); setModelOpen(false); }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                width: "100%",
                                padding: "7px 8px",
                                borderRadius: "7px",
                                border: "none",
                                background: model === m.id ? "rgba(255,80,140,0.12)" : "transparent",
                                color: model === m.id ? "rgba(255,180,210,0.95)" : "rgba(255,255,255,0.7)",
                                fontSize: "13px",
                                fontFamily: "inherit",
                                cursor: "pointer",
                                textAlign: "left",
                                transition: "background 100ms",
                              }}
                              onMouseEnter={e => { if (model !== m.id) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
                              onMouseLeave={e => { if (model !== m.id) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                            >
                              <span>{m.label}</span>
                              <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginLeft: "8px" }}>{m.desc}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", letterSpacing: "0.03em", display: "flex", gap: "8px", alignItems: "center" }}>
                <span style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  <kbd style={{ padding: "1px 4px", borderRadius: "4px", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>↵</kbd>
                  SEND
                </span>
                <span>·</span>
                <span style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  <kbd style={{ padding: "1px 4px", borderRadius: "4px", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>ESC</kbd>
                  CLOSE
                </span>
              </span>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes qaSlideUp {
          from { opacity: 0; transform: translateY(12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes qaSlideDown {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes qaDot {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </>
  );
}

function SpinnerIcon({ size = 14, color = "rgba(255,255,255,0.7)" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
