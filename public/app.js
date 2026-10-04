import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";

const SAMPLE_RATE = 24000;
// GPT-6.1 Sol takes low to max; it rejects "none".
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// GPT-6.1 Sol only; src/settings-store.js says why. Model names as OpenAI
// lists them; Fast mode is a separate switch.
const OPENAI_AGENT_MODELS = ["gpt-6.1-sol"];
const CODEX_AGENT_MODELS = ["gpt-6.1-sol"];
// Models OpenAI serves for realtime transcription sessions (October 2026).
const OPENAI_TRANSCRIPTION_MODELS = ["gpt-live-transcribe", "gpt-realtime-whisper"];
const LANGUAGE_LABELS = {
  en: "English",
  ru: "Русский",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  zh: "中文",
  pt: "Português",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
  uk: "Українська",
  pl: "Polski",
  tr: "Türkçe",
  nl: "Nederlands",
  ar: "العربية",
  // Deepgram's nova-3 "multi": several languages mixed in one talk.
  multi: "Mixed languages",
};
const DEEPGRAM_TRANSCRIPTION_MODELS = ["nova-3", "nova-2"];
// Free-text, not a dropdown: OpenRouter's catalogue changes weekly and a fixed
// list here would be wrong within the month.
const OPENROUTER_MODEL_PLACEHOLDER = "e.g. x-ai/grok-4.20";
// Free-text as well: xAI ships a new Grok every few months.
const XAI_MODEL_PLACEHOLDER = "e.g. grok-4.3";
// xAI's one streaming speech-to-text model (src/xai-transcription.js).
const XAI_TRANSCRIPTION_MODEL = "grok-voice-transcribe-2.0";
const MIC_STORAGE_KEY = "micdraw.mic";
const PANEL_HIDDEN_STORAGE_KEY = "micdraw.panelHidden";
// The live board recenters while it is this small: Go Live and Reset
// session clear it, so its first elements land in view.
const RECENTER_MAX_ELEMENTS = 4;

