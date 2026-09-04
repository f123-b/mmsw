import { StrictMode, useEffect, useMemo, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import { AnswerThreadStore, answerRelationForQuestion, type AnswerThread, type QuestionCandidate, type QuestionEvent, type SessionState, type TranscriptSnapshot } from "@interview-copilot/shared";
import type { HUDState, OverlayMode } from "../main/overlay-manager";
import type { OverlayPreferences } from "../shared/overlay-preferences";
import type { RuntimeOperationMode } from "../shared/runtime-operation-mode";
import type { SpeechScript } from "../main/speech-script";
import { OverlayWindowRoot } from "./overlay/OverlayWindowRoot";
import { answerScreenshotForMode } from "./overlay-runtime-actions";
import type { OverlayRootProps, OverlaySurface } from "./overlay/OverlayRoot";
import type { WrittenTestState } from "../main/written-test-controller";
import { RootErrorBoundary } from "./components/ErrorBoundary";
import { installNonActivatingInput } from "./overlay/nonactivating-input";
import { upsertTimelineGroup } from "./overlay/question-timeline";
import { initialRuntimePhaseState, isCommittedQuestionGroup, isDisplayableQuestionGroup, questionWaitingNotice, reduceRuntimeMessage, reduceRuntimeQuestion, reduceRuntimeTranscript, sessionPhaseFor, type RuntimePhaseState } from "./overlay/runtime-state";

type QuestionGroup = OverlayRootProps["questionGroups"][number];

const initialHUDState: HUDState = { running: false, panelVisible: false, transcriptVisible: false, answerVisible: false, scriptVisible: false, transientLayer: "none", shareMode: false, topBarVisible: false, mouseMode: "passthrough", mode: "HIDDEN" };
const initialPreferences = (): OverlayPreferences | undefined => undefined;

function replaceQuestionGroup(groups: QuestionGroup[], question: QuestionCandidate): QuestionGroup[] {
  const groupId = question.groupId ?? `question-group-${question.id}`;
  const current = groups.find((group) => group.id === groupId);
  const item = { id: question.id, questionId: question.id, text: question.text, type: question.threadItemType ?? "NEW_TOPIC", answerable: question.answerable !== false, state: question.status };
  if (question.answerable === false) return groups;
  const next = current ? { ...current, title: current.title, primaryQuestion: current.primaryQuestion ?? question.text, displayable: true, hasAnswerableQuestion: true, items: [...current.items.filter((entry) => entry.id !== item.id), item], updatedAt: Date.now() } : { id: groupId, title: question.text, primaryQuestion: question.text, displayable: true, hasAnswerableQuestion: true, items: [item], slots: [], updatedAt: Date.now() };
  return upsertTimelineGroup(groups, next);
}

function applyRealtimeMessage(message: RealtimeServerMessage, state: RuntimeState, answerStore: AnswerThreadStore): RuntimeState {
  if (message.type === "question_group_updated") {
    const group: QuestionGroup = { id: message.groupId, title: message.title, ...(message.primaryQuestion ? { primaryQuestion: message.primaryQuestion } : {}), displayable: message.displayable, hasAnswerableQuestion: message.hasAnswerableQuestion, status: message.status, items: message.items, slots: message.slots, updatedAt: message.updatedAt };
    if (!isDisplayableQuestionGroup(group)) return state;
    return isCommittedQuestionGroup(group)
      ? { ...state, notice: undefined, questionGroups: upsertTimelineGroup(state.questionGroups, group), activeQuestionGroupId: group.id, activeAnswerGroupId: group.id, runtimePhases: { ...state.runtimePhases, questionPhase: "COMMITTED", activeQuestionGroupId: group.id, activeAnswerGroupId: group.id } }
      : { ...state, questionGroups: upsertTimelineGroup(state.questionGroups, group) };
  }
  if (message.type === "runtime_error") return { ...state, notice: message.message, ...(message.questionId ? { questionIssues: { ...state.questionIssues, [message.questionId]: message.message } } : {}), runtimePhases: reduceRuntimeMessage(state.runtimePhases, message) };
  if (message.type === "answer_start") {
    const question = state.question?.id === message.questionId ? state.question : undefined;
    const questionGroup = state.questionGroups.find(group => group.items.some(item => item.questionId === message.questionId));
    const questionText = questionGroup?.items.find(item => item.questionId === message.questionId)?.text ?? question?.text;
    const groupId = message.groupId ?? questionGroup?.id ?? question?.groupId;
    answerStore.start({ answerId: message.answerId, questionId: message.questionId, ...(groupId ? { groupId } : {}), title: groupId ? state.questionGroups.find((group) => group.id === groupId)?.title : undefined, questionText: questionText ?? "截图识别的问题", relation: message.relation ?? (question ? answerRelationForQuestion(question) : "PRIMARY") });
    const committedGroupId = groupId && isCommittedQuestionGroup(state.questionGroups.find((group) => group.id === groupId)) ? groupId : undefined;
    return { ...state, notice: undefined, answerText: "", answerStreaming: true, answerId: message.answerId, ...(committedGroupId ? { activeQuestionGroupId: committedGroupId, activeAnswerGroupId: committedGroupId } : {}), answerMode: message.mode, answerThreads: answerStore.list(), runtimePhases: reduceRuntimeMessage({ ...state.runtimePhases, ...(committedGroupId ? { activeQuestionGroupId: committedGroupId, activeAnswerGroupId: committedGroupId } : {}) }, message, committedGroupId) };
  }
  if (message.type === "answer_delta") {
    answerStore.delta(message.answerId, message.delta);
    return { ...state, answerText: `${state.answerText}${message.delta}`, answerStreaming: true, answerThreads: answerStore.list(), runtimePhases: reduceRuntimeMessage(state.runtimePhases, message) };
  }
  if (message.type === "answer_end") {
    answerStore.complete(message.answerId, message.text);
    return { ...state, answerText: message.text, answerStreaming: false, answerId: message.answerId, answerThreads: answerStore.list(), runtimePhases: reduceRuntimeMessage(state.runtimePhases, message) };
  }
  if (message.type === "answer_cancelled") {
    answerStore.cancel(message.answerId);
    return { ...state, answerStreaming: false, answerThreads: answerStore.list(), runtimePhases: reduceRuntimeMessage(state.runtimePhases, message) };
  }
  return state;
}

interface RuntimeState {
  mic: number;
  system: number;
  state: string;
  sessionState: string;
  realtimeState: string;
  operationMode: RuntimeOperationMode;
  overlayMode: OverlayMode;
  hudState: HUDState;
  runtimePhases: RuntimePhaseState;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  writtenTest: WrittenTestState;
  screenshot?: { dataUrl: string };
  question?: QuestionCandidate;
  questionIssues?: Record<string, string>;
  answerText: string;
  answerStreaming: boolean;
  answerId?: string;
  questionGroups: QuestionGroup[];
  activeQuestionGroupId?: string;
  activeAnswerGroupId?: string;
  answerThreads: AnswerThread[];
  remoteTranscript: TranscriptSnapshot;
  micTranscript: TranscriptSnapshot;
  speechScript?: SpeechScript;
  preferences?: OverlayPreferences;
  layoutEditMode: boolean;
  captureProtection?: { requested: boolean; supported?: boolean; osFlagApplied?: boolean; displayCaptureVerified?: boolean | null; lastError?: string };
  notice?: string;
}

const initialRuntimeState: RuntimeState = { mic: 0, system: 0, state: "STOPPED", sessionState: "IDLE", realtimeState: "disconnected", operationMode: "IDLE", overlayMode: "passive", hudState: initialHUDState, runtimePhases: initialRuntimePhaseState, automationMode: "AUTO", answerMode: "NORMAL", writtenTest: { running: false, answerMode: "NORMAL", screenshotStatus: "IDLE", questionCount: 0, screenshotCount: 0 }, answerText: "", answerStreaming: false, questionGroups: [], answerThreads: [], remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] }, layoutEditMode: false };

