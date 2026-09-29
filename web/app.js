/* Team console: single-page app for the multi-model team engine.
   No build step, no dependencies. Structure:
     1. helpers (dom, escaping, redaction, formatting)
     2. event reducer: events -> state
     3. render functions per panel
     4. live streaming + replay
     5. questions (answer forms)
     6. settings page
     7. routing + boot
*/
(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // 1. Helpers
  // ---------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "html") n.innerHTML = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  };

  // Server data is already redacted; this is a last line of defence so a key
  // never reaches the screen even if a model pasted one into a message.
  const KEY_RE = /\b(sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|(?:api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,})/gi;
  const redact = (s) => (s == null ? "" : String(s).replace(KEY_RE, (m) => (m.includes("=") || m.includes(":") ? m.replace(/[A-Za-z0-9_\-./+]{16,}$/, "[redacted]") : "[redacted]")));
  const text = (s) => redact(s);

  const fmtUsd = (n) => "$" + (Number(n) || 0).toFixed(Number(n) >= 10 ? 2 : 4).replace(/(\.\d\d)0+$/, "$1");
  const fmtNum = (n) => (Number(n) || 0).toLocaleString();
  const fmtTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  const fmtMb = (mb) => (mb == null ? "?" : mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB");
  const fmtCtx = (n) => (n == null ? null : n >= 1000 ? Math.round(n / 1000) + "k ctx" : n + " ctx");
  const shortModel = (id) => (id || "").replace(/^models\//, "");

  const AGENT_HUES = 8;
  const agentColorIndex = new Map();
  const agentColor = (memberId) => {
    if (!memberId) return "var(--line-strong)";
    if (!agentColorIndex.has(memberId)) agentColorIndex.set(memberId, agentColorIndex.size % AGENT_HUES);
    return `var(--agent-${agentColorIndex.get(memberId)})`;
  };
  const initials = (label) => {
    const m = /agent\s+([a-z0-9])/i.exec(label || "");
    if (m) return m[1].toUpperCase();
    return (label || "?").trim().slice(0, 2).toUpperCase();
  };

  let toastTimer = null;
  const toast = (msg, isErr = false) => {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  };

  // Access token: the CLI prints a URL like http://127.0.0.1:4310/?t=<token>#/run/<id>.
  // It is kept in sessionStorage and sent with every API call; the URL is cleaned so it is not leaked via history/referrers.
  const TOKEN_KEY = "mmt-token";
  (() => {
    try {
      const qs = new URLSearchParams(location.search);
      const t = qs.get("t");
      if (t) {
        sessionStorage.setItem(TOKEN_KEY, t);
        qs.delete("t");
        const clean = location.pathname + (qs.toString() ? "?" + qs.toString() : "") + location.hash;
        history.replaceState(null, "", clean);
      }
    } catch { /* storage unavailable: token stays in memory only */ }
  })();
  const token = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
  const withToken = (url) => (token() ? url + (url.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(token()) : url);

  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(token() ? { Authorization: "Bearer " + token() } : {}), ...(opts.headers || {}) },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Not authorised: open the dashboard from the URL printed by the CLI (it carries the access token).");
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  };

  // ---------------------------------------------------------------------
  // 2. Reducer
  // ---------------------------------------------------------------------
  const CHANNELS = [
    ["lead", "Lead work"],
    ["verification", "Verification"],
    ["discussion", "Discussion"],
    ["red-team", "Red team"],
    ["meeting", "Meeting"],
    ["specialist", "Specialist"],
    ["system", "System"],
  ];
  const SIDE_TABS = [
    ["questions", "Questions"],
    ["verify", "Verify"],
    ["redteam", "Red team"],
    ["specialist", "Specialist"],
    ["diffs", "Diffs"],
    ["best", "Best"],
    ["resources", "Resources"],
    ["costs", "Costs"],
  ];

  const newState = () => ({
    runId: null,
    request: "",
    mock: false,
    stage: null,
    currentTaskId: null,
    paused: false,
    finished: null,
    errors: [],
    members: [],
    memberById: {},
    spec: null,
    plan: null,
    tasks: {},
    taskOrder: [],
    stageLog: [],
    chat: Object.fromEntries(CHANNELS.map(([c]) => [c, []])),
    verify: [],
    redteam: [],
    specialist: [],
    diffs: [],
    tests: [],
    best: [],
    resourceHost: null,
    resourceChecks: [],
    cost: null,
    costLog: [],
    questions: {},
    questionOrder: [],
    eventCount: 0,
  });

  const stampMember = (s, memberId) => s.memberById[memberId];

  function reduce(s, e) {
    s.eventCount++;
    const d = e.data || {};
    switch (e.type) {
      case "run.started":
        s.runId = e.runId;
        s.request = d.request || "";
        s.mock = !!d.mock;
        break;
      case "run.team":
        s.members = Array.isArray(d.members) ? d.members : [];
        s.memberById = Object.fromEntries(s.members.map((m) => [m.id, m]));
        s.members.forEach((m) => agentColor(m.id));
        break;
      case "run.stage":
        s.stage = d.stage || e.stage || s.stage;
        s.currentTaskId = d.taskId ?? e.taskId ?? null;
        s.stageLog.push({ stage: s.stage, taskId: s.currentTaskId, ts: e.ts });
        if (s.currentTaskId && s.tasks[s.currentTaskId]) s.tasks[s.currentTaskId].stage = s.stage;
        break;
      case "run.paused":
        s.paused = true;
        break;
      case "run.resumed":
        s.paused = false;
        break;
      case "run.finished":
        s.finished = { status: d.status, summary: d.summary, outputDir: d.outputDir, ts: e.ts };
        s.stage = d.status === "ok" ? "done" : d.status === "failed" ? "failed" : s.stage;
        break;
      case "run.error":
        s.errors.push({ message: d.message, stage: d.stage, taskId: d.taskId, ts: e.ts });
        pushChat(s, "system", { ts: e.ts, label: "Error", message: d.message, system: true });
        break;
      case "spec.written":
        s.spec = d.spec;
        break;
      case "plan.written":
        s.plan = d.plan;
        for (const t of d.plan?.tasks || []) {
          if (!s.tasks[t.id]) s.taskOrder.push(t.id);
          s.tasks[t.id] = { ...(s.tasks[t.id] || {}), task: t, status: s.tasks[t.id]?.status || "pending" };
        }
        break;
      case "task.started":
        if (d.task) {
          if (!s.tasks[d.task.id]) s.taskOrder.push(d.task.id);
          s.tasks[d.task.id] = { ...(s.tasks[d.task.id] || {}), task: d.task, status: "running", startedAt: e.ts, resumed: !!d.resumed };
        }
        break;
      case "task.finished":
        if (d.taskId) {
          const t = s.tasks[d.taskId] || (s.taskOrder.push(d.taskId), (s.tasks[d.taskId] = { task: { id: d.taskId, title: d.taskId } }));
          t.status = d.status || "ok";
          t.summary = d.summary;
          t.finishedAt = e.ts;
        }
        break;
      case "question.asked":
        if (d.question) {
          if (!s.questions[d.question.id]) s.questionOrder.push(d.question.id);
          s.questions[d.question.id] = { question: d.question, ts: e.ts, answer: null };
        }
        break;
      case "question.answered":
        if (d.questionId && s.questions[d.questionId]) s.questions[d.questionId].answer = d.answer || { text: "" };
        break;
      case "chat.message": {
        const ch = CHANNELS.some(([c]) => c === d.channel) ? d.channel : "system";
        pushChat(s, ch, { ...d, ts: e.ts, memberId: d.memberId ?? e.memberId, taskId: e.taskId });
        break;
      }
      case "summary.compacted":
        pushChat(s, CHANNELS.some(([c]) => c === d.channel) ? d.channel : "system", {
          ts: e.ts,
          label: "Summary",
          system: true,
          message: `Rounds up to ${d.upToRound} were summarised:\n${d.summary || ""}`,
        });
        break;
      case "verify.result":
        s.verify.push({ ...d.result, taskId: d.taskId ?? e.taskId, ts: e.ts });
        break;
      case "redteam.critique":
        s.redteam.push({ ...d.critique, taskId: d.taskId ?? e.taskId, ts: e.ts });
        break;
      case "specialist.action":
        s.specialist.push({ ...d, taskId: d.taskId ?? e.taskId, memberId: d.memberId ?? e.memberId, ts: e.ts });
        break;
      case "sandbox.diff":
        s.diffs.push({ ...d, memberId: d.memberId ?? e.memberId, taskId: e.taskId, ts: e.ts });
        break;
      case "tests.run":
        s.tests.push({ ...d, memberId: d.memberId ?? e.memberId, taskId: e.taskId, ts: e.ts });
        s.best.push({ kind: "tests", memberId: d.memberId ?? e.memberId, testRun: d.testRun, candidate: d.candidate, taskId: e.taskId, ts: e.ts });
        break;
      case "best.crowned":
        s.best.push({ kind: "crowned", best: d.best, ts: e.ts });
        break;
      case "best.rejected":
        s.best.push({ kind: "rejected", memberId: d.memberId ?? e.memberId, reason: d.reason, testRun: d.testRun, ts: e.ts });
        break;
      case "best.stalled":
        s.best.push({ kind: "stalled", taskId: d.taskId ?? e.taskId, attempts: d.attempts, ts: e.ts });
        break;
      case "cost.update":
        s.cost = d;
        break;
      case "llm.call":
        if (d.usage || d.costUsd != null) s.costLog.push({ ...d, stage: e.stage, taskId: e.taskId, ts: e.ts });
        break;
      case "resource.host":
        s.resourceHost = d.host;
        break;
      case "resource.check":
        s.resourceChecks.push({ ...d, ts: e.ts });
        break;
      case "member.disabled":
        if (s.memberById[d.memberId]) s.memberById[d.memberId].disabledReason = d.reason;
        pushChat(s, "system", { ts: e.ts, label: "System", system: true, message: `${labelOf(s, d.memberId)} was disabled: ${d.reason || ""}` });
        break;
      default:
        break;
    }
    return s;
  }
  const pushChat = (s, ch, m) => s.chat[ch].push(m);
  const labelOf = (s, memberId) => stampMember(s, memberId)?.label || memberId || "?";
  const modelOf = (s, memberId) => stampMember(s, memberId)?.modelId || "";

  // ---------------------------------------------------------------------
  // 3. Rendering
  // ---------------------------------------------------------------------
  const ui = {
    state: newState(),
    runs: [],
    activeChannel: "lead",
    activeSide: "questions",
    chatRendered: Object.fromEntries(CHANNELS.map(([c]) => [c, 0])),
    chatRenderedRound: Object.fromEntries(CHANNELS.map(([c]) => [c, null])),
    sideRendered: {},
    followChat: true,
  };

  function renderAll() {
    renderHeader();
    renderTimeline();
    renderRoster();
    renderChannelTabs();
    renderChat();
    renderSideTabs();
    renderSide();
  }

  function renderHeader() {
    const s = ui.state;
    const badge = $("#stage-badge");
    const stage = s.stage || (s.runId ? "setup" : null);
    badge.textContent = stage ? (s.paused ? `${stage} (paused)` : stage) : "no run";
    badge.className = "stage-badge" + (stage === "done" ? " is-done" : stage === "failed" ? " is-failed" : stage ? " is-active" : "");
    const c = s.cost;
    $("#total-usd").textContent = fmtUsd(c?.totalUsd || 0) + (s.mock ? " (simulated)" : "");
    $("#total-usd").title = s.mock ? "Mock provider: costs are simulated, nothing was billed" : "Live cost so far";
    const tk = c?.totalTokens || {};
    const tot = (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0);
    $("#total-tokens").textContent = c ? `${fmtNum(tot)} tokens (${fmtNum(tk.input || 0)} in / ${fmtNum(tk.output || 0)} out${tk.reasoning ? ` / ${fmtNum(tk.reasoning)} reasoning` : ""})` : "0 tokens";
    const live = !!ui.live && !s.finished;
    $("#btn-pause").disabled = !live || s.paused;
    $("#btn-resume").disabled = !live || !s.paused;
    $("#btn-stop").disabled = !live;
    $("#run-live").hidden = !live;
    document.title = s.runId ? `${stage || "run"} · Team console` : "Team console";
  }

  function renderTimeline() {
    const s = ui.state;
    const root = $("#timeline");
    root.replaceChildren();
    if (!s.runId && !s.taskOrder.length) {
      root.append(el("div", { class: "empty" }, "Select a run to see its plan."));
      return;
    }
    if (s.request) root.append(el("div", { class: "tl-item is-ok" }, el("div", { class: "tl-title" }, "Request"), el("div", { class: "tl-summary" }, text(s.request))));
    const pre = ["setup", "clarify", "plan"].filter((st) => s.stageLog.some((l) => l.stage === st));
    for (const st of pre) {
      const done = s.stage !== st;
      root.append(el("div", { class: "tl-item " + (done ? "is-ok" : "is-running") }, el("div", { class: "tl-title" }, st)));
    }
    for (const id of s.taskOrder) {
      const t = s.tasks[id];
      const task = t.task || {};
      const cls = t.status === "running" ? "is-running" : t.status === "ok" ? "is-ok" : t.status === "partial" ? "is-partial" : t.status === "failed" ? "is-failed" : "";
      const meta = el("div", { class: "tl-meta" }, el("span", { class: "chip", title: task.workTypeFallbackNote || "Work type" }, task.workType || "?"), el("span", { class: "chip " + (t.status || "") }, t.status || "pending"), t.resumed ? el("span", { class: "chip", title: "Replayed from the checkpoint of an earlier run; not redone" }, "resumed") : null);
      if (t.status === "running" && s.currentTaskId === id && s.stage) meta.append(el("span", { class: "tl-stage" }, "stage: " + s.stage));
      const node = el(
        "div",
        { class: "tl-item " + cls },
        el("div", { class: "tl-title" }, el("span", { class: "tl-id" }, task.id), el("span", null, text(task.title || task.id))),
        meta,
      );
      if (task.workTypeFallbackNote) node.append(el("div", { class: "tl-summary" }, text(task.workTypeFallbackNote)));
      if (t.summary) node.append(el("div", { class: "tl-summary" }, text(t.summary)));
      root.append(node);
    }
    if (s.finished) {
      root.append(el("div", { class: "tl-item " + (s.finished.status === "ok" ? "is-ok" : s.finished.status === "failed" ? "is-failed" : "is-partial") }, el("div", { class: "tl-title" }, "Finished: " + s.finished.status), s.finished.summary ? el("div", { class: "tl-summary" }, text(s.finished.summary)) : null));
    }
  }

  function renderRoster() {
    const s = ui.state;
    const root = $("#roster");
    root.replaceChildren();
    if (!s.members.length) {
      root.append(el("div", { class: "faint" }, "The team appears once the run has assembled it."));
      return;
    }
    for (const m of s.members) {
      const cap = m.capabilities || {};
      const bits = [];
      if (m.isLead) bits.push("lead");
      if (cap.vision) bits.push("vision");
      if (cap.tools) bits.push("tools");
      root.append(
        el(
          "div",
          { class: "member" + (m.disabledReason ? " is-disabled" : ""), title: m.disabledReason ? `Disabled: ${m.disabledReason}` : m.selectionReason || "" },
          el("span", { class: "avatar", style: `--agent-c:${agentColor(m.id)}` }, initials(m.label)),
          el(
            "div",
            null,
            el("div", { class: "member-label" }, m.label, m.isLead ? el("span", { class: "chip signal" }, "lead") : null, m.disabledReason ? el("span", { class: "chip failed" }, "disabled") : null),
            el("div", { class: "member-model", title: "Never shown to the models" }, shortModel(m.modelId)),
            el("div", { class: "member-meta" }, `${m.providerId || m.endpointId || ""} · reasoning ${m.reasoning || "?"}` + (bits.length > 1 ? " · " + bits.filter((b) => b !== "lead").join(", ") : "")),
          ),
        ),
      );
    }
  }

  function renderChannelTabs() {
    const s = ui.state;
    const root = $("#channel-tabs");
    root.replaceChildren();
    for (const [id, name] of CHANNELS) {
      const n = s.chat[id].length;
      root.append(
        el(
          "button",
          { class: "tab" + (ui.activeChannel === id ? " is-active" : ""), role: "tab", onclick: () => { ui.activeChannel = id; ui.followChat = true; renderChannelTabs(); renderChat(true); } },
          name,
          n ? el("span", { class: "count" }, n) : null,
        ),
      );
    }
  }

  function renderChat(reset = false) {
    const s = ui.state;
    const root = $("#chat");
    const ch = ui.activeChannel;
    const msgs = s.chat[ch];
    if (reset || ui.chatRendered.channel !== ch || ui.chatRendered[ch] > msgs.length) {
      root.replaceChildren();
      ui.chatRendered[ch] = 0;
      ui.chatRenderedRound[ch] = null;
      ui.chatRendered.channel = ch;
    }
    if (!msgs.length) {
      if (!root.childElementCount) root.append(el("div", { class: "empty" }, `Nothing in ${CHANNELS.find(([c]) => c === ch)[1].toLowerCase()} yet.`));
      return;
    }
    if (root.firstElementChild?.classList.contains("empty")) root.replaceChildren();
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
    for (let i = ui.chatRendered[ch]; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.round != null && m.round !== ui.chatRenderedRound[ch]) {
        ui.chatRenderedRound[ch] = m.round;
        root.append(el("div", { class: "round-sep" }, `Round ${m.round}`));
      }
      root.append(renderMessage(m));
    }
    ui.chatRendered[ch] = msgs.length;
    if (ui.followChat && (nearBottom || reset)) root.scrollTop = root.scrollHeight;
  }

  function renderMessage(m) {
    const s = ui.state;
    const isSys = !!m.system || !m.memberId;
    const label = m.label || labelOf(s, m.memberId);
    const color = isSys ? "var(--line-strong)" : agentColor(m.memberId);
    const model = m.model || modelOf(s, m.memberId);
    const head = el("div", { class: "msg-head" }, el("span", { class: "msg-name" }, label));
    if (model) head.append(el("span", { class: "msg-model" }, shortModel(model)));
    if (m.role === "devils-advocate") head.append(el("span", { class: "tag-da", title: "Assigned to argue against the group this round" }, "devil's advocate"));
    if (m.vote) head.append(el("span", { class: "vote " + m.vote, title: "Vote to end or continue the discussion" }, m.vote === "done" ? "votes done" : "votes continue"));
    head.append(el("span", { class: "msg-time" }, fmtTime(m.ts)));
    const body = el("div", { class: "msg-body" }, text(m.message || ""));
    if (m.positionChange) {
      const pc = m.positionChange;
      body.append(
        el(
          "div",
          { class: "callout" },
          el("div", { class: "callout-title" }, "Changed position"),
          el("div", { class: "from-to" }, el("span", { class: "from" }, text(pc.from)), el("span", null, "now: " + text(pc.to))),
          pc.evidence ? el("div", { class: "evidence" }, "Evidence: " + text(pc.evidence)) : null,
        ),
      );
    }
    if (m.rationale) body.append(el("details", { class: "fold" }, el("summary", null, "Rationale"), el("div", { class: "fold-body" }, text(m.rationale))));
    if (m.reasoningText) body.append(el("details", { class: "fold reasoning" }, el("summary", null, "Reasoning (provider-returned)"), el("div", { class: "fold-body" }, text(m.reasoningText))));
    return el(
      "div",
      { class: "msg" + (isSys ? " system" : ""), style: `--agent-c:${color}` },
      el("span", { class: "avatar", style: `--agent-c:${color}` }, isSys ? "•" : initials(label)),
      el("div", null, head, body),
    );
  }

  function sideCounts() {
    const s = ui.state;
    return {
      questions: s.questionOrder.filter((id) => !s.questions[id].answer).length,
      verify: s.verify.length,
      redteam: s.redteam.length,
      specialist: s.specialist.length,
      diffs: s.diffs.length,
      best: s.best.length,
      resources: s.resourceChecks.length + (s.resourceHost ? 1 : 0),
      costs: s.cost ? Object.keys(s.cost.byMember || {}).length : 0,
    };
  }

  function renderSideTabs() {
    const root = $("#side-tabs");
    root.replaceChildren();
    const counts = sideCounts();
    for (const [id, name] of SIDE_TABS) {
      const n = counts[id];
      root.append(
        el(
          "button",
          { class: "tab" + (ui.activeSide === id ? " is-active" : ""), role: "tab", onclick: () => { ui.activeSide = id; renderSideTabs(); renderSide(); } },
          name,
          n ? el("span", { class: "count" + (id === "questions" ? " attention" : "") }, n) : null,
        ),
      );
    }
  }

  const SIDE_RENDER = {
    questions: renderQuestions,
    verify: renderVerify,
    redteam: renderRedTeam,
    specialist: renderSpecialist,
    diffs: renderDiffs,
    best: renderBest,
    resources: renderResources,
    costs: renderCosts,
  };
  function renderSide() {
    const root = $("#side");
    root.replaceChildren();
    const out = SIDE_RENDER[ui.activeSide]();
    if (!out || (Array.isArray(out) && !out.length)) root.append(el("div", { class: "empty" }, EMPTY[ui.activeSide]));
    else root.append(...(Array.isArray(out) ? out : [out]));
  }
  const EMPTY = {
    questions: "The team has no questions for you.",
    verify: "No verification results yet.",
    redteam: "No red-team critiques yet.",
    specialist: "No specialist actions yet.",
    diffs: "No sandbox diffs yet.",
    best: "No candidate versions have been tested yet.",
    resources: "No resource information yet.",
    costs: "No cost information yet.",
  };

  const who = (memberId) => el("span", { class: "who", style: `--agent-c:${agentColor(memberId)}` }, labelOf(ui.state, memberId));
  const taskChip = (taskId) => (taskId ? el("span", { class: "chip" }, taskId) : null);

  function renderVerify() {
    return ui.state.verify
      .slice()
      .reverse()
      .map((r) =>
        el(
          "div",
          { class: "card verdict-" + (r.verdict || "") },
          el("div", { class: "card-head" }, who(r.memberId), el("span", { class: "chip " + r.verdict }, r.verdict), taskChip(r.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(r.ts))),
          r.findings?.length
            ? el(
                "ul",
                { class: "findings" },
                r.findings.map((f) => el("li", null, el("span", { class: "chip " + f.severity }, f.severity), el("div", null, text(f.text), f.evidence ? el("div", { class: "finding-ev" }, text(f.evidence)) : null))),
              )
            : el("div", { class: "muted" }, "No findings."),
          r.rationale ? el("details", { class: "fold" }, el("summary", null, "Rationale"), el("div", { class: "fold-body" }, text(r.rationale))) : null,
          r.reasoningText ? el("details", { class: "fold reasoning" }, el("summary", null, "Reasoning (provider-returned)"), el("div", { class: "fold-body" }, text(r.reasoningText))) : null,
          el("div", { class: "faint" }, fmtUsd(r.costUsd || 0)),
        ),
      );
  }

  const SEV_ORDER = { critical: 0, major: 1, minor: 2 };
  function renderRedTeam() {
    return ui.state.redteam
      .slice()
      .reverse()
      .map((c) => {
        const issues = (c.issues || []).slice().sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
        const top = issues[0]?.severity || "info";
        return el(
          "div",
          { class: "card sev-" + top },
          el("div", { class: "card-head" }, who(c.attackerId), el("span", { class: "arrow" }, "attacks"), who(c.targetId), taskChip(c.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(c.ts))),
          issues.length
            ? el(
                "ul",
                { class: "findings" },
                issues.map((i) => el("li", null, el("span", { class: "chip " + i.severity }, i.severity), el("div", null, el("span", { class: "muted" }, i.category + ": "), text(i.text), i.location ? el("div", { class: "finding-ev mono" }, text(i.location)) : null))),
              )
            : el("div", { class: "muted" }, "No issues found."),
          c.rationale ? el("details", { class: "fold" }, el("summary", null, "Rationale"), el("div", { class: "fold-body" }, text(c.rationale))) : null,
        );
      });
  }

  function renderSpecialist() {
    const runId = ui.state.runId;
    return ui.state.specialist
      .slice()
      .reverse()
      .map((a) =>
        el(
          "div",
          { class: "card" },
          el("div", { class: "card-head" }, who(a.memberId), el("span", null, text(a.action)), taskChip(a.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(a.ts))),
          a.detail ? el("div", { class: "muted", style: "white-space:pre-wrap" }, text(a.detail)) : null,
          a.screenshotPath && runId ? el("a", { href: fileUrl(runId, a.screenshotPath), target: "_blank" }, el("img", { class: "shot", src: fileUrl(runId, a.screenshotPath), alt: "Screenshot: " + a.action, loading: "lazy" })) : null,
        ),
      );
  }
  const fileUrl = (runId, p) => withToken(`/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(p)}`);

  function renderDiff(diffText) {
    const box = el("div", { class: "diff" });
    for (const line of String(diffText || "").split("\n")) {
      let cls = "ln";
      if (line.startsWith("+++") || line.startsWith("---")) cls += " meta";
      else if (line.startsWith("diff ") || line.startsWith("Index:")) cls += " file";
      else if (line.startsWith("@@")) cls += " hunk";
      else if (line.startsWith("+")) cls += " add";
      else if (line.startsWith("-")) cls += " del";
      else if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) cls += " meta";
      box.append(el("span", { class: cls }, text(line)));
    }
    return box;
  }
  function renderDiffs() {
    return ui.state.diffs
      .slice()
      .reverse()
      .map((d) =>
        el(
          "div",
          { class: "card" },
          el("div", { class: "card-head" }, who(d.memberId), el("span", { class: "muted" }, `vs best v${d.baseVersion ?? "?"}`), taskChip(d.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(d.ts))),
          el("div", { class: "muted" }, (d.files || []).length + " file(s): " + (d.files || []).map(text).join(", ")),
          el("details", { class: "fold", open: (d.diff || "").length < 6000 }, el("summary", null, "Diff"), renderDiff(d.diff)),
        ),
      );
  }

  function testList(tr) {
    if (!tr) return null;
    const total = tr.passed + tr.failed;
    const items = el("div", null,
      el("div", null, el("span", { class: tr.failed ? "chip fail" : "chip pass" }, `${tr.passed}/${total} passed`), " ", el("span", { class: "mono faint" }, text(tr.command || ""))),
      el("div", { class: "bar" }, el("span", { style: `width:${total ? (100 * tr.passed) / total : 0}%` })),
    );
    if (tr.results?.length) {
      items.append(
        el("details", { class: "fold" }, el("summary", null, `${tr.results.length} tests`),
          el("ul", { class: "tests" }, tr.results.map((r) => el("li", null, el("span", { class: "dot" + (r.passed ? " passed" : "") }), el("span", null, text(r.name)), r.durationMs != null ? el("span", { class: "faint" }, `${r.durationMs} ms`) : null)))),
      );
    }
    if (tr.rawOutput) items.append(el("details", { class: "fold" }, el("summary", null, "Raw output"), el("div", { class: "fold-body mono" }, text(tr.rawOutput.slice(0, 20000)))));
    return items;
  }
  function renderBest() {
    return ui.state.best
      .slice()
      .reverse()
      .map((b) => {
        const attributionView = (list) => {
          const byMember = new Map();
          for (const a of list) byMember.set(a.fromMemberId, [...(byMember.get(a.fromMemberId) || []), a.path]);
          return el("div", { class: "muted", title: "Which agent wrote each file of this version (never shown to the models)" },
            "Files by author: ",
            ...[...byMember.entries()].map(([id, files], i) => el("span", null, i ? ", " : "", who(id), ` ${files.length} file${files.length === 1 ? "" : "s"}`)));
        };
        if (b.kind === "crowned") {
          const v = b.best || {};
          return el("div", { class: "card verdict-pass" },
            el("div", { class: "card-head" }, el("span", { class: "crown" }, "Crowned"), el("strong", null, `v${v.version}`), who(v.fromMemberId), taskChip(v.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(b.ts))),
            v.reason ? el("div", { class: "muted" }, text(v.reason)) : null,
            Array.isArray(v.attribution) && v.attribution.length ? attributionView(v.attribution) : null,
            testList(v.testRun));
        }
        if (b.kind === "rejected") {
          return el("div", { class: "card verdict-fail" },
            el("div", { class: "card-head" }, el("span", { class: "muted" }, "Rejected"), who(b.memberId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(b.ts))),
            b.reason ? el("div", null, text(b.reason)) : null,
            testList(b.testRun));
        }
        if (b.kind === "stalled") {
          return el("div", { class: "card verdict-needs-work" },
            el("div", { class: "card-head" }, el("span", { class: "muted" }, "Stalled"), taskChip(b.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(b.ts))),
            el("div", null, `No improvement after ${b.attempts} attempts.`));
        }
        return el("div", { class: "card" },
          el("div", { class: "card-head" }, el("span", { class: "muted" }, b.candidate ? "Candidate tested" : "Tests run"), who(b.memberId), taskChip(b.taskId), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(b.ts))),
          testList(b.testRun));
      });
  }

  function renderResources() {
    const s = ui.state;
    const out = [];
    if (s.resourceHost) {
      const h = s.resourceHost;
      out.push(el("div", { class: "card" }, el("div", { class: "card-head" }, el("strong", null, "Host")),
        el("dl", { class: "kv" },
          el("dt", null, "Platform"), el("dd", null, h.platform || "?"),
          el("dt", null, "RAM"), el("dd", null, `${fmtMb(h.freeRamMb)} free of ${fmtMb(h.totalRamMb)}${h.unifiedMemory ? " (unified)" : ""}`),
          el("dt", null, "CPU cores"), el("dd", null, h.cpuCores ?? "?"),
          el("dt", null, "Free disk"), el("dd", null, fmtMb(h.freeDiskMb)),
          ...(h.gpu || []).flatMap((g) => [el("dt", null, "GPU"), el("dd", null, `${g.name}${g.vramMb ? ` · ${fmtMb(g.vramMb)}` : ""}`)]))));
    }
    for (const c of s.resourceChecks.slice().reverse()) {
      const cls = c.decision === "allow" ? "verdict-pass" : c.decision === "block" ? "verdict-fail" : "verdict-needs-work";
      out.push(el("div", { class: "card " + cls },
        el("div", { class: "card-head" }, el("span", { class: "chip " + (c.decision === "allow" ? "pass" : c.decision === "block" ? "fail" : "warn") }, c.decision), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(c.ts))),
        el("div", { class: "cmd" }, text(c.command)),
        c.estimate ? el("div", { class: "muted" }, `Estimated ${fmtMb(c.estimate.ramMb)} RAM, ${fmtMb(c.estimate.diskMb)} disk, ~${c.estimate.durationSec}s. ${text(c.estimate.reason || "")}`) : null,
        c.reason ? el("div", null, text(c.reason)) : null));
    }
    return out;
  }

  function renderCosts() {
    const s = ui.state;
    if (!s.cost) return [];
    const c = s.cost;
    const table = (title, obj, keyLabel) => {
      const rows = Object.entries(obj || {});
      if (!rows.length) return null;
      const t = el("table", { class: "cost-table" },
        el("thead", null, el("tr", null, el("th", null, title), el("th", { class: "num" }, "Tokens"), el("th", { class: "num" }, "Cost"))),
        el("tbody", null, rows.map(([k, v]) => {
          const tokens = typeof v === "number" ? null : (v.tokens?.input || v.inputTokens || 0) + (v.tokens?.output || v.outputTokens || 0) + (v.tokens?.reasoning || v.reasoningTokens || 0);
          const usd = typeof v === "number" ? v : v.totalUsd ?? v.costUsd ?? v.usd ?? 0;
          return el("tr", null, el("td", null, keyLabel(k)), el("td", { class: "num" }, tokens == null ? "" : fmtNum(tokens)), el("td", { class: "num" }, fmtUsd(usd)));
        })));
      return el("div", { class: "card" }, t);
    };
    const tk = c.totalTokens || {};
    return [
      el("div", { class: "card" },
        el("dl", { class: "kv" },
          el("dt", null, "Total"), el("dd", null, el("strong", null, fmtUsd(c.totalUsd))),
          el("dt", null, "Input tokens"), el("dd", null, fmtNum(tk.input)),
          el("dt", null, "Output tokens"), el("dd", null, fmtNum(tk.output)),
          el("dt", null, "Reasoning tokens"), el("dd", null, fmtNum(tk.reasoning)))),
      table("By member", c.byMember, (k) => `${labelOf(s, k)} (${shortModel(modelOf(s, k)) || k})`),
      table("By stage", c.byStage, (k) => k),
    ].filter(Boolean);
  }

  // ---------------------------------------------------------------------
  // 5. Questions
  // ---------------------------------------------------------------------
  function renderQuestions() {
    const s = ui.state;
    return s.questionOrder
      .slice()
      .reverse()
      .map((id) => {
        const q = s.questions[id];
        const question = q.question;
        const card = el("div", { class: "card question" + (q.answer ? " answered" : "") },
          el("div", { class: "card-head" }, el("span", { class: "chip " + (q.answer ? "" : "warn") }, question.kind), el("span", { class: "spacer" }), el("span", { class: "when" }, fmtTime(q.ts))),
          el("div", { class: "q-text" }, text(question.text)));
        if (q.answer) {
          const a = q.answer;
          card.append(el("div", { class: "q-answer" }, "Answered: " + (a.approved === true ? "approved. " : a.approved === false ? "denied. " : "") + text(a.text || "")));
        } else if (!ui.live) {
          card.append(el("div", { class: "muted" }, "This run is not live; the question cannot be answered here."));
        } else {
          card.append(questionForm(question));
        }
        return card;
      });
  }

  function questionForm(q) {
    const runId = ui.state.runId;
    const submit = async (answer, btn) => {
      try {
        if (btn) btn.disabled = true;
        await api(`/api/runs/${encodeURIComponent(runId)}/answer`, { method: "POST", body: { questionId: q.id, ...answer } });
        toast("Answer sent");
      } catch (err) {
        toast("Could not send answer: " + err.message, true);
        if (btn) btn.disabled = false;
      }
    };
    const form = el("div", { class: "q-form" });
    switch (q.kind) {
      case "clarify": {
        if (q.options?.length) {
          form.append(el("div", { class: "row" }, q.options.map((o) => el("button", { class: "btn", onclick: (ev) => submit({ text: o }, ev.currentTarget) }, text(o)))));
        }
        const ta = el("textarea", { placeholder: q.options?.length ? "Or answer in your own words" : "Your answer" });
        const btn = el("button", { class: "btn btn-primary", onclick: (ev) => ta.value.trim() && submit({ text: ta.value.trim() }, ev.currentTarget) }, "Send answer");
        form.append(ta, el("div", { class: "row" }, btn));
        break;
      }
      case "select-model": {
        const models = q.models || [];
        const modelSel = el("select", null, models.map((m) => el("option", { value: m.modelId }, `${m.displayName || m.modelId}`)));
        const reasonSel = el("select");
        const caps = el("div", { class: "caps" });
        const refresh = () => {
          const m = models.find((x) => x.modelId === modelSel.value);
          fillReasoningOptions(reasonSel, m?.capabilities?.reasoning, null);
          caps.replaceChildren(...capChips(m?.capabilities));
        };
        modelSel.addEventListener("change", refresh);
        refresh();
        form.append(
          el("label", null, "Model", modelSel), caps,
          el("label", null, "Reasoning level", reasonSel),
          el("div", { class: "row" }, el("button", { class: "btn btn-primary", onclick: (ev) => submit({ text: modelSel.value, data: { endpointId: q.endpointId, modelId: modelSel.value, reasoning: reasonSel.value } }, ev.currentTarget) }, "Use this model")),
        );
        break;
      }
      case "confirm-destructive":
      case "resource-block": {
        form.append(el("div", { class: "cmd" }, text(q.command)));
        if (q.cwd) form.append(el("div", { class: "faint mono" }, "in " + text(q.cwd)));
        if (q.estimate) form.append(el("div", { class: "muted" }, `Estimated ${fmtMb(q.estimate.ramMb)} RAM, ${fmtMb(q.estimate.diskMb)} disk, ~${q.estimate.durationSec}s. ${text(q.estimate.reason || "")}`));
        form.append(el("div", { class: "row" },
          el("button", { class: "btn btn-pass", onclick: (ev) => submit({ text: "approve", approved: true }, ev.currentTarget) }, q.kind === "resource-block" ? "Allow" : "Approve"),
          el("button", { class: "btn btn-danger", onclick: (ev) => submit({ text: "deny", approved: false }, ev.currentTarget) }, "Deny")));
        break;
      }
      case "cost-cap": {
        form.append(el("div", { class: "muted" }, `Spent ${fmtUsd(q.spentUsd)} of the ${fmtUsd(q.capUsd)} cap.`));
        form.append(el("div", { class: "row" },
          el("button", { class: "btn btn-pass", onclick: (ev) => submit({ text: "continue", approved: true }, ev.currentTarget) }, "Keep going"),
          el("button", { class: "btn btn-danger", onclick: (ev) => submit({ text: "stop", approved: false }, ev.currentTarget) }, "Stop the run")));
        break;
      }
      default: {
        const ta = el("textarea", { placeholder: "Your answer" });
        form.append(ta, el("div", { class: "row" }, el("button", { class: "btn btn-primary", onclick: (ev) => submit({ text: ta.value.trim() }, ev.currentTarget) }, "Send answer")));
      }
    }
    return form;
  }

  // Reasoning options depend on how the model exposes reasoning control.
  function reasoningChoices(rc) {
    if (!rc || rc.kind === "none") return { options: [["none", "Not supported"]], disabled: true };
    if (rc.kind === "always-on") return { options: [["high", "Always on"]], disabled: true };
    if (rc.kind === "toggle") return { options: [["none", "none"], ["high", "high"]], disabled: false };
    if (rc.kind === "budget") return { options: ["low", "medium", "high", "max"].map((l) => [l, l]), disabled: false };
    if (rc.kind === "levels") return { options: (rc.levels || []).map((l) => [l, l]), disabled: false };
    return { options: [["none", "Not supported"]], disabled: true };
  }
  function fillReasoningOptions(sel, rc, current) {
    const { options, disabled } = reasoningChoices(rc);
    sel.replaceChildren(...options.map(([v, label]) => el("option", { value: v }, label)));
    sel.disabled = disabled;
    if (current && options.some(([v]) => v === current)) sel.value = current;
    else if (options.some(([v]) => v === "medium")) sel.value = "medium";
    else if (options.some(([v]) => v === "high")) sel.value = "high";
  }
  function capChips(caps) {
    if (!caps) return [];
    const out = [];
    out.push(el("span", { class: "chip " + (caps.vision ? "pass" : "") }, caps.vision ? "vision" : "no vision"));
    out.push(el("span", { class: "chip " + (caps.tools ? "pass" : "") }, caps.tools ? "tools" : "no tools"));
    if (caps.contextWindow) out.push(el("span", { class: "chip" }, fmtCtx(caps.contextWindow)));
    const rc = caps.reasoning || {};
    out.push(el("span", { class: "chip", title: rc.native ? "Native parameter: " + rc.native : "" }, "reasoning: " + (rc.kind || "none") + (rc.kind === "levels" ? ` (${(rc.levels || []).join("/")})` : "")));
    if (caps.returnsReasoningText) out.push(el("span", { class: "chip" }, "returns reasoning"));
    return out;
  }

  // ---------------------------------------------------------------------
  // 4. Live streaming and replay
  // ---------------------------------------------------------------------
  const replay = { events: [], index: 0, playing: false, timer: null, enabled: false };

  function resetView() {
    ui.state = newState();
    agentColorIndex.clear();
    ui.chatRendered = Object.fromEntries(CHANNELS.map(([c]) => [c, 0]));
    ui.chatRenderedRound = Object.fromEntries(CHANNELS.map(([c]) => [c, null]));
    ui.chatRendered.channel = null;
    $("#chat").replaceChildren();
  }

  function applyEvents(events) {
    for (const e of events) reduce(ui.state, e);
    renderAll();
  }

  function applyLive(e) {
    reduce(ui.state, e);
    // Cheap incremental updates for the frequent event types; full rerender otherwise.
    switch (e.type) {
      case "chat.message":
        renderChannelTabs();
        if (e.data?.channel === ui.activeChannel) renderChat();
        break;
      case "cost.update":
      case "llm.call":
        renderHeader();
        if (ui.activeSide === "costs") renderSide();
        break;
      default:
        renderAll();
    }
    if (e.type === "question.asked") {
      ui.activeSide = "questions";
      renderSideTabs();
      renderSide();
    }
  }

  let es = null;
  function closeStream() {
    if (es) es.close();
    es = null;
    ui.live = false;
  }

  async function selectRun(runId) {
    closeStream();
    stopReplay();
    resetView();
    ui.currentRun = runId;
    const run = ui.runs.find((r) => r.id === runId);
    replay.enabled = false;
    $("#replay-bar").hidden = true;
    if (!runId) {
      renderAll();
      return;
    }
    if (run?.live) {
      ui.live = true;
      const events = [];
      let ready = false;
      es = new EventSource(withToken(`/api/runs/${encodeURIComponent(runId)}/stream`));
      es.addEventListener("run", (ev) => {
        const e = JSON.parse(ev.data);
        if (!ready) events.push(e);
        else applyLive(e);
      });
      es.addEventListener("ready", () => {
        ready = true;
        applyEvents(events);
        events.length = 0;
      });
      es.onerror = () => {
        // A finished run closes its stream; fall back to the stored events on next refresh.
        if (ui.state.finished) closeStream();
        renderHeader();
      };
      renderAll();
    } else {
      try {
        const events = await api(`/api/runs/${encodeURIComponent(runId)}/events`);
        replay.events = events;
        replay.enabled = true;
        $("#replay-bar").hidden = false;
        $("#replay-scrub").max = events.length;
        seekReplay(events.length);
      } catch (err) {
        toast("Could not load run: " + err.message, true);
        renderAll();
      }
    }
  }

  function seekReplay(index) {
    index = Math.max(0, Math.min(replay.events.length, index));
    if (index < replay.index) {
      resetView();
      replay.index = 0;
    }
    for (; replay.index < index; replay.index++) reduce(ui.state, replay.events[replay.index]);
    renderAll();
    $("#replay-scrub").value = index;
    $("#replay-pos").textContent = `${index} / ${replay.events.length}`;
  }
  function stepReplay() {
    if (replay.index >= replay.events.length) return stopReplay();
    applyLive(replay.events[replay.index++]);
    $("#replay-scrub").value = replay.index;
    $("#replay-pos").textContent = `${replay.index} / ${replay.events.length}`;
    scheduleStep();
  }
  function scheduleStep() {
    const speed = Number($("#replay-speed").value) || 1;
    const cur = replay.events[replay.index - 1];
    const next = replay.events[replay.index];
    let gap = cur && next ? new Date(next.ts) - new Date(cur.ts) : 400;
    if (!isFinite(gap) || gap < 0) gap = 400;
    gap = Math.min(Math.max(gap, 120), 4000) / speed;
    replay.timer = setTimeout(stepReplay, gap);
  }
  function startReplay() {
    if (replay.index >= replay.events.length) seekReplay(0);
    replay.playing = true;
    $("#replay-play").textContent = "Pause";
    scheduleStep();
  }
  function stopReplay() {
    clearTimeout(replay.timer);
    replay.timer = null;
    replay.playing = false;
    const b = $("#replay-play");
    if (b) b.textContent = "Play";
  }

  async function loadRuns(keepSelection = true) {
    try {
      ui.runs = await api("/api/runs");
    } catch (err) {
      toast("Could not list runs: " + err.message, true);
      ui.runs = [];
    }
    const sel = $("#run-select");
    const prev = keepSelection ? ui.currentRun : null;
    sel.replaceChildren();
    if (!ui.runs.length) sel.append(el("option", { value: "" }, "No runs yet"));
    for (const r of ui.runs) {
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "";
      const label = `${r.live ? "● live  " : r.status === "interrupted" ? "⚠ interrupted  " : r.status === "failed" ? "✖ failed  " : ""}${when}  ${(r.request || r.id).slice(0, 60)}`;
      sel.append(el("option", { value: r.id, title: r.id }, label));
    }
    const target = prev && ui.runs.some((r) => r.id === prev) ? prev : ui.runs[0]?.id || "";
    sel.value = target;
    if (target !== ui.currentRun) await selectRun(target);
  }

  // ---------------------------------------------------------------------
  // 6. Settings
  // ---------------------------------------------------------------------
  const settings = { data: null, draft: null };

  function draftFromProfile(providers, profile) {
    // draft: { [endpointId]: { mode, entries: [{modelId, reasoning, isLead}] } }
    const draft = {};
    for (const p of providers) draft[p.endpointId] = { mode: "auto", entries: [], isLeadProvider: false };
    const isAnthropic = (p) => p.providerId === "anthropic";
    if (profile) {
      const all = [{ ...profile.lead, isLead: true }, ...profile.members.map((m) => ({ ...m, isLead: false }))];
      for (const sel of all) {
        const d = draft[sel.endpointId];
        if (!d) continue;
        d.mode = sel.mode;
        if (sel.isLead) d.isLeadProvider = true;
        if (sel.mode === "manual") d.entries.push({ modelId: sel.modelId || "", reasoning: sel.reasoning || "medium", isLead: sel.isLead });
      }
    } else {
      const anth = providers.find(isAnthropic);
      if (anth) draft[anth.endpointId].isLeadProvider = true;
    }
    return draft;
  }

  function profileFromDraft(providers) {
    let lead = null;
    const members = [];
    for (const p of providers) {
      const d = settings.draft[p.endpointId];
      if (!d) continue;
      if (d.mode === "auto") {
        const sel = { endpointId: p.endpointId, mode: "auto" };
        if (d.isLeadProvider) lead = sel;
        else members.push(sel);
      } else {
        for (const e of d.entries) {
          if (!e.modelId) continue;
          const sel = { endpointId: p.endpointId, mode: "manual", modelId: e.modelId, reasoning: e.reasoning };
          if (e.isLead) lead = sel;
          else members.push(sel);
        }
      }
    }
    if (!lead) throw new Error("Choose a lead: it must be an Anthropic model.");
    const leadProvider = providers.find((p) => p.endpointId === lead.endpointId);
    if (!leadProvider || leadProvider.providerId !== "anthropic") throw new Error("The lead must be an Anthropic model.");
    return { version: 1, lead, members, updatedAt: new Date().toISOString() };
  }

  function setLead(endpointId, entryIndex) {
    for (const [id, d] of Object.entries(settings.draft)) {
      d.isLeadProvider = id === endpointId && entryIndex == null;
      d.entries.forEach((e, i) => (e.isLead = id === endpointId && i === entryIndex));
    }
  }

  function renderSettings() {
    const root = $("#providers");
    root.replaceChildren();
    if (!settings.data) {
      root.append(el("div", { class: "empty" }, "Loading providers"));
      return;
    }
    const providers = settings.data.providers || [];
    if (!providers.length) {
      root.append(el("div", { class: "empty" }, "No provider keys were detected. Add keys to your environment or .env and refresh."));
      return;
    }
    for (const p of providers) {
      const d = settings.draft[p.endpointId];
      const canLead = p.providerId === "anthropic";
      const head = el("div", { class: "provider-head" },
        el("h3", null, p.displayName || p.endpointId),
        el("span", { class: "url" }, p.baseUrl),
        el("span", { class: "keysrc" }, `key from ${p.keySource || "environment"} · ${p.models.length} models`),
        el("div", { class: "mode" },
          ["auto", "manual"].map((m) => el("label", null, el("input", { type: "radio", name: "mode-" + p.endpointId, value: m, checked: d.mode === m, onchange: () => { d.mode = m; if (m === "manual" && !d.entries.length) d.entries.push({ modelId: p.models[0]?.modelId || "", reasoning: "medium", isLead: d.isLeadProvider }); if (m === "manual" && d.isLeadProvider) { d.isLeadProvider = false; if (d.entries[0]) d.entries[0].isLead = true; } if (m === "auto" && d.entries.some((e) => e.isLead)) { d.isLeadProvider = true; } renderSettings(); } }), m === "auto" ? "Auto (engine picks the model)" : "Manual"))));
      const body = el("div", { class: "provider-body" });
      if (d.mode === "auto") {
        body.append(el("div", { class: "auto-note" }, "The engine picks the best available model and reasoning level for this provider at run time."));
        if (canLead) body.append(el("label", { class: "lead-toggle" + (d.isLeadProvider ? "" : " is-off"), style: "margin-top:8px" }, el("input", { type: "radio", name: "lead", checked: d.isLeadProvider, onchange: () => { setLead(p.endpointId, null); renderSettings(); } }), "Lead"));
      } else {
        d.entries.forEach((entry, i) => {
          const modelSel = el("select", null, p.models.map((m) => el("option", { value: m.modelId, selected: m.modelId === entry.modelId }, m.displayName && m.displayName !== m.modelId ? `${m.displayName} (${m.modelId})` : m.modelId)));
          if (!p.models.some((m) => m.modelId === entry.modelId) && entry.modelId) modelSel.prepend(el("option", { value: entry.modelId, selected: true }, entry.modelId + " (not in live list)"));
          const reasonSel = el("select");
          const caps = el("div", { class: "caps" });
          const refresh = () => {
            const m = p.models.find((x) => x.modelId === modelSel.value);
            fillReasoningOptions(reasonSel, m?.capabilities?.reasoning, entry.reasoning);
            entry.reasoning = reasonSel.value;
            caps.replaceChildren(...capChips(m?.capabilities));
          };
          modelSel.addEventListener("change", () => { entry.modelId = modelSel.value; refresh(); });
          reasonSel.addEventListener("change", () => (entry.reasoning = reasonSel.value));
          refresh();
          body.append(el("div", { class: "entry" },
            el("label", null, "Model", modelSel, caps),
            el("label", null, "Reasoning level", reasonSel),
            el("label", { class: "lead-toggle" + (entry.isLead ? "" : " is-off"), title: canLead ? "Make this model the lead" : "Only an Anthropic model can lead" },
              el("input", { type: "radio", name: "lead", checked: entry.isLead, disabled: !canLead, onchange: () => { setLead(p.endpointId, i); renderSettings(); } }), "Lead"),
            el("button", { class: "btn btn-small", title: "Remove this member", onclick: () => { d.entries.splice(i, 1); renderSettings(); } }, "Remove")));
        });
        body.append(el("div", { class: "add-row" }, el("button", { class: "btn", onclick: () => { d.entries.push({ modelId: p.models[0]?.modelId || "", reasoning: "medium", isLead: false }); renderSettings(); } }, "Add another model from this provider")));
      }
      root.append(el("section", { class: "provider" }, head, body));
    }
  }

  async function loadSettings() {
    const status = $("#settings-status");
    try {
      settings.data = await api("/api/settings");
      settings.draft = draftFromProfile(settings.data.providers || [], settings.data.profile);
      status.textContent = settings.data.profile ? `Profile saved ${new Date(settings.data.profile.updatedAt).toLocaleString()}` : "No profile saved yet; auto mode will be used.";
      status.className = "status-text";
    } catch (err) {
      status.textContent = "Could not load settings: " + err.message;
      status.className = "status-text err";
    }
    renderSettings();
  }

  async function saveSettings() {
    const status = $("#settings-status");
    try {
      const profile = profileFromDraft(settings.data.providers || []);
      await api("/api/settings", { method: "PUT", body: { profile } });
      status.textContent = "Profile saved";
      status.className = "status-text ok";
      toast("Profile saved");
    } catch (err) {
      status.textContent = err.message;
      status.className = "status-text err";
    }
  }

  async function refreshProviders() {
    const status = $("#settings-status");
    const btn = $("#settings-refresh");
    btn.disabled = true;
    status.textContent = "Detecting keys and models";
    status.className = "status-text";
    try {
      const providers = await api("/api/settings/refresh", { method: "POST" });
      settings.data.providers = providers;
      // Keep the draft but drop endpoints that no longer exist and add new ones.
      const fresh = draftFromProfile(providers, null);
      for (const id of Object.keys(fresh)) if (settings.draft[id]) fresh[id] = settings.draft[id];
      settings.draft = fresh;
      status.textContent = `Found ${providers.length} provider(s)`;
      status.className = "status-text ok";
    } catch (err) {
      status.textContent = "Refresh failed: " + err.message;
      status.className = "status-text err";
    }
    btn.disabled = false;
    renderSettings();
  }

  // ---------------------------------------------------------------------
  // 7. Routing, theme, boot
  // ---------------------------------------------------------------------
  function route() {
    const hash = location.hash || "#/";
    const isSettings = hash.startsWith("#/settings");
    $("#page-run").hidden = isSettings;
    $("#page-settings").hidden = !isSettings;
    $("#replay-bar").hidden = isSettings || !replay.enabled;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("is-active", (a.dataset.route === "settings") === isSettings));
    if (isSettings) loadSettings();
    const m = /^#\/runs?\/([^/]+)/.exec(hash);
    if (m && decodeURIComponent(m[1]) !== ui.currentRun && ui.runs.some((r) => r.id === decodeURIComponent(m[1]))) {
      $("#run-select").value = decodeURIComponent(m[1]);
      selectRun(decodeURIComponent(m[1]));
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("mmt-theme", theme); } catch { /* ignore */ }
  }

  function boot() {
    let theme = "dark";
    try { theme = localStorage.getItem("mmt-theme") || "dark"; } catch { /* ignore */ }
    applyTheme(theme);
    $("#theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"));

    $("#run-select").addEventListener("change", (ev) => {
      const id = ev.target.value;
      location.hash = id ? `#/runs/${encodeURIComponent(id)}` : "#/";
      selectRun(id);
    });
    for (const action of ["pause", "resume", "stop"]) {
      $(`#btn-${action}`).addEventListener("click", async () => {
        if (!ui.currentRun) return;
        if (action === "stop" && !confirm("Stop this run? The team will finish the current call and stop.")) return;
        try {
          await api(`/api/runs/${encodeURIComponent(ui.currentRun)}/${action}`, { method: "POST" });
          toast(action === "stop" ? "Stop requested" : action === "pause" ? "Pause requested" : "Resume requested");
        } catch (err) {
          toast(`Could not ${action}: ${err.message}`, true);
        }
      });
    }
    $("#replay-play").addEventListener("click", () => (replay.playing ? stopReplay() : startReplay()));
    $("#replay-scrub").addEventListener("input", (ev) => { stopReplay(); seekReplay(Number(ev.target.value)); });
    $("#replay-end").addEventListener("click", () => { stopReplay(); seekReplay(replay.events.length); });
    $("#chat").addEventListener("scroll", (ev) => {
      const c = ev.target;
      ui.followChat = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
    });
    $("#settings-save").addEventListener("click", saveSettings);
    $("#settings-refresh").addEventListener("click", refreshProviders);
    window.addEventListener("hashchange", route);

    renderAll();
    loadRuns().then(route);
    // Pick up runs that start after the page was opened.
    setInterval(() => { if (!location.hash.startsWith("#/settings")) loadRuns(true); }, 10_000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
