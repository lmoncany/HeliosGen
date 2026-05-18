import { create } from "zustand";
import { getToken } from "./galleryUtils";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { useChatSessionStore, type StoredMessage } from "./chatSessionStore";
import { useWorkflowStore } from "./store";

export interface StreamState {
  content: string;
  status: "streaming" | "done" | "error";
}

interface StartStreamParams {
  sessionId: string;
  apiMessages: { role: string; content: string }[];
  model: string;
  contextMessages: StoredMessage[];
}

interface ChatStreamingState {
  streams: Record<string, StreamState>;
  startStream: (params: StartStreamParams) => void;
  clearStream: (sessionId: string) => void;
}

export const useChatStreamingStore = create<ChatStreamingState>()((set, get) => ({
  streams: {},

  clearStream: (sessionId) => {
    set((s) => {
      const { [sessionId]: _, ...rest } = s.streams;
      return { streams: rest };
    });
  },

  startStream: ({ sessionId, apiMessages, model, contextMessages }) => {
    if (get().streams[sessionId]?.status === "streaming") return;

    set((s) => ({ streams: { ...s.streams, [sessionId]: { content: "", status: "streaming" } } }));

    (async () => {
      try {
        const token = await getToken();
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ model, messages: apiMessages, stream: true }),
        });

        if (!res.ok || !res.body) {
          const err = await res.text().catch(() => "Unknown error");
          set((s) => ({ streams: { ...s.streams, [sessionId]: { content: `Error: ${err}`, status: "error" } } }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (json === "[DONE]") continue;
            try {
              const parsed = JSON.parse(json);
              const chunk =
                (parsed.type === "content_block_delta" ? parsed.delta?.text : null) ??
                parsed.choices?.[0]?.delta?.content ??
                null;
              if (chunk) {
                accumulated += chunk;
                set((s) => ({
                  streams: { ...s.streams, [sessionId]: { content: accumulated, status: "streaming" } },
                }));
              }
            } catch { /* skip malformed SSE */ }
          }
        }

        const finalMessages: StoredMessage[] = [
          ...contextMessages,
          { role: "assistant", content: accumulated },
        ];
        useChatSessionStore.getState().upsertSession(sessionId, finalMessages, model);
        set((s) => ({ streams: { ...s.streams, [sessionId]: { content: accumulated, status: "done" } } }));

        // Notify if user has navigated away from this chat
        const isViewingChat =
          window.location.pathname === "/chat" &&
          new URLSearchParams(window.location.search).get("id") === sessionId;
        if (!isViewingChat) {
          const sessionTitle = useChatSessionStore.getState().sessions.find((s) => s.id === sessionId)?.title ?? "Chat";
          const preview = accumulated.slice(0, 100).replace(/\n+/g, " ");
          useWorkflowStore.getState().addToast(
            "Response ready",
            "success",
            `/chat?id=${sessionId}`,
            sessionTitle,
            preview,
          );
        }
      } catch (err: unknown) {
        if ((err as Error)?.name !== "AbortError") {
          set((s) => ({
            streams: { ...s.streams, [sessionId]: { content: "Request failed.", status: "error" } },
          }));
        }
      }
    })();
  },
}));