function useOverlayRuntime(surface: OverlaySurface): RuntimeState {
  const [state, setState] = useState<RuntimeState>(() => ({ ...initialRuntimeState, preferences: initialPreferences() }));
  const answerStore = useMemo(() => new AnswerThreadStore(), []);
  useEffect(() => {
    let disposed = false;
    const cleanupInput = installNonActivatingInput(document);
    let observedOverlayState = false;
    let observedScript = false;
    let transcriptRevision = 0;
    let lastTranscriptAt = 0;
    const update = (patch: Partial<RuntimeState>) => { if (!disposed) setState((current) => ({ ...current, ...patch })); };
    const syncTranscripts = async () => {
      if (surface !== "question") return;
      const revision = transcriptRevision;
      try {
        const snapshots = await window.interviewCopilot.realtime.getTranscript();
        if (!disposed && revision === transcriptRevision) update({ ...(snapshots.remote ? { remoteTranscript: snapshots.remote } : {}), ...(snapshots.mic ? { micTranscript: snapshots.mic } : {}) });
      } catch { /* Stream events remain primary; retry on the next quiet tick. */ }
    };
    void syncTranscripts();
    const recoverTranscript = () => { if (!document.hidden) void syncTranscripts(); };
    document.addEventListener("visibilitychange", recoverTranscript);
    const recoveryTimer = window.setInterval(() => { if (!document.hidden && Date.now() - lastTranscriptAt > 3_000) void syncTranscripts(); }, 3_000);
    void Promise.all([window.interviewCopilot.overlay.getState(), window.interviewCopilot.overlay.getPreferences(), window.interviewCopilot.overlay.getCaptureProtection(), window.interviewCopilot.writtenTest.getState(), window.interviewCopilot.speechScript.get()]).then(([hudState, preferences, captureProtection, writtenTest, speechScript]) => update({ ...(observedOverlayState ? {} : { hudState: hudState ?? initialHUDState }), preferences, captureProtection, writtenTest, ...(observedScript ? {} : {speechScript}) })).catch(() => undefined);
    const cleanups = [
      window.interviewCopilot.events.onAudio((event) => { if (event.type === "meter") update({ mic: Math.max(0, Math.min(1, event.mic)), system: Math.max(0, Math.min(1, event.system)) }); else if (event.type === "audio_state") setState((current) => ({ ...current, state: event.state, runtimePhases: { ...current.runtimePhases, sessionPhase: sessionPhaseFor(current.sessionState, event.state, current.realtimeState) } })); }),
      window.interviewCopilot.events.onSessionState((sessionState: SessionState) => {
        const shouldReset = sessionState === "CREATING" || sessionState === "IDLE" || sessionState === "ENDED";
        if (shouldReset) answerStore.reset();
        setState((current) => ({
          ...current,
          sessionState,
          runtimePhases: shouldReset
            ? { ...initialRuntimePhaseState, automationMode: current.automationMode, sessionPhase: sessionPhaseFor(sessionState, current.state, current.realtimeState) }
            : { ...current.runtimePhases, sessionPhase: sessionPhaseFor(sessionState, current.state, current.realtimeState) },
          ...(shouldReset ? { notice: undefined, questionIssues: {}, question: undefined, answerText: "", answerStreaming: false, answerId: undefined, questionGroups: [], activeQuestionGroupId: undefined, activeAnswerGroupId: undefined, answerThreads: [] } : {})
        }));
      }),
      window.interviewCopilot.events.onOperationMode((operationMode) => setState((current) => operationMode === "IDLE"
        ? { ...current, notice: undefined, questionIssues: {}, operationMode, sessionState: "IDLE", answerText: "", answerStreaming: false, answerThreads: [], questionGroups: [], question: undefined, remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] }, runtimePhases: { ...initialRuntimePhaseState } }
        : { ...current, operationMode, sessionState: "RUNNING", runtimePhases: operationMode === "WRITTEN_TEST" ? { ...initialRuntimePhaseState, sessionPhase: "LISTENING" } : current.runtimePhases })),
      window.interviewCopilot.events.onRealtimeState((realtimeState) => setState((current) => ({ ...current, realtimeState, runtimePhases: { ...current.runtimePhases, sessionPhase: sessionPhaseFor(current.sessionState, current.state, realtimeState) } }))),
      window.interviewCopilot.events.onOverlayMode((overlayMode) => update({ overlayMode })),
      window.interviewCopilot.events.onOverlayState((hudState) => { observedOverlayState = true; update({ hudState }); }),
      window.interviewCopilot.events.onOverlayPreferences((preferences) => update({ preferences })),
      window.interviewCopilot.events.onOverlayCaptureProtection((captureProtection) => update({ captureProtection })),
      window.interviewCopilot.events.onSpeechScript((speechScript) => { observedScript = true; update({ speechScript }); }),
      window.interviewCopilot.events.onOverlayLayoutEditMode((layoutEditMode) => update({ layoutEditMode })),
      window.interviewCopilot.events.onAutomationMode((automationMode) => setState((current) => ({ ...current, automationMode, runtimePhases: { ...current.runtimePhases, automationMode } }))),
      window.interviewCopilot.events.onAnswerMode((answerMode) => update({ answerMode })),
      window.interviewCopilot.events.onWrittenTestState((writtenTest) => update({ writtenTest })),
      window.interviewCopilot.events.onScreenshot((screenshot) => update({ screenshot })),
      window.interviewCopilot.events.onRealtimeTranscript((snapshot) => { if (surface !== "question") return; transcriptRevision++; lastTranscriptAt = Date.now(); setState((current) => ({ ...current, ...(snapshot.source === "remote" ? { remoteTranscript: snapshot } : { micTranscript: snapshot }), runtimePhases: reduceRuntimeTranscript(current.runtimePhases, snapshot.source, snapshot.final.length > 0) })); }),
      window.interviewCopilot.events.onQuestion((event: QuestionEvent) => {
        const notice = questionWaitingNotice(event);
        if (notice) {
          setState((current) => ({ ...current, notice, runtimePhases: reduceRuntimeQuestion(current.runtimePhases, event) }));
          return;
        }
        if (event.type !== "question_confirmed" && event.type !== "question_superseded") return;
        setState((current) => event.question.answerable === false
          ? { ...current, runtimePhases: reduceRuntimeQuestion(current.runtimePhases, event) }
          : { ...current, notice: undefined, question: event.question, questionGroups: replaceQuestionGroup(current.questionGroups, event.question), runtimePhases: reduceRuntimeQuestion(current.runtimePhases, event) });
      }),
      window.interviewCopilot.events.onRealtimeMessage((message) => setState((current) => surface === "question" || surface === "answer" ? applyRealtimeMessage(message, current, answerStore) : { ...current, runtimePhases: reduceRuntimeMessage(current.runtimePhases, message) })),
      window.interviewCopilot.events.onOverlayGlobalWheel(({ deltaY }) => {
        const element = document.querySelector(".overlay-scroll-region") as HTMLElement | null;
        if (!element) return;
        element.scrollBy({ top: deltaY, behavior: "auto" });
      })
    ];
    return () => { disposed = true; cleanupInput(); window.clearInterval(recoveryTimer); document.removeEventListener("visibilitychange", recoverTranscript); cleanups.forEach((cleanup) => cleanup()); };
  }, [answerStore, surface]);
  return state;
}