function fullscreenIcon(isFullscreen) {
  const paths = isFullscreen
    ? ["M3 6 H6 V3", "M10 3 V6 H13", "M13 10 H10 V13", "M6 13 V10 H3"]
    : ["M3 6 V3 H6", "M10 3 H13 V6", "M13 10 V13 H10", "M6 13 H3 V10"];
  return React.createElement(
    "svg",
    {
      width: "1em",
      height: "1em",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...paths.map((d, i) => React.createElement("path", { key: i, d })),
  );
}

function loadStoredMic() {
  try {
    const raw = localStorage.getItem(MIC_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { deviceId: "", label: "" };
  } catch {
    return { deviceId: "", label: "" };
  }
}

function saveStoredMic(mic) {
  localStorage.setItem(MIC_STORAGE_KEY, JSON.stringify(mic));
}

function loadStoredPanelHidden() {
  try {
    return localStorage.getItem(PANEL_HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function App() {
  const [mode, setMode] = React.useState("staging");
  const [listening, setListening] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [goingLive, setGoingLive] = React.useState(false);
  const [agentStatus, setAgentStatus] = React.useState("idle");
  const [transcriptionEngine, setTranscriptionEngine] =
    React.useState("loading");
  const [transcriptionStatus, setTranscriptionStatus] = React.useState(null);
  const [settings, setSettings] = React.useState(null);
  const [localModels, setLocalModels] = React.useState([]);
  // Languages each transcription provider offers, from /api/config.
  const [languages, setLanguages] = React.useState({ local: ["en"] });
  const [captionText, setCaptionText] = React.useState("");
  const [error, setError] = React.useState("");
  const [micError, setMicError] = React.useState(false);
  const [agentError, setAgentError] = React.useState(false);
  const [sttError, setSttError] = React.useState(false);
  const [expandedRow, setExpandedRow] = React.useState(null);
  const [mic, setMic] = React.useState(loadStoredMic);
  const [panelHidden, setPanelHidden] = React.useState(loadStoredPanelHidden);
  const [analyser, setAnalyser] = React.useState(null);
  const [resetConfirming, setResetConfirming] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  // warmupState: { state: "idle"|"running"|"confirmed"|"exhausted"|"cancelled", attempt, maxAttempts }
  const [warmupState, setWarmupState] = React.useState({
    state: "idle",
    attempt: 0,
    maxAttempts: 8,
  });
  const [agentInstructions, setAgentInstructionsValue] = React.useState("");
  const [cost, setCost] = React.useState(null);
  const audioSessionRef = React.useRef(null);
  const apiRef = React.useRef(null);
  const wsRef = React.useRef(null);
  const modeRef = React.useRef("staging");
  const stagingSceneRef = React.useRef([]);
  const screenshotTimerRef = React.useRef(null);
  const captionTimerRef = React.useRef(null);
  const resetConfirmTimerRef = React.useRef(null);
  const shellRef = React.useRef(null);
  const userElementsSyncTimerRef = React.useRef(null);
  const lastSyncedElementsHashRef = React.useRef("");
  // Set by a pointer press on the canvas: the next canvas change is the
  // user's own edit rather than the page drawing the agent's board.
  const userTouchedCanvasRef = React.useRef(false);
  const listeningRef = React.useRef(false);
  // Seed the textarea once from settings, then let the user own it locally so
  // their keystrokes don't fight the WS settings broadcast we trigger on save.
  const agentInstructionsSeededRef = React.useRef(false);
  const agentInstructionsSaveTimerRef = React.useRef(null);
  const agentInstructionsSavePromiseRef = React.useRef(Promise.resolve());

  React.useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  React.useEffect(() => {
    try {
      localStorage.setItem(PANEL_HIDDEN_STORAGE_KEY, panelHidden ? "1" : "0");
    } catch {}
  }, [panelHidden]);
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  React.useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      shellRef.current?.requestFullscreen?.();
    }
  }

  React.useEffect(() => {
    return () => {
      clearTimeout(screenshotTimerRef.current);
      clearTimeout(captionTimerRef.current);
      clearTimeout(resetConfirmTimerRef.current);
      clearTimeout(userElementsSyncTimerRef.current);
      clearTimeout(agentInstructionsSaveTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (agentInstructionsSeededRef.current) return;
    if (!settings || typeof settings.agentInstructions !== "string") return;
    setAgentInstructionsValue(settings.agentInstructions);
    agentInstructionsSeededRef.current = true;
  }, [settings]);

  function handleAgentInstructionsChange(value) {
    setAgentInstructionsValue(value);
    clearTimeout(agentInstructionsSaveTimerRef.current);
    agentInstructionsSaveTimerRef.current = setTimeout(() => {
      agentInstructionsSaveTimerRef.current = null;
      agentInstructionsSavePromiseRef.current = saveSettings({
        agentInstructions: value,
      }).catch((err) => setError(err.message));
    }, 600);
  }

  async function flushAgentInstructionsSave() {
    clearTimeout(agentInstructionsSaveTimerRef.current);
    agentInstructionsSaveTimerRef.current = null;
    await agentInstructionsSavePromiseRef.current;
    agentInstructionsSavePromiseRef.current = saveSettings({
      agentInstructions,
    });
    await agentInstructionsSavePromiseRef.current;
  }

  function handleExcalidrawChange(elements) {
    // Only push user edits to the server while in live mode. In staging the
    // canvas is a client-side scratchpad; the server doesn't need to know.
    if (modeRef.current !== "live") return;
    // Once listening starts, the agent owns the canvas. Echoing user-elements
    // back creates an ID-rotation feedback loop: applyScene re-runs
    // convertToExcalidrawElements, which assigns fresh IDs, which propagate
    // back via onChange, which break the agent's cache prefix and confuse
    // line-numbered references. Sync only during the pre-listen window.
    if (listeningRef.current) return;
    // Changes the page made itself, drawing the agent's board, must not go
    // back: the server would swap the agent's compact elements for
    // Excalidraw's expanded ones and every later turn would carry the bloat
    // (#41). Only a canvas the user touched has edits worth sending.
    if (!userTouchedCanvasRef.current) return;
    clearTimeout(userElementsSyncTimerRef.current);
    userElementsSyncTimerRef.current = setTimeout(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const cleaned = nativeElementsToSkeletonForSync(elements ?? []);
      const hash = JSON.stringify(cleaned);
      if (hash === lastSyncedElementsHashRef.current) return;
      lastSyncedElementsHashRef.current = hash;
      userTouchedCanvasRef.current = false;
      ws.send(
        JSON.stringify({ type: "whiteboard:user-elements", elements: cleaned }),
      );
    }, 500);
  }

  // Persistent WebSocket connection for the lifetime of the app.
  React.useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "config")
        setTranscriptionEngine(message.transcriptionEngine);
      if (message.type === "transcription:status") {
        setTranscriptionStatus(message);
        if (message.state === "ready") setSttError(false);
      }
      if (message.type === "settings") setSettings(message.settings);
      if (message.type === "transcript:partial") {
        const text = (message.text ?? "").trim();
        if (text) {
          clearTimeout(captionTimerRef.current);
          setCaptionText(text);
        }
      }
      if (message.type === "transcript:committed") {
        const text = (message.text ?? "").trim();
        if (text) {
          clearTimeout(captionTimerRef.current);
          setCaptionText(text);
          captionTimerRef.current = setTimeout(() => setCaptionText(""), 3500);
        }
      }
      if (message.type === "agent:status") {
        setAgentStatus(message.status);
        if (message.status === "thinking") setAgentError(false);
      }
      if (message.type === "warmup") {
        setWarmupState({
          state: message.state,
          attempt: message.attempt ?? 0,
          maxAttempts: message.maxAttempts ?? 8,
        });
      }
      if (message.type === "cost") {
        setCost({ agent: message.agent, transcription: message.transcription });
      }
      if (message.type === "mode") {
        const previousMode = modeRef.current;
        modeRef.current = message.mode;
        setMode(message.mode);
        if (message.mode === "staging" && previousMode === "live") {
          // Returning from live: restore the staged canvas the user was last working on.
          applyScene(stagingSceneRef.current, { recenter: true });
        }
      }
      if (message.type === "whiteboard:update") {
        const isSmall =
          Array.isArray(message.elements) &&
          message.elements.length <= RECENTER_MAX_ELEMENTS;
        applyScene(message.elements, { recenter: isSmall });
      }
      if (message.type === "whiteboard:viewport")
        applyWhiteboardViewportCommand(message);
      if (message.type === "error") {
        setError(message.message);
        if (message.source === "agent") setAgentError(true);
        else setSttError(true);
      }
    });

    ws.addEventListener("close", () => {
      // Nothing reconnects, so release the microphone too.
      stopListening();
      setListening(false);
      setStarting(false);
      setAgentStatus("idle");
    });

    ws.addEventListener("error", () => {
      setError("Lost connection to the server.");
    });

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((config) => {
        setTranscriptionEngine(config.transcriptionEngine);
        setTranscriptionStatus(config.transcriptionStatus ?? null);
        if (config.settings) setSettings(config.settings);
        setLocalModels(config.localModels ?? []);
        setLanguages(config.languages ?? { local: ["en"] });
      })
      .catch((err) => setError(err.message));
  }, []);

  async function saveSettings(patch) {
    setError("");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to save settings");
    setSettings(body.settings);
    setTranscriptionEngine(body.transcriptionEngine);
    setTranscriptionStatus(body.transcriptionStatus ?? null);
    setSttError(false);
    setAgentError(false);
  }

  async function cancelWarmup() {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "warmup:cancel" }));
    }
  }

  async function startAnyway() {
    // One-click: cancel the warmup loop and start listening right away. The
    // first turn may be slower (cold cache), but the user explicitly opted in.
    await cancelWarmup();
    await startListening();
  }

  async function startListening() {
    if (listening || starting) return;
    if (modeRef.current !== "live") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Connection not ready yet.");
      return;
    }
    setError("");
    setMicError(false);
    setSttError(false);
    setStarting(true);

    let media = null;
    let audio = null;
    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (mic.deviceId) audioConstraints.deviceId = { exact: mic.deviceId };
      media = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      const audioSessionId = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "audio:start", sessionId: audioSessionId }));
      audio = await createAudioStreamer(media, (audioBase64) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", sessionId: audioSessionId, audio: audioBase64 }));
        }
      });
      setAnalyser(audio.analyser);
      audioSessionRef.current = { media, audio, id: audioSessionId };
      setListening(true);
      setStarting(false);
    } catch (err) {
      setError(err.message);
      setMicError(true);
      setStarting(false);
      media?.getTracks().forEach((track) => track.stop());
      await audio?.close();
    }
  }

  async function stopListening() {
    const session = audioSessionRef.current;
    audioSessionRef.current = null;
    if (!session) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop", sessionId: session.id }));
    }
    session.media.getTracks().forEach((track) => track.stop());
    await session.audio.close();
    setAnalyser(null);
    setListening(false);
    setCaptionText("");
    clearTimeout(captionTimerRef.current);
    setAgentStatus("idle");
  }

  function toggleListening() {
    if (listening) stopListening();
    else startListening();
  }

  async function goLive() {
    if (goingLive) return;
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI) {
      setError("Canvas isn't ready yet.");
      return;
    }
    setError("");
    setGoingLive(true);
    try {
      await flushAgentInstructionsSave();
      // Snapshot what the user has on the staging canvas right now.
      const stagingNative = excalidrawAPI
        .getSceneElements()
        .map((el) => ({ ...el }));
      stagingSceneRef.current = stagingNative;
      // Convert to the lean skeleton format before sending to the server. The
      // primer JSON is part of the cached prefix, so trimming volatile fields
      // (versionNonce, seed, internal binding details, etc.) shrinks the cold
      // turn footprint substantially without hurting the agent's understanding
      // of the staging layout.
      const stagingSkeleton = nativeElementsToSkeletonForSync(stagingNative);
      // Capture the full staging scene as an image so the primer carries it.
      let stagingScreenshot;
      try {
        stagingScreenshot = await captureStagingSceneAsImage(
          excalidrawAPI,
          stagingNative,
        );
      } catch (err) {
        console.warn(
          "Failed to capture staging screenshot, sending text-only primer:",
          err,
        );
      }

      const res = await fetch("/api/live/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stagingElements: stagingSkeleton,
          stagingScreenshot,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Go Live failed (${res.status})`);
      }
      // Server broadcasts mode=live and whiteboard:update; the WS handler swaps the canvas.
    } catch (err) {
      setError(err.message);
    } finally {
      setGoingLive(false);
    }
  }

  async function backToStaging() {
    setError("");
    if (listening) await stopListening();
    try {
      const res = await fetch("/api/live/back-to-staging", { method: "POST" });
      if (!res.ok) throw new Error(`Back to staging failed (${res.status})`);
      // Server broadcasts mode=staging; the WS handler restores the staged scene.
    } catch (err) {
      setError(err.message);
    }
  }

  function handleResetClick() {
    if (resetting) return;
    if (!resetConfirming) {
      setResetConfirming(true);
      resetConfirmTimerRef.current = setTimeout(
        () => setResetConfirming(false),
        3000,
      );
      return;
    }
    clearTimeout(resetConfirmTimerRef.current);
    setResetConfirming(false);
    resetSession();
  }

  async function resetSession() {
    setResetting(true);
    setError("");
    try {
      if (modeRef.current === "staging") {
        // Staging board lives on the client - just clear it.
        stagingSceneRef.current = [];
        applyScene([]);
      } else {
        if (listening) await stopListening();
        clearTimeout(captionTimerRef.current);
        setCaptionText("");
        const res = await fetch("/api/session/reset", { method: "POST" });
        if (!res.ok) throw new Error(`Reset failed (${res.status})`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  }

  function applyScene(elements, { recenter = false } = {}) {
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI || !Array.isArray(elements)) return;
    // What the page draws from here on is not a user edit.
    userTouchedCanvasRef.current = false;
    const looksNative =
      elements.length > 0 &&
      elements[0] &&
      typeof elements[0].versionNonce === "number";
    // CRITICAL: regenerateIds: false. Excalidraw's default is to throw away
    // user-provided ids and assign fresh nanoids. The agent references its
    // elements by stable ids (e.g. "openai-card") in whiteboard_viewport's
    // focus_ids; if we let Excalidraw rewrite them, the frontend's
    // scene.filter(el => focusIds.includes(el.id)) finds nothing and
    // scrollToContent silently fits the full canvas instead.
    const renderable = looksNative
      ? elements
      : convertToExcalidrawElements(elements, { regenerateIds: false });
    excalidrawAPI.updateScene({
      elements: renderable,
      appState: { viewBackgroundColor: "#fffdf8" },
    });
    if (recenter && renderable.length > 0) {
      // Defer so updateScene's commit is flushed before scrollToContent measures bounds.
      requestAnimationFrame(() =>
        excalidrawAPI.scrollToContent(undefined, { animate: false }),
      );
    }
    scheduleWhiteboardScreenshot();
  }

  function applyWhiteboardViewportCommand(command) {
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI) return;

    const action = command.action;
    if (action === "scroll_to_content") {
      const focusIds = Array.isArray(command.focus_ids)
        ? command.focus_ids
        : null;
      let target;
      if (focusIds && focusIds.length > 0) {
        const scene = excalidrawAPI.getSceneElements();
        const matched = scene.filter((el) => focusIds.includes(el.id));
        if (matched.length > 0) target = matched;
      }
      excalidrawAPI.scrollToContent(target, { animate: true });
    }
    if (action === "set_zoom") {
      setWhiteboardZoom(command.zoom);
    }
    if (action === "zoom_in") {
      setWhiteboardZoom(currentWhiteboardZoom() * 1.2);
    }
    if (action === "zoom_out") {
      setWhiteboardZoom(currentWhiteboardZoom() / 1.2);
    }
    if (action === "reset_zoom") {
      setWhiteboardZoom(1);
    }
    scheduleWhiteboardScreenshot();
  }

  function currentWhiteboardZoom() {
    return apiRef.current?.getAppState().zoom?.value ?? 1;
  }

  function setWhiteboardZoom(zoom) {
    const zoomValue = Math.min(3, Math.max(0.1, Number(zoom) || 1));
    apiRef.current?.updateScene({ appState: { zoom: { value: zoomValue } } });
  }

  function scheduleWhiteboardScreenshot() {
    clearTimeout(screenshotTimerRef.current);
    screenshotTimerRef.current = setTimeout(sendWhiteboardScreenshot, 500);
  }

  async function sendWhiteboardScreenshot() {
    if (modeRef.current !== "live") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const dataUrl = await captureCanvasDataUrl();
      if (!dataUrl) return;
      ws.send(
        JSON.stringify({ type: "whiteboard:screenshot", image: dataUrl }),
      );
    } catch (error) {
      console.warn("Failed to export whiteboard screenshot:", error);
    }
  }

  async function captureCanvasDataUrl() {
    const canvas = document.querySelector("canvas.excalidraw__canvas.static");
    if (!canvas) return null;
    const downscaled = await downscaleByHalf(canvas);
    return await blobToDataUrl(downscaled);
  }

  async function captureStagingSceneAsImage(excalidrawAPI, elements) {
    if (!Array.isArray(elements) || elements.length === 0) {
      // Empty staging - no scene to render. Skip the image entirely; the
      // server's primer already drops the image part when this is falsy.
      return null;
    }
    try {
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles?.() ?? {};
      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportBackground: true,
          viewBackgroundColor: "#fffdf8",
        },
        files,
        mimeType: "image/png",
      });
      const downscaled = await downscaleByHalf(blob);
      return await blobToDataUrl(downscaled);
    } catch (error) {
      console.warn(
        "Failed to export staging scene, falling back to viewport canvas:",
        error,
      );
      return captureCanvasDataUrl();
    }
  }

  // Excalidraw skips re-rendering while its props stay the same, so captions,
  // cost and status updates leave the canvas alone. The callbacks only touch
  // refs, so the first render's closures stay correct.
  const excalidrawProps = React.useMemo(
    () => ({
      excalidrawAPI: (excalidrawAPI) => {
        apiRef.current = excalidrawAPI;
      },
      initialData: {
        elements: [],
        appState: { viewBackgroundColor: "#fffdf8" },
      },
      onChange: handleExcalidrawChange,
      onPointerDown: () => {
        userTouchedCanvasRef.current = true;
      },
    }),
    [],
  );

  const isLive = mode === "live";
  const micState = micError ? "error" : listening ? "active" : "idle";
  const agentState = agentError
    ? "error"
    : agentStatus === "thinking"
      ? "active"
      : "idle";
  const voiceLoading =
    transcriptionStatus?.state === "preparing" ||
    transcriptionStatus?.state === "downloading";
  const sttState =
    sttError || transcriptionStatus?.state === "error"
      ? "error"
      : listening || voiceLoading
        ? "active"
        : "idle";
  const agentLabel = settings ? agentModelLabel(settings) : "loading...";
  const sttLabel = voiceRowLabel(
    settings
      ? sttModelLabel(settings, transcriptionEngine)
      : transcriptionEngine,
    transcriptionStatus,
  );
  const micLabel = mic.label || "System default";

  return React.createElement(
    "main",
    {
      className: `shell mode-${mode}${panelHidden ? " panel-hidden" : ""}`,
      ref: shellRef,
    },
    React.createElement(
      "section",
      { className: "canvas-wrap" },
      React.createElement(
        "button",
        {
          type: "button",
          className: "panel-toggle",
          onClick: () => setPanelHidden((v) => !v),
          title: panelHidden ? "Show settings panel" : "Hide settings panel",
          "aria-label": panelHidden
            ? "Show settings panel"
            : "Hide settings panel",
          "aria-expanded": !panelHidden,
        },
        React.createElement(
          "span",
          { className: "panel-toggle-icon", "aria-hidden": "true" },
          panelHidden ? "‹" : "›",
        ),
      ),
      React.createElement(Excalidraw, excalidrawProps),
      React.createElement(
        "div",
        {
          className: `stage-overlay ${(captionText || listening) && isLive ? "visible" : ""}`,
          "aria-hidden": "true",
        },
        captionText
          ? React.createElement(
              "div",
              {
                className: "caption-pill",
                role: "status",
                "aria-live": "polite",
              },
              truncateCaption(captionText),
            )
          : null,
        React.createElement(Waveform, { analyser, active: listening }),
      ),
    ),
    React.createElement(
      "aside",
      { className: "panel" },
      React.createElement(
        "div",
        { className: "brand" },
        React.createElement(
          "div",
          { className: "brand-row" },
          React.createElement("h1", null, "Mic Draw"),
          React.createElement(
            "div",
            {
              className: `mode-toggle mode-toggle-${mode}`,
              role: "group",
              "aria-label": "Mode",
            },
            React.createElement(
              "button",
              {
                type: "button",
                className: `mode-toggle-option ${mode === "staging" ? "active" : ""}`,
                onClick: () => {
                  if (mode !== "staging") backToStaging();
                },
                disabled: goingLive,
                title: "Staging mode",
                "aria-pressed": mode === "staging",
              },
              "Staging",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: `mode-toggle-option ${mode === "live" ? "active" : ""}`,
                onClick: () => {
                  if (mode !== "live") goLive();
                },
                disabled: goingLive,
                title: goingLive ? "Starting..." : "Live mode",
                "aria-pressed": mode === "live",
              },
              goingLive && mode === "staging" ? "..." : "Live",
            ),
          ),
        ),
        React.createElement(
          "p",
          null,
          mode === "staging"
            ? "Drop keywords, diagrams, or images on the canvas. They will be used as reference while you talk."
            : "Just talk through your ideas. Let the agent whiteboard for you.",
        ),
      ),
      React.createElement(
        "div",
        { className: "controls" },
        mode === "staging"
          ? React.createElement(
              "button",
              {
                className: "go-live",
                onClick: goLive,
                disabled: goingLive,
              },
              goingLive ? "Starting..." : "Go Live →",
            )
          : null,
        isLive
          ? React.createElement(
              "div",
              { className: "listen-controls" },
              React.createElement(
                "div",
                { className: "listen-row" },
                React.createElement(
                  "button",
                  {
                    className: `record-toggle ${listening ? "recording" : ""}`,
                    onClick: toggleListening,
                    disabled:
                      starting ||
                      (warmupState.state === "running" && !listening),
                    title:
                      warmupState.state === "running"
                        ? "Waiting for prompt cache to warm up"
                        : warmupState.state === "exhausted"
                          ? "Cache didn't fully prime; first turn may be slower"
                          : undefined,
                  },
                  React.createElement(
                    "span",
                    { className: "record-icon" },
                    listening ? "■" : "●",
                  ),
                  " ",
                  listening
                    ? "Stop"
                    : starting
                      ? "Starting..."
                      : warmupState.state === "running"
                        ? `Warming up... (${warmupState.attempt} / ${warmupState.maxAttempts})`
                        : "Start Talking",
                ),
                React.createElement(
                  "button",
                  {
                    className: "fullscreen-toggle",
                    onClick: toggleFullscreen,
                    title: isFullscreen
                      ? "Exit fullscreen (Esc)"
                      : "Fullscreen for screen sharing",
                    "aria-label": isFullscreen
                      ? "Exit fullscreen"
                      : "Enter fullscreen",
                  },
                  fullscreenIcon(isFullscreen),
                ),
              ),
              warmupState.state === "running" && !listening
                ? React.createElement(
                    "button",
                    {
                      className: "warmup-skip",
                      onClick: startAnyway,
                      title:
                        "Skip warmup and start listening now. The first turn may be slower.",
                    },
                    "Start Anyway →",
                  )
                : null,
              warmupState.state === "exhausted" && !listening
                ? React.createElement(
                    "div",
                    { className: "warmup-warning" },
                    "Cache didn't fully prime. First turn may be slower.",
                  )
                : null,
            )
          : null,
        React.createElement(
          "button",
          {
            className: `reset-session ${resetConfirming ? "confirming" : ""}`,
            onClick: handleResetClick,
            disabled: resetting,
            title:
              mode === "staging"
                ? "Clear the staging area"
                : "Clear the whiteboard and start a new session",
          },
          resetting
            ? "Resetting..."
            : resetConfirming
              ? "Click again to reset"
              : mode === "staging"
                ? "Reset Staging"
                : "Reset Session",
        ),
      ),
      React.createElement(
        "div",
        { className: "status-card" },
        statusRow({
          dotState: micState,
          label: "Mic",
          value: micLabel,
          expanded: expandedRow === "mic",
          onToggle: () => setExpandedRow(expandedRow === "mic" ? null : "mic"),
          editor: React.createElement(MicEditor, {
            currentDeviceId: mic.deviceId,
            onSave: (next) => {
              setMic(next);
              saveStoredMic(next);
              setExpandedRow(null);
            },
            onCancel: () => setExpandedRow(null),
          }),
        }),
        statusRow({
          dotState: sttState,
          label: "Voice",
          value: sttLabel,
          expanded: expandedRow === "stt",
          onToggle: () => setExpandedRow(expandedRow === "stt" ? null : "stt"),
          editor: settings
            ? React.createElement(TranscriptionEditor, {
                settings,
                localModels,
                languages,
                onSave: async (patch) => {
                  await saveSettings(patch);
                  setExpandedRow(null);
                },
                onCancel: () => setExpandedRow(null),
              })
            : null,
        }),
        statusRow({
          dotState: agentState,
          label: "Agent",
          value: agentLabel,
          expanded: expandedRow === "agent",
          onToggle: () =>
            setExpandedRow(expandedRow === "agent" ? null : "agent"),
          editor: settings
            ? React.createElement(AgentEditor, {
                settings,
                onSave: async (patch) => {
                  await saveSettings(patch);
                  setExpandedRow(null);
                },
                onCancel: () => setExpandedRow(null),
              })
            : null,
        }),
      ),
      isLive && cost ? React.createElement(CostCard, { cost }) : null,
      mode === "staging"
        ? React.createElement(
            "div",
            { className: "agent-instructions" },
            React.createElement(
              "label",
              {
                className: "agent-instructions-label",
                htmlFor: "agent-instructions-input",
              },
              "Agent instructions",
            ),
            React.createElement("textarea", {
              id: "agent-instructions-input",
              className: "agent-instructions-input",
              value: agentInstructions,
              onChange: (e) => handleAgentInstructionsChange(e.target.value),
              placeholder:
                "Optional. Tell the agent your preferences - e.g. 'Use a tight 4-color palette', 'Prefer drawings over text', 'Be funny'.",
              rows: 4,
              spellCheck: true,
            }),
            React.createElement(
              "p",
              { className: "agent-instructions-hint" },
              "Saved automatically. Takes effect on next Go Live.",
            ),
          )
        : null,
      error ? React.createElement("div", { className: "error" }, error) : null,
    ),
  );
}

const CAPTION_MAX_CHARS = 70;

function truncateCaption(text) {
  if (!text || text.length <= CAPTION_MAX_CHARS) return text;
  const tail = text.slice(-CAPTION_MAX_CHARS);
  const space = tail.indexOf(" ");
  return space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
}

function Waveform({ analyser, active }) {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    let raf = 0;
    let resizeObserver;
    let lastWidth = 0;
    let lastHeight = 0;
    let gradient = null;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, "rgba(56, 189, 248, 0)");
      gradient.addColorStop(0.15, "rgba(56, 189, 248, 0.95)");
      gradient.addColorStop(0.5, "rgba(168, 85, 247, 0.95)");
      gradient.addColorStop(0.85, "rgba(56, 189, 248, 0.95)");
      gradient.addColorStop(1, "rgba(56, 189, 248, 0)");
    };

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
    }
    resize();

    if (!analyser || !active) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return () => {
        if (resizeObserver) resizeObserver.disconnect();
      };
    }

    const data = new Uint8Array(analyser.fftSize);

    const draw = () => {
      analyser.getByteTimeDomainData(data);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const mid = h / 2;
      const amplitude = mid * 0.85;

      ctx.shadowColor = "rgba(56, 189, 248, 0.55)";
      ctx.shadowBlur = 22 * dpr;
      ctx.lineWidth = 2.4 * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = gradient;

      ctx.beginPath();
      const step = w / data.length;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        const x = i * step;
        const y = mid + v * amplitude;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      if (resizeObserver) resizeObserver.disconnect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [analyser, active]);

  return React.createElement("canvas", {
    ref: canvasRef,
    className: "waveform-canvas",
  });
}

function CostCard({ cost }) {
  const agent = cost.agent ?? {};
  const stt = cost.transcription ?? {};
  const total = (agent.priced ? agent.cost : 0) + (stt.priced ? stt.cost : 0);
  return React.createElement(
    "div",
    { className: "cost-card" },
    React.createElement(
      "div",
      { className: "cost-card-header" },
      React.createElement(
        "span",
        { className: "cost-card-title" },
        "Session cost",
      ),
      React.createElement(
        "span",
        {
          className: "cost-card-total",
          title: "Sum of priced agent + transcription costs",
        },
        formatUsd(total),
      ),
    ),
    React.createElement(CostRow, {
      label: "Agent",
      sub: costSubtitle(agent),
      value: costValue(agent),
      title: agentTokenTooltip(agent),
    }),
    React.createElement(CostRow, {
      label: "Voice",
      sub: costSubtitle(stt),
      value: costValue(stt),
      title: transcriptionTooltip(stt),
    }),
  );
}

function CostRow({ label, sub, value, title }) {
  return React.createElement(
    "div",
    { className: "cost-row", title: title || undefined },
    React.createElement(
      "div",
      { className: "cost-row-left" },
      React.createElement("span", { className: "cost-row-label" }, label),
      sub
        ? React.createElement("span", { className: "cost-row-sub" }, sub)
        : null,
    ),
    React.createElement("span", { className: "cost-row-value" }, value),
  );
}

function costSubtitle(entry) {
  if (!entry?.provider) return "";
  if (entry.provider === "moonshine")
    return `${entry.model ?? ""} (local)`.trim();
  if (entry.provider === "ollama") return `${entry.model ?? ""} (local)`.trim();
  if (entry.provider === "codex")
    return `${entry.model ?? ""} (subscription)`.trim();
  return entry.model ?? "";
}

function costValue(entry) {
  if (!entry?.provider) return "$0.0000";
  if (!entry.priced) {
    if (entry.reason === "local") return "$0.0000";
    // Codex routes through the user's ChatGPT subscription, so there's no
    // per-token dollar cost we can report. Show usage volume instead so the
    // panel still surfaces "is the agent doing work?".
    if (entry.reason === "subscription") return formatTokenCount(entry.tokens);
    // Metered, but at a rate this app does not track (OpenRouter). Same
    // treatment: show the volume rather than a dollar figure we'd be inventing.
    if (entry.reason === "unpriced") return formatTokenCount(entry.tokens);
    return "n/a";
  }
  return formatUsd(entry.cost ?? 0);
}

function formatUsd(value) {
  if (typeof value !== "number" || !isFinite(value)) return "$0.0000";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function formatTokenCount(tokens) {
  const total =
    (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
  if (total === 0) return "0 tok";
  if (total < 1000) return `${total} tok`;
  if (total < 1_000_000) {
    const k = total / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k tok`;
  }
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}

