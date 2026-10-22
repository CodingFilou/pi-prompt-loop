import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, hideLegacyLoopMarker, installLoop, parseLoopArguments } from "./index.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;
type Completion = { status: "done" | "blocked"; summary: string };
const LEGACY_ID = "00000000-0000-4000-8000-000000000000";
const LEGACY_DONE = `[LOOP_DONE:${LEGACY_ID}]`;
const LEGACY_BLOCKED = `[LOOP_BLOCKED:${LEGACY_ID}]`;
const theme = { fg: (_color: string, text: string) => text };

function harness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, any>();
  const transformers: Array<(text: string, context: any) => string> = [];
  const messages: string[] = [];
  const controls: any[] = [];
  const notices: Array<{ text: string; type: string | undefined }> = [];
  const statuses = new Map<string, string | undefined>();
  const timers: Array<{ callback: () => void; at: number; cancelled: boolean }> = [];
  let activeTools = ["read", "powershell", "edit", "write"];
  let time = 0;
  let idle = true;
  let pending = false;
  let aborts = 0;
  let failSend = false;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (text: string, type?: string) => notices.push({ text, type }),
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort: () => { aborts++; idle = true; },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand(name: string, command: { handler: Command }) { commands.set(name, command.handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    registerMarkdownTransformer(transformer: (text: string, context: any) => string) { transformers.push(transformer); },
    sendUserMessage(text: string) {
      if (failSend) throw new Error("simulierter Startfehler");
      messages.push(text);
      idle = false;
    },
  } as unknown as ExtensionAPI;
  installLoop(pi, {
    now: () => time,
    schedule(callback, delayMs) {
      const timer = { callback, at: time + delayMs, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  async function emit(name: string, fields: Record<string, unknown> = {}) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...fields }, ctx);
    if (name === "agent_settled") idle = true;
    if (name === "before_agent_start" && result?.message) controls.push(result.message);
    return result;
  }
  const command = (text: string) => commands.get("loop")!(text, ctx as any);
  async function start(text = "Prüfe die Tests.") {
    await command(text);
    const prompt = messages.at(-1)!;
    assert.ok(prompt);
    await emit("input", { text: prompt, source: "extension" });
    await emit("before_agent_start", { messageType: "user", prompt });
  }
  const callFinish = (completion: Completion, signal?: AbortSignal) =>
    tools.get("loop_finish").execute("finish-test", completion, signal, undefined, ctx);
  async function turn(text: string, options: {
    tool?: boolean; thinking?: string; stopReason?: string; outcome?: string; toolText?: string;
    finish?: Completion; finishResultError?: boolean;
  } = {}) {
    await emit("turn_start");
    const toolResults: any[] = [];
    const calls: any[] = [];
    if (options.tool) {
      await emit("tool_execution_start", { toolName: "read" });
      calls.push({ type: "toolCall", id: "read-test", name: "read", arguments: {} });
      toolResults.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: options.toolText ?? "OK" }] });
    }
    if (options.finish) {
      await emit("tool_execution_start", { toolName: "loop_finish" });
      const result = await callFinish(options.finish);
      calls.push({ type: "toolCall", id: "finish-test", name: "loop_finish", arguments: options.finish });
      toolResults.push({ role: "toolResult", toolName: "loop_finish", ...result, isError: options.finishResultError ?? false });
    }
    return emit("turn_end", {
      outcome: options.outcome ?? "completed",
      message: {
        role: "assistant",
        stopReason: options.stopReason ?? (calls.length ? "toolUse" : "stop"),
        content: [
          ...(options.thinking ? [{ type: "thinking", thinking: options.thinking }] : []),
          { type: "text", text }, ...calls,
        ],
      },
      toolResults,
    });
  }
  const settle = (fields: Record<string, unknown> = {}) => emit("agent_before_settle", {
    outcome: "completed", continue: false, context: { pendingMessages: [] }, ...fields,
  });
  return {
    messages, controls, notices, timers, tools, command, start, turn, settle, emit, callFinish,
    activeTools: () => [...activeTools],
    addTool: (name: string) => { activeTools.push(name); },
    transform: (text: string, messageType = "assistant") => transformers.reduce((value, transform) =>
      transform(value, { messageType, isStreaming: false, availableWidth: 80 }), text),
    status: () => statuses.get("autonomous-loop"),
    aborts: () => aborts,
    setIdle: (value: boolean) => { idle = value; },
    setPending: (value: boolean) => { pending = value; },
    setFailSend: () => { failSend = true; },
    advance(ms: number) {
      time += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= time) {
          timer.cancelled = true;
          timer.callback();
        }
      }
    },
    cleanup: () => emit("session_shutdown", { reason: "reload" }),
  };
}