function OverlayRuntimeApp({ surface }: { surface: OverlaySurface }): JSX.Element {
  const state = useOverlayRuntime(surface);
  const props: OverlayRootProps = {
    surface,
    panel: surface === "question" ? "question" : surface === "answer" ? "answer" : undefined,
    mic: state.mic,
    system: state.system,
    state: state.state,
    sessionState: state.sessionState,
    realtimeState: state.realtimeState,
    operationMode: state.operationMode,
    overlayMode: state.overlayMode,
    hudState: state.hudState,
    runtimePhases: state.runtimePhases,
    runtimeNotice: state.notice,
    questionIssues: state.questionIssues,
    automationMode: state.automationMode,
    answerMode: state.answerMode,
    writtenTest: state.writtenTest,
    screenshot: state.screenshot,
    question: state.question,
    answerText: state.answerText,
    answerStreaming: state.answerStreaming,
    questionGroups: state.questionGroups,
    activeQuestionGroupId: state.activeQuestionGroupId,
    activeAnswerGroupId: state.activeAnswerGroupId,
    answerThreads: state.answerThreads,
    remoteTranscript: state.remoteTranscript,
    micTranscript: state.micTranscript,
    speechScript: state.speechScript,
    onToggleMode: () => void window.interviewCopilot.overlay.setMode(state.overlayMode === "interactive" ? "passive" : "interactive"),
    onToggleAutomation: async () => { await window.interviewCopilot.interview.setAutomationMode(state.automationMode === "AUTO" ? "MANUAL" : "AUTO"); },
    onAnswerLatest: () => window.interviewCopilot.interview.answerLatest(),
    onAnswerScreenshot: () => answerScreenshotForMode(state.operationMode),
    onEndInterview: () => state.operationMode === "WRITTEN_TEST" ? window.interviewCopilot.writtenTest.stop().then(() => undefined) : window.interviewCopilot.interview.stop(),
    onHideAll: () => void window.interviewCopilot.overlay.hideAll(),
    onShowAll: () => void window.interviewCopilot.overlay.showAll(),
    onTogglePanels: () => void window.interviewCopilot.overlay.toggleAll(),
    onToggleTranscript: () => void window.interviewCopilot.overlay.toggleTranscript(),
    onToggleAnswer: () => void window.interviewCopilot.overlay.toggleAnswer(),
    onToggleScript: () => void window.interviewCopilot.overlay.toggleScript(),
    onToggleShortcuts: () => void window.interviewCopilot.overlay.toggleShortcuts(),
    onRequestEndInterview: () => void window.interviewCopilot.overlay.requestEndInterview(),
    onToggleShare: () => void window.interviewCopilot.overlay.toggleShareMode(),
    captureProtectionEnabled: state.captureProtection?.requested,
    captureProtectionSupported: state.captureProtection?.supported,
    captureProtectionOsFlagApplied: state.captureProtection?.osFlagApplied,
    captureProtectionDisplayVerified: state.captureProtection?.displayCaptureVerified,
    captureProtectionLastError: state.captureProtection?.lastError,
    onToggleCaptureProtection: () => void window.interviewCopilot.overlay.setCaptureProtection(!(state.captureProtection?.requested ?? true))
  };
  return <OverlayWindowRoot {...props} />;
}

export function mountOverlayRenderer(surface: OverlaySurface): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) return;
  createRoot(rootElement).render(<StrictMode><RootErrorBoundary><OverlayRuntimeApp surface={surface} /></RootErrorBoundary></StrictMode>);
  document.documentElement.dataset.appReady = "true";
  window.interviewCopilot.diagnostics.markRendererReady();
}