function agentTokenTooltip(entry) {
  if (!entry?.tokens) return "";
  const t = entry.tokens;
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
  if (total === 0) return "";
  return `input ${t.input ?? 0} (cached ${t.cached ?? 0}) + output ${t.output ?? 0}${t.reasoning ? ` + reasoning ${t.reasoning}` : ""} tokens`;
}

function transcriptionTooltip(entry) {
  if (!entry?.seconds) return "";
  const seconds = entry.seconds;
  const minutes = seconds / 60;
  return `${minutes.toFixed(2)} minutes of audio sent`;
}

function statusRow({
  dotState,
  label,
  value,
  expanded = false,
  onToggle,
  editor,
}) {
  return React.createElement(
    "div",
    { className: `status-row-wrap ${expanded ? "expanded" : ""}` },
    React.createElement(
      "div",
      {
        className: `status-row ${expanded ? "open" : ""}`,
        onClick: onToggle,
        role: "button",
        tabIndex: 0,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        },
      },
      React.createElement("span", {
        className: `dot ${dotState}`,
        "aria-hidden": "true",
      }),
      React.createElement("span", { className: "label" }, label),
      React.createElement(
        "span",
        {
          className: "value",
          title: typeof value === "string" ? value : undefined,
        },
        value,
      ),
      React.createElement(
        "span",
        { className: "chevron", "aria-hidden": "true" },
        "›",
      ),
    ),
    expanded && editor
      ? React.createElement("div", { className: "editor" }, editor)
      : null,
  );
}

