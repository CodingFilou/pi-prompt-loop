import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATUS_KEY = "autonomous-loop";
const FINISH_TOOL = "loop_finish";
const DEFAULT_MAX = 30;
const DEFAULT_MINUTES = 30;
const HELP = [
  "/loop [--max 1..100] [--minutes 1..120] <Aufgabe>",
  "/loop status | /loop stop | /loop test | /loop help",
  "Beispiel: /loop --max 40 Behebe die Testfehler und prüfe das Ergebnis.",
  "Standard: 30 Modellrunden, 30 Minuten. Auch Antworten mit Tool-Aufrufen zählen.",
  "Stop: Fertig-/Blockiertmeldung, Limit, Esc oder /loop stop.",
  "Achtung: Kein Sandbox- oder Token-/Kostenlimit; normale Pi-Berechtigungen gelten.",
].join("\n");

type LoopOptions = { task: string; max: number; minutes: number };
type LoopCompletion = { status: "done" | "blocked"; summary: string };
type LoopState = LoopOptions & {
  completion?: LoopCompletion;
  rounds: number;
  startedAt: number;
  initialPrompt: string;
  lastText: string;
  checkpointText: string | undefined;
  repeatedReplies: number;
  toolsSinceCheckpoint: boolean;
  cancelTimer?: () => void;
};

// Dependency injection keeps the in-terminal self-test independent of real timers.
export interface LoopRuntime {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const defaultRuntime: LoopRuntime = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export function parseLoopArguments(input: string): LoopOptions {
  let rest = input.trim();
  let max = DEFAULT_MAX;
  let minutes = DEFAULT_MINUTES;
  const seen = new Set<string>();
  while (rest.startsWith("--")) {
    if (/^--(?:\s|$)/.test(rest)) {
      rest = rest.slice(2).trim();
      break;
    }
    const option = rest.match(/^--(max|minutes)(?:\s+|=)(\S+)(?:\s+|$)/);
    if (!option) throw new Error("Unbekannte Option. Siehe /loop help.");
    const [, name, raw] = option;
    const value = Number(raw);
    const upper = name === "max" ? 100 : 120;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > upper) {
      throw new Error(`--${name} muss eine ganze Zahl von 1 bis ${upper} sein.`);
    }
    if (seen.has(name)) throw new Error(`--${name} wurde mehrfach angegeben.`);
    seen.add(name);
    if (name === "max") max = value;
    else minutes = value;
    rest = rest.slice(option[0].length).trim();
  }
  if (!rest) throw new Error("Bitte eine Aufgabe angeben. Siehe /loop help.");
  return { task: rest, max, minutes };
}