// Run only on demand. All session actions and clocks are mocked. No model,
// network, shell, real timer or file write is involved in these unit tests.
export async function runLoopTests(): Promise<number> {
  let passed = 0;
  async function test(name: string, body: (h: ReturnType<typeof harness>) => Promise<void> | void) {
    const h = harness();
    try {
      await body(h);
      passed++;
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await h.cleanup();
    }
  }

  await test("Argumente und Standardwerte", () => {
    assert.deepEqual(parseLoopArguments("  Aufgabe\nmit Details  "), { task: "Aufgabe\nmit Details", max: 30, minutes: 30 });
    assert.deepEqual(parseLoopArguments("--minutes=2 --max 4 Aufgabe"), { task: "Aufgabe", max: 4, minutes: 2 });
    assert.equal(parseLoopArguments("--\t--Aufgabe").task, "--Aufgabe");
    assert.equal(parseLoopArguments("Aufgabe --max ist Teil des Textes").max, 30);
  });
  await test("Ungültige Argumente", () => {
    for (const input of ["", "--max", "--max 0 x", "--max -1 x", "--max 101 x", "--max 1.5 x", "--max 2e1 x", "--max NaN x", "--minutes 121 x", "--minutes 0 x", "--max 2", "--max 2 --max 3 x", "--unbekannt x"]) {
      assert.throws(() => parseLoopArguments(input), undefined, input);
    }
  });
  await test("Factory und Hilfe starten nichts", async (h) => {
    assert.equal(h.timers.length, 0);
    assert.equal(h.activeTools().includes("loop_finish"), false);
    await h.command("");
    await h.command("help");
    await h.command("--max 0 Aufgabe");
    assert.equal(h.messages.length, 0);
    assert.equal(h.timers.length, 0);
  });
  await test("Sichtbar ist nur die Aufgabe, nicht das Protokoll", async (h) => {
    await h.start();
    assert.equal(h.messages[0], "Prüfe die Tests.");
    assert.equal(h.controls[0].display, false);
    assert.match(h.controls[0].content, /loop_finish/);
    assert.doesNotMatch(h.controls[0].content, /\[LOOP_|[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.equal(h.activeTools().includes("loop_finish"), true);
  });
  await test("Lesbarer Start und Status mit Dauer", async (h) => {
    await h.start();
    assert.match(h.status()!, /↻ Loop · 0\/30 Runden · 0:00/);
    h.advance(12_000);
    await h.command("status");
    assert.match(h.notices.at(-1)!.text, /0:12/);
    assert.match(h.notices.at(-1)!.text, /Prüfe die Tests/);
  });
  await test("Unfertige Antwort setzt atomar und unsichtbar fort", async (h) => {
    await h.start();
    await h.turn("Es gibt noch Arbeit.");
    const result = await h.settle();
    assert.equal(result.continue, true);
    assert.equal(result.entries[0].type, "custom_message");
    assert.equal(result.entries[0].display, false);
    assert.match(result.entries[0].content, /loop_finish/);
    assert.equal(h.messages.length, 1);
  });
  await test("Plan, Teillösung und Testfehler setzen denselben Auftrag eigenständig fort", async (h) => {
    const task = "Schreibe dieses Projekt vollständig in Rust um.";
    await h.start(task);
    const controls = [h.controls[0]];
    for (const reply of ["Hier ist mein Plan.", "Das Grundgerüst ist umgesetzt; der Rest fehlt noch.", "Die Tests schlagen noch fehl."]) {
      await h.turn(reply);
      const result = await h.settle();
      assert.equal(result.continue, true);
      controls.push(result.entries[0]);
    }
    for (const control of controls) {
      assert.equal(control.display, false);
      assert.ok(control.content.includes(task));
      assert.match(control.content, /Eine Analyse, ein Plan oder eine Teillösung sind kein Abschluss/);
      assert.match(control.content, /Triff normale technische Entscheidungen selbst/);
      assert.match(control.content, /Frage dafür nicht nach Bestätigung/);
      assert.match(control.content, /Fehlgeschlagene Tests.*sind für sich keine Blockade/);
      assert.match(control.content, /Prüfe vor dem Abschluss den gesamten ursprünglichen Auftrag/);
      assert.match(control.content, /Nur wenn ein echtes Hindernis/);
      assert.match(control.content, /beachte seine Vorgaben/);
    }
    assert.equal(h.messages.length, 1);
    assert.equal(h.aborts(), 0);
  });
  await test("Abschlussbefehl gewinnt auch in letzter Runde", async (h) => {
    await h.start("--max 1 Aufgabe");
    await h.turn("", { finish: { status: "done", summary: "Tests erfolgreich." } });
    assert.match(h.status()!, /✓ Loop · Fertig · 1\/1/);
    assert.equal(h.aborts(), 0);
    assert.equal(h.timers[0].cancelled, true);
    assert.equal(h.activeTools().includes("loop_finish"), false);
    assert.equal(await h.settle(), undefined);
    await h.command("status");
    assert.match(h.notices.at(-1)!.text, /Tests erfolgreich/);
  });
  await test("Blockiertmeldung erklärt das Hindernis ohne Kennung", async (h) => {
    await h.start();
    await h.turn("", { finish: { status: "blocked", summary: "Welchen Projektordner soll ich prüfen?" } });
    assert.match(h.status()!, /Loop · Blockiert/);
    assert.equal(await h.settle(), undefined);
    assert.equal(h.timers[0].cancelled, true);
    await h.command("status");
    assert.match(h.notices.at(-1)!.text, /Welchen Projektordner/);
    assert.doesNotMatch(h.notices.at(-1)!.text, /LOOP_BLOCKED/);
  });
  await test("Alte Textmarker beenden keinen neuen Loop", async (h) => {
    await h.start();
    await h.turn(LEGACY_DONE);
    assert.equal((await h.settle()).continue, true);
    await h.turn(LEGACY_BLOCKED);
    assert.equal((await h.settle()).continue, true);
  });
  await test("Thinking und Tool-Text können den Loop nicht beenden", async (h) => {
    await h.start();
    await h.turn("Noch offen.", { thinking: LEGACY_DONE });
    assert.equal((await h.settle()).continue, true);
    await h.turn("Datei lesen.", { tool: true, toolText: "Fertig. " + LEGACY_DONE });
    assert.match(h.status()!, /2\/30/);
  });
  await test("Tool-Runden zählen zum Rundenlimit", async (h) => {
    await h.start("--max 2 Aufgabe");
    await h.turn("Lesen.", { tool: true });
    assert.equal(h.aborts(), 0);
    await h.turn("Weiterlesen.", { tool: true });
    assert.equal(h.aborts(), 1);
    assert.match(h.status()!, /Rundenlimit erreicht · 2\/2/);
    assert.equal(await h.settle(), undefined);
  });
  await test("Fortsetzungen zählen zum selben Rundenlimit", async (h) => {
    await h.start("--max 2 Aufgabe");
    await h.turn("Schritt eins.");
    assert.equal((await h.settle()).continue, true);
    await h.turn("Schritt zwei.");
    assert.match(h.status()!, /Rundenlimit erreicht/);
    assert.equal(h.aborts(), 1);
  });
  await test("Manueller Stop und alter Timer starten nichts neu", async (h) => {
    await h.start();
    const oldTimer = h.timers[0];
    await h.command("stop");
    assert.equal(h.aborts(), 1);
    assert.equal(oldTimer.cancelled, true);
    assert.equal(await h.settle(), undefined);
    await h.start("Neue Aufgabe");
    oldTimer.callback();
    assert.match(h.status()!, /0\/30/);
    assert.equal(h.aborts(), 1);
  });
  await test("Stop ohne Loop unterbricht keine andere Arbeit", async (h) => {
    h.setIdle(false);
    await h.command("stop");
    assert.equal(h.aborts(), 0);
  });
  await test("Escape wird nicht automatisch fortgesetzt", async (h) => {
    await h.start();
    assert.equal(await h.settle({ outcome: "aborted" }), undefined);
    assert.match(h.status()!, /Abgebrochen/);
    assert.equal(h.timers[0].cancelled, true);
  });
  await test("Pi darf native Fehlerwiederholung zuerst versuchen", async (h) => {
    await h.start();
    await h.turn("Netzwerkfehler", { stopReason: "error", outcome: "error" });
    assert.match(h.status()!, /1\/30/);
    await h.turn("", { finish: { status: "done", summary: "Wiederhergestellt und geprüft." } });
    assert.match(h.status()!, /Fertig/);
  });
  await test("Ausgeschöpfte Fehlerwiederholung stoppt", async (h) => {
    await h.start();
    assert.equal(await h.settle({ outcome: "error" }), undefined);
    assert.match(h.status()!, /Fehler/);
  });
  await test("Drei identische Antworten ohne Tools stoppen", async (h) => {
    await h.start();
    for (let i = 0; i < 3; i++) {
      await h.turn("Ich werde weiterarbeiten.");
      assert.equal((await h.settle())?.continue, i < 2 ? true : undefined);
    }
    assert.match(h.status()!, /Drei gleiche Antworten/);
  });
  await test("Tool-Arbeit setzt Wiederholungszähler zurück", async (h) => {
    await h.start();
    for (let i = 0; i < 4; i++) {
      await h.turn("Datei prüfen.", { tool: true });
      await h.turn("Noch Arbeit offen.");
      assert.equal((await h.settle()).continue, true);
    }
  });
  await test("Neue Benutzereingabe hat Vorrang", async (h) => {
    await h.start();
    assert.deepEqual(await h.emit("input", { source: "interactive", text: "Andere Frage" }), { action: "continue" });
    assert.equal(await h.settle(), undefined);
    assert.match(h.status()!, /neue Eingabe/);
    assert.equal(h.aborts(), 0);
  });
  await test("Andere Extensions dürfen den Loop unterbrechen", async (h) => {
    await h.start();
    await h.emit("input", { source: "extension", text: "Andere Aufgabe" });
    assert.equal(await h.settle(), undefined);
  });
  await test("Andere Custom-Anfrage beendet Loop", async (h) => {
    await h.start();
    await h.emit("before_agent_start", { messageType: "custom" });
    assert.match(h.status()!, /Andere Anfrage/);
  });
  await test("Busy, Warteschlange und doppelter Start werden abgelehnt", async (h) => {
    h.setIdle(false);
    await h.command("Aufgabe");
    assert.equal(h.messages.length, 0);
    h.setIdle(true);
    h.setPending(true);
    await h.command("Aufgabe");
    assert.equal(h.messages.length, 0);
    h.setPending(false);
    await h.start();
    await h.command("Zweiter Loop");
    assert.equal(h.messages.length, 1);
  });
  await test("Wartende Nachrichten verhindern Fortsetzung", async (h) => {
    await h.start();
    assert.equal(await h.settle({ context: { pendingMessages: [{}] } }), undefined);
    assert.match(h.status()!, /Andere Anfrage wartet/);
  });
  await test("Zeitlimit bricht ab und ist idempotent", async (h) => {
    await h.start("--minutes 1 Aufgabe");
    h.advance(59_999);
    assert.equal(h.aborts(), 0);
    h.advance(1);
    assert.equal(h.aborts(), 1);
    assert.match(h.status()!, /Zeitlimit/);
    h.advance(120_000);
    assert.equal(h.aborts(), 1);
  });
  await test("Startfehler räumt Zustand, Tool und Timer auf", async (h) => {
    h.setFailSend();
    await h.command("Aufgabe");
    assert.match(h.status()!, /Start fehlgeschlagen/);
    assert.equal(h.timers[0].cancelled, true);
    assert.equal(h.activeTools().includes("loop_finish"), false);
  });
  await test("Reload/Sessionwechsel startet nichts erneut", async (h) => {
    await h.start();
    await h.emit("session_shutdown", { reason: "resume" });
    await h.emit("session_start", { reason: "resume" });
    assert.equal(h.status(), undefined);
    assert.equal(h.timers[0].cancelled, true);
    assert.equal(h.activeTools().includes("loop_finish"), false);
    assert.equal(await h.settle(), undefined);
    assert.equal(h.messages.length, 1);
  });
  await test("Baumnavigation beendet Loop", async (h) => {
    await h.start();
    await h.emit("session_before_tree");
    assert.equal(await h.settle(), undefined);
    assert.match(h.status()!, /Session-Navigation/);
  });
  await test("Settlement-Fallback räumt nach Abbruch auf", async (h) => {
    await h.start();
    await h.emit("agent_settled", { aborted: true });
    assert.match(h.status()!, /Abgebrochen/);
    assert.equal(h.timers[0].cancelled, true);
  });
  await test("Vorhandene Boundary-Fortsetzung wird nicht verdoppelt", async (h) => {
    await h.start();
    assert.equal(await h.settle({ continue: true }), undefined);
    assert.match(h.status()!, /0\/30/);
  });
  await test("Abschluss-Tool ist nur für das Modell und standardmäßig inaktiv", (h) => {
    const tool = h.tools.get("loop_finish");
    assert.equal(tool.defaultActive, false);
    assert.equal(tool.exposure, "model-only");
    assert.equal(tool.executionMode, "sequential");
  });
  await test("Abschluss ohne aktiven Loop ist ein Fehler", async (h) => {
    await assert.rejects(() => h.callFinish({ status: "done", summary: "Fertig" }), /Kein Loop aktiv/);
  });
  await test("Leere und ungültige Abschlüsse werden abgelehnt", async (h) => {
    await h.start();
    await assert.rejects(() => h.callFinish({ status: "done", summary: "  " }), /Zusammenfassung/);
    await assert.rejects(() => h.callFinish({ status: "falsch" as any, summary: "Test" }), /Abschlussstatus/);
    assert.match(h.status()!, /0\/30/);
  });
  await test("Abgebrochene Abschlussaufrufe ändern den Status nicht", async (h) => {
    await h.start();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => h.callFinish({ status: "done", summary: "Test" }, controller.signal), /abgebrochen/);
    assert.equal((await h.settle()).continue, true);
  });
  await test("Abschluss wird erst nach allen Tool-Ergebnissen wirksam", async (h) => {
    await h.start();
    await h.emit("turn_start");
    const result = await h.callFinish({ status: "done", summary: "  Alles geprüft.  " });
    assert.equal(result.terminate, true);
    assert.equal(result.details.summary, "Alles geprüft.");
    assert.equal(h.timers[0].cancelled, false);
    await assert.rejects(() => h.callFinish({ status: "blocked", summary: "Zweiter Abschluss" }), /bereits gemeldet/);
    await h.emit("turn_end", {
      outcome: "completed", message: { role: "assistant", content: [] },
      toolResults: [{ toolName: "loop_finish", isError: false }],
    });
    assert.match(h.status()!, /Fertig/);
    assert.equal(h.timers[0].cancelled, true);
  });
  await test("Abgelehntes Tool-Ergebnis meldet keinen falschen Erfolg", async (h) => {
    await h.start();
    await h.turn("", { finish: { status: "done", summary: "Test" }, finishResultError: true });
    assert.match(h.status()!, /1\/30/);
    assert.equal((await h.settle()).continue, true);
  });
  await test("Abbruch hat Vorrang vor angefordertem Abschluss", async (h) => {
    await h.start();
    await h.turn("", { finish: { status: "done", summary: "Test" }, outcome: "aborted" });
    assert.match(h.status()!, /Abgebrochen/);
    assert.doesNotMatch(h.status()!, /Fertig/);
  });
  await test("Andere aktivierte Tools bleiben beim Stop erhalten", async (h) => {
    await h.start();
    h.addTool("grep");
    await h.command("stop");
    assert.deepEqual(h.activeTools(), ["read", "powershell", "edit", "write", "grep"]);
  });
  await test("Alte finale Marker verschwinden nur in der Anzeige", (h) => {
    const stored = `Projektpfad fehlt.\n\n${LEGACY_BLOCKED}`;
    assert.equal(h.transform(stored), "Projektpfad fehlt.");
    assert.equal(hideLegacyLoopMarker(`4.\r\n ${LEGACY_DONE} \r\n`), "4.");
    assert.equal(hideLegacyLoopMarker(LEGACY_DONE), "");
    assert.ok(stored.endsWith(LEGACY_BLOCKED), "Original nicht verändern");
  });
  await test("Zitate, Codebeispiele und Benutzereingaben bleiben erhalten", (h) => {
    for (const text of [`> ${LEGACY_DONE}`, `Beispiel: ${LEGACY_DONE}`, `\`\`\`text\n${LEGACY_DONE}\n\`\`\``, `${LEGACY_DONE}\nNoch nicht fertig.`]) {
      assert.equal(h.transform(text), text);
    }
    assert.equal(h.transform(LEGACY_DONE, "user"), LEGACY_DONE);
    assert.equal(h.transform(LEGACY_DONE, "assistant-thinking"), LEGACY_DONE);
  });
  await test("Dauerformatierung", () => {
    assert.equal(formatDuration(-1000), "0:00");
    assert.equal(formatDuration(59_999), "0:59");
    assert.equal(formatDuration(60_000), "1:00");
    assert.equal(formatDuration(7_200_000), "120:00");
  });
  await test("Abschlussdarstellung ist lesbar und passt in schmale Terminals", async (h) => {
    await h.start();
    const tool = h.tools.get("loop_finish");
    const result = await h.callFinish({ status: "blocked", summary: "Bitte Projektordner nennen. Rückfrage mit Umlauten: prüfen, ändern, lösen." });
    const call = tool.renderCall({}, theme, {});
    assert.equal(call.render(80).join("\n").includes("loop_finish"), false);
    for (const width of [12, 24, 80]) {
      const component = tool.renderResult(result, { expanded: false }, theme, { isError: false });
      const lines: string[] = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /LOOP_BLOCKED|[0-9a-f]{8}-/);
    }
    assert.match(tool.renderResult(result, {}, theme, {}).render(80).join("\n"), /Blockiert/);
    const errorResult = { content: [{ type: "text", text: "Kein Loop aktiv." }], details: undefined };
    assert.match(tool.renderResult(errorResult, {}, theme, { isError: true }).render(80).join("\n"), /Kein Loop aktiv/);
  });

  return passed;
}