function agentModelLabel(settings) {
  const provider = settings.agent.provider;
  if (provider === "ollama") return settings.agent.ollama.model || "(unset)";
  if (provider === "codex")
    return `${settings.agent.codex.model}${settings.agent.codex.fast === false ? "" : " · fast"}`;
  if (provider === "openrouter")
    return settings.agent.openrouter?.model || "(unset)";
  if (provider === "xai") return settings.agent.xai?.model || "(unset)";
  return settings.agent.openai.model;
}

// While a new voice model loads, the Voice row shows its progress; the
// previous model keeps transcribing until then.
function voiceRowLabel(base, status) {
  if (!status || status.state === "ready") return base;
  if (status.state === "error") return `${status.label} · failed`;
  if (status.state === "downloading" && status.totalBytes) {
    const percent = Math.floor((status.receivedBytes / status.totalBytes) * 100);
    return `${status.label} · ${percent}%`;
  }
  return `${status.label} · loading…`;
}

// The server resolves a local model by language and platform, so its label
// (the transcription engine it reports) is the one to show.
function sttModelLabel(settings, engineLabel) {
  if (settings.transcription.provider === "local") return engineLabel;
  if (settings.transcription.provider === "moonshine")
    return settings.transcription.moonshine.model;
  if (settings.transcription.provider === "deepgram")
    return settings.transcription.deepgram?.model || "(unset)";
  if (settings.transcription.provider === "xai") return XAI_TRANSCRIPTION_MODEL;
  return settings.transcription.openai.model;
}