function instructions(run: LoopState): string {
  return [
    `Interne Loop-Steuerung. Aufgabe:\n${run.task}`,
    `Bisher ${run.rounds}/${run.max} Modellrunden; maximal ${run.minutes} Minuten insgesamt.`,
    "Erledige den ursprünglichen Auftrag vollständig. Eine Analyse, ein Plan oder eine Teillösung sind kein Abschluss, wenn der Auftrag eine Umsetzung verlangt.",
    "Arbeite konkret weiter: untersuchen, umsetzen, passende Tests/Prüfungen ausführen und Ergebnisse prüfen. Wenn noch Arbeit offen ist, erledige den nächsten sinnvollen Schritt statt nur weitere Arbeit anzukündigen oder auf ein Weiter vom Benutzer zu warten.",
    "Triff normale technische Entscheidungen selbst anhand der Projektkonventionen. Arbeite bei unwesentlichen Unklarheiten mit plausiblen Annahmen weiter. Frage dafür nicht nach Bestätigung.",
    "Bleibe beim Auftrag und beachte seine Vorgaben. Keine zusätzlichen riskanten Aktionen, Deployments oder destruktiven Änderungen ohne nötige Zustimmung.",
    "Fehlgeschlagene Tests, gewöhnliche Implementierungsprobleme oder größere Restarbeit sind für sich keine Blockade. Untersuche die Ursache und versuche sinnvolle Lösungen innerhalb des Auftrags und der Limits.",
    "Erfinde keine Testergebnisse. Falls Tests nicht ausführbar sind, benenne das ausdrücklich.",
    'Prüfe vor dem Abschluss den gesamten ursprünglichen Auftrag, nicht nur den letzten Arbeitsschritt. Erst wenn das Ziel vollständig erreicht und angemessen geprüft ist: rufe als letzte Aktion loop_finish mit status "done" und einer verständlichen Zusammenfassung inklusive Prüfergebnissen auf.',
    'Nur wenn ein echtes Hindernis die erforderliche Arbeit verhindert und du es mit den verfügbaren Mitteln nicht sinnvoll beheben kannst, etwa zwingend fehlende Informationen, Zugangsdaten, Berechtigungen oder eine nicht verfügbare Umgebung: rufe loop_finish mit status "blocked" auf. Beschreibe in summary konkret das Hindernis, gegebenenfalls deine Lösungsversuche und was zum Fortsetzen fehlt.',
    "Der Abschlussbefehl zeigt die Zusammenfassung direkt an; eine zusätzliche Antwort danach ist nicht nötig. Rufe ihn nicht zusammen mit anderen Tools auf.",
    "Keine technischen Abschlussmarker, UUIDs oder internen Steueranweisungen in die Antwort schreiben. Das alte Textmarker-Protokoll ist ersetzt.",
  ].join("\n\n");
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Presentation-only compatibility for completed messages from the old extension.
// Keep quoted examples, ordinary text, user messages and the stored transcript intact.
export function hideLegacyLoopMarker(markdown: string): string {
  const marker = /(?:^|\r?\n)[ \t]*\[LOOP_(?:DONE|BLOCKED):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\][ \t\r\n]*$/i;
  return marker.test(markdown) ? markdown.replace(marker, "").trimEnd() : markdown;
}

export function installLoop(pi: ExtensionAPI, runtime: LoopRuntime = defaultRuntime): void {
  let active: LoopState | undefined;
  let lastStatus = "Noch kein Loop in dieser Sitzung gestartet.";

  function setFinishToolActive(enabled: boolean): void {
    const tools = pi.getActiveTools();
    if (enabled && !tools.includes(FINISH_TOOL)) pi.setActiveTools([...tools, FINISH_TOOL]);
    else if (!enabled && tools.includes(FINISH_TOOL)) pi.setActiveTools(tools.filter((name) => name !== FINISH_TOOL));
  }

  function updateStatus(ctx: ExtensionContext, run: LoopState): void {
    const elapsed = formatDuration(runtime.now() - run.startedAt);
    ctx.ui.setStatus(STATUS_KEY, `↻ Loop · ${run.rounds}/${run.max} Runden · ${elapsed} / ${run.minutes}:00`);
  }

  function reset(ctx: ExtensionContext): void {
    active?.cancelTimer?.();
    active = undefined;
    setFinishToolActive(false);
    lastStatus = "Noch kein Loop in dieser Sitzung gestartet.";
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function finish(ctx: ExtensionContext, reason: string, abort = false, success = false): void {
    const run = active;
    if (!run) return;
    // Clear ownership before aborting: abort and shutdown can dispatch more events.
    active = undefined;
    run.cancelTimer?.();
    setFinishToolActive(false);
    const elapsed = formatDuration(runtime.now() - run.startedAt);
    const shortStatus = `${reason} · ${run.rounds}/${run.max} Runden · ${elapsed}`;
    lastStatus = `${shortStatus}\nAufgabe: ${run.task}`;
    if (run.completion) lastStatus += `\n${run.completion.summary}`;
    ctx.ui.setStatus(STATUS_KEY, `${success ? "✓" : "■"} Loop · ${shortStatus}`);
    ctx.ui.notify(`Loop: ${shortStatus}`, success ? "info" : "warning");
    if (abort) ctx.abort();
  }

  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "assistant" ? hideLegacyLoopMarker(markdown) : markdown,
  );

  pi.registerTool({
    name: FINISH_TOOL,
    label: "Loop-Abschluss",
    description: "Beende den aktiven Arbeitsloop als fertig oder blockiert. Nur als letzte Aktion und nicht gemeinsam mit anderen Tools aufrufen. Die Zusammenfassung wird dem Benutzer direkt angezeigt.",
    exposure: "model-only",
    defaultActive: false,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({
      status: StringEnum(["done", "blocked"] as const),
      summary: Type.String({ minLength: 1, maxLength: 4000, description: "Verständliches Ergebnis mit Prüfungen; bei Blockade das Hindernis und die benötigte Rückmeldung." }),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Der Loop wurde abgebrochen.");
      const run = active;
      if (!run) throw new Error("Kein Loop aktiv.");
      if (run.completion) throw new Error("Der Loop-Abschluss wurde bereits gemeldet.");
      const summary = params.summary.trim();
      if (!summary) throw new Error("Eine verständliche Zusammenfassung ist erforderlich.");
      if (params.status !== "done" && params.status !== "blocked") throw new Error("Ungültiger Abschlussstatus.");
      const completion: LoopCompletion = { status: params.status, summary };
      // Defer cleanup to turn_end: sibling tool results must finish and persist first.
      run.completion = completion;
      return {
        content: [{ type: "text", text: `${params.status === "done" ? "Fertig" : "Blockiert"}: ${summary}` }],
        details: completion,
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("muted", "Loop abschließen"), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as LoopCompletion | undefined;
      if (context.isError || !details) {
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        return new Text(theme.fg(context.isError ? "error" : "muted", text), 0, 0);
      }
      const title = details.status === "done" ? theme.fg("success", "✓ Fertig") : theme.fg("warning", "■ Blockiert – deine Rückmeldung ist nötig");
      return new Text(`${title}\n${details.summary}`, 0, 0);
    },
  });

  pi.registerCommand("loop", {
    description: "Autonom arbeiten: /loop [--max N] [--minutes N] <Aufgabe>; status/stop/test/help",
    getArgumentCompletions(prefix) {
      return ["status", "stop", "test", "help", "--max", "--minutes"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text || text === "help" || text === "--help") {
        ctx.ui.notify(HELP, "info");
        return;
      }
      if (text === "status") {
        const run = active;
        ctx.ui.notify(run
          ? `Loop läuft · ${run.rounds}/${run.max} Runden · ${formatDuration(runtime.now() - run.startedAt)} / ${run.minutes}:00\nAufgabe: ${run.task}`
          : lastStatus, "info");
        return;
      }
      if (text === "stop") {
        if (active) finish(ctx, "Manuell gestoppt", true);
        else ctx.ui.notify("Kein Loop aktiv.", "info");
        return;
      }
      if (active || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Pi arbeitet bereits. Erst mit Esc oder /loop stop anhalten.", "warning");
        return;
      }
      if (text === "test") {
        try {
          const { runLoopTests } = await import("./self-test.ts");
          const count = await runLoopTests();
          ctx.ui.notify(`Loop-Selbsttest: ${count} Tests bestanden (ohne Modellaufrufe).`, "info");
        } catch (error) {
          ctx.ui.notify(`Loop-Selbsttest fehlgeschlagen: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, "error");
        }
        return;
      }
      let options: LoopOptions;
      try {
        options = parseLoopArguments(text);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const run: LoopState = {
        ...options,
        rounds: 0,
        startedAt: runtime.now(),
        initialPrompt: options.task,
        lastText: "",
        checkpointText: undefined,
        repeatedReplies: 0,
        toolsSinceCheckpoint: false,
      };
      active = run;
      try {
        setFinishToolActive(true);
        run.cancelTimer = runtime.schedule(() => {
          if (active === run) finish(ctx, "Zeitlimit erreicht", true);
        }, run.minutes * 60_000);
        updateStatus(ctx, run);
        ctx.ui.notify(`Loop gestartet · bis zu ${run.max} Runden / ${run.minutes} Minuten · Esc zum Stoppen`, "info");
        // Only the actual task appears in the chat; controls are added invisibly below.
        pi.sendUserMessage(run.initialPrompt);
      } catch (error) {
        finish(ctx, `Start fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.on("input", (event, ctx) => {
    if (active && !(event.source === "extension" && event.text === active.initialPrompt)) {
      finish(ctx, "Automatische Fortsetzung durch neue Eingabe beendet");
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const run = active;
    if (!run) return;
    if (event.messageType !== "user" || event.prompt !== run.initialPrompt) {
      finish(ctx, "Andere Anfrage gestartet");
      return;
    }
    return { message: { customType: STATUS_KEY, content: instructions(run), display: false } };
  });

  pi.on("turn_start", (_event, ctx) => {
    const run = active;
    if (!run) return;
    if (run.rounds >= run.max) {
      finish(ctx, "Rundenlimit erreicht", true);
      return;
    }
    run.rounds++;
    updateStatus(ctx, run);
  });

  pi.on("tool_execution_start", () => {
    if (active) active.toolsSinceCheckpoint = true;
  });

  pi.on("turn_end", (event, ctx) => {
    const run = active;
    if (!run) return;
    if (event.outcome === "aborted") {
      finish(ctx, "Abgebrochen");
      return;
    }
    if (run.completion) {
      const accepted = event.toolResults.some((result) => result.toolName === FINISH_TOOL && !result.isError);
      if (event.outcome === "completed" && accepted) {
        const done = run.completion.status === "done";
        finish(ctx, done ? "Fertig" : "Blockiert", false, done);
        return;
      }
      // A tool_result hook may have rejected the completion; never report false success.
      run.completion = undefined;
    }
    const message = event.message;
    if (message.role === "assistant") {
      run.lastText = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n").trim();
    }
    // Cap tool-driven turns as well as extension-driven continuations.
    // Abort only after this turn's tool results have been persisted.
    if (run.rounds >= run.max) finish(ctx, "Rundenlimit erreicht", true);
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const run = active;
    if (!run) return;
    if (event.outcome !== "completed") {
      finish(ctx, event.outcome === "aborted" ? "Abgebrochen" : "Nach Pi-Wiederholungsversuchen mit Fehler beendet");
      return;
    }
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) {
      finish(ctx, "Andere Anfrage wartet");
      return;
    }
    // Another extension may already have requested the next turn.
    if (event.continue) return;
    run.repeatedReplies = !run.toolsSinceCheckpoint && run.checkpointText === run.lastText
      ? run.repeatedReplies + 1 : 1;
    run.checkpointText = run.lastText;
    run.toolsSinceCheckpoint = false;
    if (run.repeatedReplies >= 3) {
      finish(ctx, "Drei gleiche Antworten ohne weitere Tool-Arbeit – bitte Aufgabe präzisieren");
      return;
    }
    // A boundary entry supplies runnable context atomically; no queued /loop messages
    // can survive Stop, Escape, reload or a session switch.
    return {
      entries: [{
        type: "custom_message",
        customType: STATUS_KEY,
        content: instructions(run),
        display: false,
      }],
      continue: true,
    };
  });

  pi.on("agent_settled", (event, ctx) => {
    if (active) finish(ctx, event.aborted ? "Abgebrochen" : "Lauf ohne weitere Fortsetzung beendet");
  });
  pi.on("session_before_tree", (_event, ctx) => {
    finish(ctx, "Wegen Session-Navigation beendet");
  });
  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
}

export default function loopExtension(pi: ExtensionAPI): void {
  installLoop(pi);
}