async function listAudioInputs() {
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.filter((d) => d.kind === "audioinput");
}

function MicEditor({ currentDeviceId, onSave, onCancel }) {
  const [devices, setDevices] = React.useState([]);
  const [selected, setSelected] = React.useState(currentDeviceId);
  const [needsPermission, setNeedsPermission] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const inputs = await listAudioInputs();
        if (cancelled) return;
        setDevices(inputs);
        setNeedsPermission(inputs.length > 0 && inputs.every((d) => !d.label));
      } catch (err) {
        if (!cancelled) setErrorText(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function grantPermission() {
    setBusy(true);
    setErrorText("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setDevices(await listAudioInputs());
      setNeedsPermission(false);
    } catch (err) {
      setErrorText(err.message);
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const device = devices.find((d) => d.deviceId === selected);
    onSave({ deviceId: selected || "", label: device?.label || "" });
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    needsPermission
      ? React.createElement(
          "div",
          { className: "editor-hint" },
          "Grant microphone access to see device names.",
          React.createElement(
            "button",
            {
              className: "secondary",
              onClick: grantPermission,
              disabled: busy,
              style: { marginLeft: "8px" },
            },
            busy ? "..." : "Grant",
          ),
        )
      : null,
    field(
      "Device",
      React.createElement(
        "select",
        {
          value: selected,
          onChange: (e) => setSelected(e.target.value),
          disabled: busy,
        },
        React.createElement("option", { value: "" }, "System default"),
        devices.map((d) =>
          React.createElement(
            "option",
            { key: d.deviceId, value: d.deviceId },
            d.label || `Device ${d.deviceId.slice(0, 8)}`,
          ),
        ),
      ),
    ),
    editorFooter({ errorText, busy, onCancel, onSave: submit, saveLabel: "Save" }),
  );
}

function AgentEditor({ settings, onSave, onCancel }) {
  const [provider, setProvider] = React.useState(settings.agent.provider);
  const [openaiModel, setOpenaiModel] = React.useState(
    settings.agent.openai.model,
  );
  const [reasoningEffort, setReasoningEffort] = React.useState(
    settings.agent.openai.reasoningEffort,
  );
  const [openaiBaseURL, setOpenaiBaseURL] = React.useState(
    settings.agent.openai.baseURL,
  );
  const [codexModel, setCodexModel] = React.useState(
    settings.agent.codex.model,
  );
  const [codexFast, setCodexFast] = React.useState(
    settings.agent.codex.fast !== false,
  );
  const [ollamaModel, setOllamaModel] = React.useState(
    settings.agent.ollama.model,
  );
  const [ollamaBaseURL, setOllamaBaseURL] = React.useState(
    settings.agent.ollama.baseURL,
  );
  const [openrouterModel, setOpenrouterModel] = React.useState(
    settings.agent.openrouter?.model ?? "",
  );
  const [openrouterBaseURL, setOpenrouterBaseURL] = React.useState(
    settings.agent.openrouter?.baseURL ?? "",
  );
  const [openrouterKey, setOpenrouterKey] = React.useState("");
  const [xaiModel, setXaiModel] = React.useState(settings.agent.xai?.model ?? "");
  const [xaiBaseURL, setXaiBaseURL] = React.useState(
    settings.agent.xai?.baseURL ?? "",
  );
  const [xaiKey, setXaiKey] = React.useState("");
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  const needsOpenAIKey =
    provider === "openai" && !settings.hasOpenAIKey && !openaiKey;
  const needsOpenRouterKey =
    provider === "openrouter" && !settings.hasOpenRouterKey && !openrouterKey;
  const needsXaiKey =
    provider === "xai" && !settings.hasXaiKey && !xaiKey;

  async function submit() {
    setBusy(true);
    setErrorText("");
    const patch = {
      agent: { provider, openai: {}, codex: {}, ollama: {}, openrouter: {}, xai: {} },
    };
    if (provider === "openai") {
      patch.agent.openai.model = openaiModel;
      patch.agent.openai.reasoningEffort = reasoningEffort;
      patch.agent.openai.baseURL = openaiBaseURL;
    } else if (provider === "codex") {
      patch.agent.codex.model = codexModel;
      patch.agent.codex.fast = codexFast;
    } else if (provider === "openrouter") {
      patch.agent.openrouter.model = openrouterModel;
      patch.agent.openrouter.baseURL = openrouterBaseURL;
    } else if (provider === "xai") {
      patch.agent.xai.model = xaiModel;
      patch.agent.xai.baseURL = xaiBaseURL;
    } else {
      patch.agent.ollama.model = ollamaModel;
      patch.agent.ollama.baseURL = ollamaBaseURL;
    }
    const apiKeys = {};
    if (openaiKey) apiKeys.openai = openaiKey;
    if (openrouterKey) apiKeys.openrouter = openrouterKey;
    if (xaiKey) apiKeys.xai = xaiKey;
    if (Object.keys(apiKeys).length > 0) patch.apiKeys = apiKeys;
    try {
      await onSave(patch);
    } catch (error) {
      setErrorText(error.message);
      setBusy(false);
    }
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    field(
      "Provider",
      React.createElement(
        "select",
        {
          value: provider,
          onChange: (e) => setProvider(e.target.value),
          disabled: busy,
        },
        React.createElement("option", { value: "openai" }, "OpenAI"),
        React.createElement("option", { value: "codex" }, "Codex"),
        React.createElement("option", { value: "openrouter" }, "OpenRouter"),
        React.createElement("option", { value: "xai" }, "xAI"),
        React.createElement("option", { value: "ollama" }, "Ollama"),
      ),
    ),
    provider === "xai"
      ? textField("Model", xaiModel, setXaiModel, busy, XAI_MODEL_PLACEHOLDER)
      : null,
    provider === "xai"
      ? keyField(xaiKey, setXaiKey, settings.hasXaiKey, "xai-...", busy)
      : null,
    provider === "xai"
      ? textField("Base URL", xaiBaseURL, setXaiBaseURL, busy)
      : null,
    provider === "openrouter"
      ? textField(
          "Model",
          openrouterModel,
          setOpenrouterModel,
          busy,
          OPENROUTER_MODEL_PLACEHOLDER,
        )
      : null,
    provider === "openrouter"
      ? keyField(
          openrouterKey,
          setOpenrouterKey,
          settings.hasOpenRouterKey,
          "sk-or-...",
          busy,
        )
      : null,
    provider === "openrouter"
      ? textField("Base URL", openrouterBaseURL, setOpenrouterBaseURL, busy)
      : null,
    provider === "openai"
      ? field(
          "Model",
          select(openaiModel, setOpenaiModel, OPENAI_AGENT_MODELS, busy),
        )
      : null,
    provider === "openai"
      ? field(
          "Reasoning",
          select(reasoningEffort, setReasoningEffort, REASONING_EFFORTS, busy),
        )
      : null,
    provider === "codex"
      ? field(
          "Model",
          select(codexModel, setCodexModel, CODEX_AGENT_MODELS, busy),
        )
      : null,
    provider === "codex"
      ? field(
          "Fast mode",
          React.createElement(
            "label",
            null,
            React.createElement("input", {
              type: "checkbox",
              checked: codexFast,
              onChange: (e) => setCodexFast(e.target.checked),
              disabled: busy,
            }),
            " Faster replies; uses your ChatGPT plan 2.5x faster",
          ),
        )
      : null,
    provider === "ollama"
      ? textField("Model", ollamaModel, setOllamaModel, busy, "e.g. qwen3.6")
      : null,
    provider === "ollama"
      ? textField("Base URL", ollamaBaseURL, setOllamaBaseURL, busy)
      : null,
    provider === "openai"
      ? keyField(openaiKey, setOpenaiKey, settings.hasOpenAIKey, "sk-...", busy)
      : null,
    provider === "openai"
      ? textField("Base URL", openaiBaseURL, setOpenaiBaseURL, busy)
      : null,
    editorFooter({
      errorText,
      busy,
      onCancel,
      onSave: submit,
      saveDisabled: needsOpenAIKey || needsOpenRouterKey || needsXaiKey,
    }),
  );
}

function TranscriptionEditor({
  settings,
  localModels,
  languages,
  onSave,
  onCancel,
}) {
  // Older settings files say "moonshine"; the editor shows that as Local.
  const legacyMoonshine = settings.transcription.provider === "moonshine";
  const [provider, setProvider] = React.useState(
    legacyMoonshine ? "local" : settings.transcription.provider,
  );
  const [language, setLanguage] = React.useState(
    settings.transcription.language ?? "en",
  );
  // The saved pick for a language if this platform offers it, else its default.
  const savedLocalModel = (lang) => {
    const ids = localModels
      .filter((model) => model.language === lang)
      .map((model) => model.id);
    const saved =
      settings.transcription.local?.models?.[lang] ??
      (legacyMoonshine && lang === "en"
        ? `moonshine-${settings.transcription.moonshine?.model}`
        : undefined);
    return ids.includes(saved) ? saved : (ids[0] ?? "");
  };
  const [localModelId, setLocalModelId] = React.useState(() =>
    savedLocalModel(settings.transcription.language ?? "en"),
  );
  const languageModels = localModels.filter(
    (model) => model.language === language,
  );
  function chooseLanguage(next) {
    setLanguage(next);
    setLocalModelId(savedLocalModel(next));
  }
  const providerLanguages = languages[provider] ?? ["en"];
  // A language the new provider does not offer falls back to its first one.
  function chooseProvider(next) {
    setProvider(next);
    const offered = languages[next] ?? ["en"];
    if (!offered.includes(language)) chooseLanguage(offered[0]);
  }
  const [openaiModel, setOpenaiModel] = React.useState(
    settings.transcription.openai.model,
  );
  const [deepgramModel, setDeepgramModel] = React.useState(
    settings.transcription.deepgram?.model ?? DEEPGRAM_TRANSCRIPTION_MODELS[0],
  );
  const [deepgramKeyterms, setDeepgramKeyterms] = React.useState(
    (settings.transcription.deepgram?.keyterms ?? []).join(", "),
  );
  const [deepgramKey, setDeepgramKey] = React.useState("");
  // The same xAI key as the agent's; entering it here sets it for both.
  const [xaiKey, setXaiKey] = React.useState("");
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  const needsOpenAIKey =
    provider === "openai" && !settings.hasOpenAIKey && !openaiKey;
  const needsDeepgramKey =
    provider === "deepgram" && !settings.hasDeepgramKey && !deepgramKey;
  const needsXaiKey =
    provider === "xai" && !settings.hasXaiKey && !xaiKey;

  async function submit() {
    setBusy(true);
    setErrorText("");
    const patch = {
      transcription: { provider, openai: {}, deepgram: {} },
    };
    patch.transcription.language = language;
    if (provider === "local" && localModelId) {
      patch.transcription.local = { models: { [language]: localModelId } };
    }
    if (provider === "openai") patch.transcription.openai.model = openaiModel;
    if (provider === "deepgram") {
      patch.transcription.deepgram.model = deepgramModel;
      patch.transcription.deepgram.keyterms = deepgramKeyterms
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean);
    }
    const apiKeys = {};
    if (openaiKey) apiKeys.openai = openaiKey;
    if (deepgramKey) apiKeys.deepgram = deepgramKey;
    if (xaiKey) apiKeys.xai = xaiKey;
    if (Object.keys(apiKeys).length > 0) patch.apiKeys = apiKeys;
    try {
      await onSave(patch);
    } catch (error) {
      setErrorText(error.message);
      setBusy(false);
    }
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    field(
      "Provider",
      React.createElement(
        "select",
        {
          value: provider,
          onChange: (e) => chooseProvider(e.target.value),
          disabled: busy,
        },
        React.createElement(
          "option",
          { value: "local" },
          "Local (this computer)",
        ),
        React.createElement("option", { value: "openai" }, "OpenAI Realtime"),
        React.createElement("option", { value: "deepgram" }, "Deepgram"),
        React.createElement("option", { value: "xai" }, "xAI"),
      ),
    ),
    provider === "xai"
      ? keyField(xaiKey, setXaiKey, settings.hasXaiKey, "xai-...", busy)
      : null,
    provider === "deepgram"
      ? field(
          "Model",
          select(
            deepgramModel,
            setDeepgramModel,
            DEEPGRAM_TRANSCRIPTION_MODELS,
            busy,
          ),
        )
      : null,
    provider === "deepgram"
      ? keyField(
          deepgramKey,
          setDeepgramKey,
          settings.hasDeepgramKey,
          "Deepgram API key",
          busy,
        )
      : null,
    provider === "deepgram"
      ? textField(
          "Key terms",
          deepgramKeyterms,
          setDeepgramKeyterms,
          busy,
          "comma-separated, e.g. Kubernetes, gRPC",
        )
      : null,
    field(
      "Language",
      labeledSelect(
        language,
        chooseLanguage,
        providerLanguages.map((code) => ({
          value: code,
          label: LANGUAGE_LABELS[code] ?? code,
        })),
        busy,
      ),
    ),
    provider === "local"
      ? field(
          "Model",
          labeledSelect(
            localModelId,
            setLocalModelId,
            languageModels.map((model) => ({
              value: model.id,
              label: localModelLabel(model),
            })),
            busy,
          ),
        )
      : null,
    provider === "openai"
      ? field(
          "Model",
          select(
            openaiModel,
            setOpenaiModel,
            OPENAI_TRANSCRIPTION_MODELS,
            busy,
          ),
        )
      : null,
    provider === "openai"
      ? keyField(openaiKey, setOpenaiKey, settings.hasOpenAIKey, "sk-...", busy)
      : null,
    editorFooter({
      errorText,
      busy,
      onCancel,
      onSave: submit,
      saveDisabled: needsOpenAIKey || needsDeepgramKey || needsXaiKey,
    }),
  );
}

function field(label, control) {
  return React.createElement(
    "label",
    { className: "field" },
    React.createElement("span", { className: "field-label" }, label),
    control,
  );
}

function textField(label, value, onChange, disabled, placeholder = undefined) {
  return field(
    label,
    React.createElement("input", {
      type: "text",
      value,
      onChange: (e) => onChange(e.target.value),
      placeholder,
      disabled,
    }),
  );
}

// The page never sees a saved key, only whether there is one. A typed key
// replaces it; a blank field keeps it.
function keyField(value, onChange, configured, placeholder, disabled) {
  return field(
    "API key",
    React.createElement("input", {
      type: "password",
      value,
      onChange: (e) => onChange(e.target.value),
      placeholder: configured ? "configured (enter to replace)" : placeholder,
      disabled,
    }),
  );
}

function editorFooter({
  errorText,
  busy,
  onCancel,
  onSave,
  saveDisabled = false,
  saveLabel = busy ? "Saving..." : "Save",
}) {
  return React.createElement(
    React.Fragment,
    null,
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        { onClick: onSave, disabled: busy || saveDisabled },
        saveLabel,
      ),
    ),
  );
}

function labeledSelect(value, onChange, options, disabled) {
  return React.createElement(
    "select",
    { value, onChange: (e) => onChange(e.target.value), disabled },
    options.map((option) =>
      React.createElement(
        "option",
        { key: option.value, value: option.value },
        option.label,
      ),
    ),
  );
}

// sherpa-onnx models download on first use, so their size is worth showing.
function localModelLabel(model) {
  if (!model.downloadBytes) return model.label;
  return `${model.label} · ${Math.round(model.downloadBytes / 1_000_000)} MB`;
}

function select(value, onChange, options, disabled) {
  // Keep a saved value that is not in the menu (an older model, say) visible
  // and selected instead of silently showing the first option.
  const shown = value && !options.includes(value) ? [value, ...options] : options;
  return labeledSelect(
    value,
    onChange,
    shown.map((option) => ({ value: option, label: option })),
    disabled,
  );
}

async function createAudioStreamer(media, onChunk) {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(media);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.85;
  let carry = new Float32Array(0);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resample(input, context.sampleRate, SAMPLE_RATE, carry);
    carry = resampled.carry;
    if (resampled.samples.length > 0) {
      onChunk(pcm16ToBase64(resampled.samples));
    }
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(context.destination);

  return {
    analyser,
    close: async () => {
      processor.disconnect();
      source.disconnect();
      analyser.disconnect();
      await context.close();
    },
  };
}

function resample(input, fromRate, toRate, carry) {
  const merged = new Float32Array(carry.length + input.length);
  merged.set(carry);
  merged.set(input, carry.length);

  const ratio = fromRate / toRate;
  const outputLength = Math.floor((merged.length - 1) / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, merged.length - 1);
    const weight = sourceIndex - left;
    output[index] = merged[left] * (1 - weight) + merged[right] * weight;
  }

  const consumed = Math.floor(outputLength * ratio);
  return { samples: output, carry: merged.slice(consumed) };
}

function pcm16ToBase64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

// Convert Excalidraw native elements back into the simple "skeleton" shape the
// server stores. Critical: when the agent emits {rectangle, label: "X"},
// convertToExcalidrawElements expands that into a rectangle PLUS a separate
// bound text element. If we echo both back to the server verbatim, the server's
// state.elements doubles up - on the next agent turn the rectangle has lost its
// label, the agent re-adds it, Excalidraw creates ANOTHER bound text, and now
// the canvas renders the same label twice. Folding bound text back into the
// shape's label field on the way out keeps state.elements in the canonical form
// the agent expects.
function nativeElementsToSkeletonForSync(nativeElements) {
  const elements = nativeElements.filter((el) => el && !el.isDeleted);
  const byId = new Map(elements.map((el) => [el.id, el]));
  const consumedTextIds = new Set();
  const result = [];

  for (const el of elements) {
    // Bound text whose parent shape is in the scene: skip - it'll be folded
    // into the parent's label below.
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      consumedTextIds.add(el.id);
      continue;
    }

    const boundElements = Array.isArray(el.boundElements)
      ? el.boundElements
      : null;
    const textBinding =
      boundElements && boundElements.find((b) => b?.type === "text");
    const labelText = textBinding && byId.get(textBinding.id);

    if (labelText) {
      consumedTextIds.add(labelText.id);
      result.push({
        ...stripInternalFields(el),
        label: {
          text: labelText.text ?? "",
          fontSize: labelText.fontSize ?? 18,
        },
      });
      continue;
    }

    result.push(stripInternalFields(el));
  }

  return result.filter((el) => !consumedTextIds.has(el.id));
}

function stripInternalFields(el) {
  // Drop Excalidraw fields that change on every render (cache thrash) or that
  // we don't want the agent reasoning about (locking, grouping, etc.).
  const {
    versionNonce,
    version,
    updated,
    seed,
    index,
    link,
    locked,
    customData,
    frameId,
    groupIds,
    boundElements,
    containerId,
    isDeleted,
    ...rest
  } = el;
  return rest;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas screenshot export failed."));
    }, "image/png");
  });
}

// Halve each dimension before sending to the agent. ~4x fewer pixels means
// ~4x fewer image tokens and a smaller WS payload, while shapes and labels
// stay legible enough for the model to do visual sanity checks. `source` is
// a PNG blob or a canvas, which is read directly instead of encoded twice.
async function downscaleByHalf(source) {
  try {
    const bitmap = await createImageBitmap(source);
    const w = Math.max(1, Math.floor(bitmap.width / 2));
    const h = Math.max(1, Math.floor(bitmap.height / 2));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return await canvasToBlob(canvas);
  } catch (error) {
    console.warn("Image downscale failed, sending original:", error);
    return source instanceof Blob ? source : canvasToBlob(source);
  }
}

createRoot(document.getElementById("app")).render(React.createElement(App));
