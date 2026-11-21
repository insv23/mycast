import { Service, type Action, type AppInfo, type Row, type View } from "./mygo";

// ---- state ----------------------------------------------------------------

let view: View | null = null;
let sel = "";                 // chosen layer
let selKey: string | null = null;
let draft = { kind: "app" as "app" | "mark" | "key" };
let appQuery = "";
let markValue = "";
let markBlocked = false;
let savedMark = { text: "", blocked: false };
let addOpen = false;
let addStep: "kind" | "mods" = "kind";
let pending = new Set<string>();
let keyMods = new Set<string>();
let keyTarget: string | null = null;
let composing = false;
let markDirty = false;

const icons = new Map<string, string>();
const names = new Map<string, string>();

// ---- keyboard -------------------------------------------------------------

type K = { id: string; label: string; w: number; gap?: boolean };

const row = (spec: [string, string, number][]): K[] =>
  spec.map(([id, label, w]) => ({ id, label, w }));

/** 修饰键不在键盘图上绑定，但占回原来那格，让其余键留在物理位置。 */
const gap = (w: number): K => ({ id: "", label: "", w, gap: true });

const ROWS: K[][] = [
  row([
    ["escape", "esc", 1],
    ...Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`, 1.125] as [string, string, number]),
  ]),
  row([
    ["grave", "`", 1], ["1", "1", 1], ["2", "2", 1], ["3", "3", 1], ["4", "4", 1], ["5", "5", 1],
    ["6", "6", 1], ["7", "7", 1], ["8", "8", 1], ["9", "9", 1], ["0", "0", 1], ["minus", "-", 1],
    ["equal", "=", 1], ["delete", "delete", 2],
  ]),
  row([
    ["tab", "tab", 1.5], ["q", "Q", 1], ["w", "W", 1], ["e", "E", 1], ["r", "R", 1], ["t", "T", 1],
    ["y", "Y", 1], ["u", "U", 1], ["i", "I", 1], ["o", "O", 1], ["p", "P", 1],
    ["leftbracket", "[", 1], ["rightbracket", "]", 1], ["backslash", "\\", 1.5],
  ]),
  [
    gap(1.75),
    ...row([
      ["a", "A", 1], ["s", "S", 1], ["d", "D", 1], ["f", "F", 1], ["g", "G", 1],
      ["h", "H", 1], ["j", "J", 1], ["k", "K", 1], ["l", "L", 1], ["semicolon", ";", 1],
      ["quote", "'", 1], ["return", "return", 2.25],
    ]),
  ],
  [
    gap(2.25),
    ...row([
      ["z", "Z", 1], ["x", "X", 1], ["c", "C", 1], ["v", "V", 1], ["b", "B", 1],
      ["n", "N", 1], ["m", "M", 1], ["comma", ",", 1], ["period", ".", 1], ["slash", "/", 1],
    ]),
    gap(1.75),
    ...row([["up", "↑", 1]]),
  ],
  row([
    ["space", "space", 6.25],
    ["left", "←", 1], ["down", "↓", 1], ["right", "→", 1],
  ]),
];

const GLYPH: Record<string, [string, string]> = {
  lcmd: ["cmd", "L"], rcmd: ["cmd", "R"], lalt: ["alt", "L"], ralt: ["alt", "R"],
  lctrl: ["ctrl", "L"], rctrl: ["ctrl", "R"], lshift: ["shift", "L"], rshift: ["shift", "R"],
  fn: ["", ""],
};

/** 修饰键在侧栏和选择弹窗里用同一份 SVG 字形。 */
function modCap(m: string): string {
  const [g, side] = GLYPH[m] ?? ["", ""];
  if (!g) return `<span class="cap2 txt">fn</span>`;
  return `<span class="cap2${side ? " side" : ""}"><svg><use href="#g-${g}"/></svg>${side ? `<i>${side}</i>` : ""}</span>`;
}

/** 一层在侧栏里就是它要按的那几个键，没有别的装饰。 */
function capsOf(r: Row): string {
  return r.mods.map(modCap).join("");
}

const MODS = ["lctrl", "lalt", "lshift", "lcmd", "rctrl", "ralt", "rshift", "rcmd"];

const KEY_SYM: Record<string, string> = {
  lctrl: "⌃", rctrl: "⌃", lalt: "⌥", ralt: "⌥",
  lshift: "⇧", rshift: "⇧", lcmd: "⌘", rcmd: "⌘",
};
const TARGET_KEYS = ROWS.map((r) => r.filter((k) => !k.gap));

const keyGlyph = (m: string) => KEY_SYM[m] ?? m;
const keySide = (m: string) => (m.startsWith("r") ? "R" : "L");
function shortKeyLabel(act: Action): string {
  return [...(act.mods ?? []).map((m) => keyGlyph(m) + keySide(m)), (act.key ?? "").toUpperCase()].join("");
}
function fullKeyLabel(act: Action): string {
  return [...(act.mods ?? []).map((m) => keyGlyph(m) + keySide(m)), (act.key ?? "").toUpperCase()].join(" ");
}
function resetKeyDraft(act?: Action) {
  keyMods = new Set(act?.type === "key" ? act.mods ?? [] : []);
  keyTarget = act?.type === "key" ? act.key ?? null : null;
}
function keyValue(): string | null {
  if (!keyTarget) return null;
  const mods = [...keyMods].sort().join("+");
  return mods ? `${mods}:${keyTarget}` : keyTarget;
}
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- data helpers ---------------------------------------------------------

function layer(): Row | undefined {
  return view?.rows.find((r) => r.id === sel);
}

function bindingFor(id: string): Action | null | undefined {
  const r = layer();
  if (!r) return undefined;
  return id === "@single" ? r.onRelease : id === "@double" ? r.onDoubleTap : r.keys?.[id];
}

/** The name an app is shown by, from the list Go read. */
function appName(bundleID: string): string {
  return names.get(bundleID) ?? bundleID;
}

function iconFor(bundleID: string): string {
  const hit = icons.get(bundleID);
  if (hit !== undefined) return hit;
  icons.set(bundleID, "");
  Service.icon(bundleID).then((url) => {
    icons.set(bundleID, url);
    if (url) render();
  });
  return "";
}

/** What a key shows under its letter. */
function keyFace(act: Action | null | undefined): { cls: string; html: string } {
  if (!act) return { cls: "", html: "" };
  if (act.type === "app") {
    const id = act.bundleID ?? "";
    const url = iconFor(id);
    return { cls: "on", html: url ? `<span class="ic"><img src="${url}" alt=""></span>` : "" };
  }
  if (act.type === "note") {
    return { cls: "on", html: `<span class="tx">${esc(act.text ?? "")}</span>` };
  }
  if (act.type === "key") {
    return { cls: "on", html: `<span class="tx">${esc(shortKeyLabel(act))}</span>` };
  }
  return {
    cls: "on blocked",
    html: `<svg class="ban"><use href="#g-ban"/></svg><span class="tx">${esc(act.text || "屏蔽")}</span>`,
  };
}

// ---- render ---------------------------------------------------------------

const rail = document.getElementById("rail")!;
const board = document.getElementById("board")!;
const insp = document.getElementById("insp")!;

function render() {
  renderRail();
  renderBoard();
  renderInsp();
}

function renderRail() {
  const rows = view?.rows ?? [];
  const groups: { title: string; id?: string; items: Row[] }[] = [{ title: "", items: [] }];
  for (const r of rows) {
    if (r.kind === "divider") groups.push({ title: r.label, id: r.id, items: [] });
    else groups[groups.length - 1]!.items.push(r);
  }

  let html = `<div class="rows" style="padding-top:8px">`;
  for (const g of groups) {
    if (g.title !== undefined && g !== groups[0]) {
      html += `<div class="sect" data-drag="${esc(g.id ?? "")}"><span class="ln"></span></div>`;
    }
    for (const r of g.items) {
      const n = Object.keys(r.keys ?? {}).length + (r.onRelease ? 1 : 0) + (r.onDoubleTap ? 1 : 0);
      html += `<div class="lrow${r.id === sel ? " on" : ""}" data-id="${esc(r.id)}" title="${esc(r.title)}">
        <span class="caps">${capsOf(r)}</span>
        ${n ? `<span class="n">${n}</span>` : ""}
      </div>`;
    }
  }
  html += `</div>`;

  html += `<div class="add" data-act="open-add" title="新建层"><svg><use href="#g-plus"/></svg></div>`;
  rail.innerHTML = html;
  renderSheet();
}

const sheetHost = document.createElement("div");
document.body.appendChild(sheetHost);

function renderSheet() {
  if (!addOpen) {
    sheetHost.innerHTML = "";
    return;
  }
  if (addStep === "kind") {
    sheetHost.innerHTML = `<div class="overlay">
      <div class="sheet">
        <h3>新建层</h3>
        <div class="hint">先决定这一层怎么被触发</div>
        <div class="opt" data-act="pick-hold">
          <svg><use href="#g-ctrl"/></svg>
          <span class="t"><b>按住一组键</b><span>按住它们时，键盘上每个键各有一个动作</span></span>
          <span class="chev">›</span>
        </div>
        <div class="opt" data-act="add-divider">
          <svg><use href="#g-dash"/></svg>
          <span class="t"><b>分节线</b><span>在列表里加一条分组线，可以拖动换位置</span></span>
        </div>
        <div class="foot"><button class="btn" data-act="cancel-add">取消</button></div>
      </div>
    </div>`;
    return;
  }

  const chip = (id: string) =>
    `<button data-mod="${id}" class="${pending.has(id) ? "on" : ""}">${modCap(id)}</button>`;
  sheetHost.innerHTML = `<div class="overlay">
    <div class="sheet">
      <h3>按住一组键</h3>
      <div class="hint">按住这组键时，这一层的键位生效</div>
      <div class="mrow"><span class="side">左</span><span class="mset">${MODS.slice(0, 4).map(chip).join("")}</span></div>
      <div class="mrow"><span class="side">右</span><span class="mset">${MODS.slice(4).map(chip).join("")}</span></div>
      <div class="foot">
        <button class="btn" data-act="cancel-add">取消</button>
        <button class="btn pri" data-act="create-layer" ${pending.size ? "" : "disabled"}>创建</button>
      </div>
    </div>
  </div>`;
}

function renderBoard() {
  const r = layer();
  if (!r) {
    board.innerHTML = `<div class="win-wrap"><span class="empty">还没有层</span></div>`;
    return;
  }

  const win = r.window || 350;
  const gestures = (r.onRelease ? 1 : 0) + (r.onDoubleTap ? 1 : 0);
  const subtitle = `按住生效 · ${Object.keys(r.keys ?? {}).length} 个键位${gestures ? ` · ${gestures} 个手势` : ""}`;

  const pct = ((win - 10) / 790) * 100;
  const defPct = ((350 - 10) / 790) * 100;
  let html = `<div class="head"><b>${esc(r.title)}</b><span>${subtitle}</span></div>`;

  html += `<div class="win-wrap"><div class="kb">`;
  ROWS.forEach((keys, i) => {
    const cls = i === 0 ? "krow0" : i === ROWS.length - 1 ? "krow end" : "krow";
    html += `<div class="${cls}">`;
    for (const k of keys) {
      if (k.gap) {
        html += `<div class="kgap" style="width:calc(var(--u) * ${k.w})"></div>`;
        continue;
      }
      const face = keyFace(r.keys?.[k.id]);
      const selCls = selKey === k.id ? " sel" : "";
      const w = i === 0 ? "" : ` style="width:calc(var(--u) * ${k.w})"`;
      html += `<div class="k ${face.cls}${selCls}" data-key="${k.id}"${w}>
        <span class="kn">${esc(k.label)}</span>${face.html}</div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;
  html += `<div class="gesture">${gestureCap(r, "single")}${gestureCap(r, "double")}</div>`;
  html += `<div class="slider-row">
    <span class="lab">双击窗口</span>
    <div class="slider">
      <div class="track"></div>
      <div class="fill" id="twf" style="width:${pct}%"></div>
      <div class="tick" style="left:${defPct}%" title="默认 350 ms"></div>
      <input type="range" id="tw" min="10" max="800" step="10" value="${win}">
    </div>
    <span class="v" id="twv">${win} ms</span>
  </div></div>`;

  board.innerHTML = html;

  const tw = document.getElementById("tw") as HTMLInputElement | null;
  if (tw) {
    tw.addEventListener("input", () => {
      const v = document.getElementById("twv");
      if (v) v.textContent = `${tw.value} ms`;
      const f = document.getElementById("twf");
      if (f) f.style.width = `${((Number(tw.value) - 10) / 790) * 100}%`;
    });
    // 松手时写盘，并同步页面内存里的这一层：否则下次重绘会拿旧值，
    // 把未设置过窗口的层又显示成默认 350。
    tw.addEventListener("change", () => {
      const ms = Number(tw.value);
      r.window = ms;
      void Service.setGestureWindow(r.id, ms);
    });
  }
}

/** 一个手势就是一个键帽：帽面是它绑的东西，空着就是没绑。 */
function gestureCap(r: Row, kind: "single" | "double"): string {
  const binding = kind === "single" ? r.onRelease : r.onDoubleTap;
  const face = binding ? keyFace(binding) : { cls: "", html: "" };
  const sel = selKey === `@${kind}` ? " sel" : "";
  const hint = kind === "single" ? `只按 ${r.title} 再松开` : `连按两下 ${r.title}`;
  return `<div class="g" data-key="@${kind}" title="${esc(hint)}">
    <div class="k ${face.cls}${sel}">${face.html}</div>
    <span>${kind === "single" ? "单击" : "双击"}</span>
  </div>`;
}

function activeEditor(): HTMLElement | null {
  return document.getElementById(draft.kind === "mark" ? "mark-field" : "q");
}

function renderInsp() {
  // 拼音组合期间换掉 textarea 会破坏输入法；组合结束后再恢复重绘。
  if (composing) return;
  const prev = document.activeElement;
  const caret = prev instanceof HTMLInputElement || prev instanceof HTMLTextAreaElement ? prev.selectionStart : null;
  const r = layer();
  if (!r || !selKey) {
    const base = r ? esc(r.title) : "这一层的键";
    insp.innerHTML = `<div class="lab">怎么配</div>
      <div class="empty">点一个键，右边直接改，改完就生效。</div>
      <div class="lab">键盘上的键</div>
      <div class="empty">按住 <b>${base}</b> 再按它，才会触发。</div>
      <div class="lab">下面两个键帽</div>
      <div class="empty">它们只认 <b>${base}</b> 本身，不叠加别的键：单击按一下就松开，双击连按两下。</div>`;
    return;
  }

  const gesture = selKey === "@single" || selKey === "@double";
  const act = bindingFor(selKey);
  const label = gesture ? (selKey === "@single" ? "单击" : "双击") : selKey.toUpperCase();
  const trigger = gesture
    ? selKey === "@single"
      ? `按一下 <b>${esc(r.title)}</b> 松开`
      : `连按两下 <b>${esc(r.title)}</b>`
    : `按住 <b>${esc(r.title)}</b> 再按 <b>${esc(label)}</b>`;

  let html = `<div class="insp-head">
    <span class="trigger">${trigger}</span>
  </div>`;

  html += `<div class="effect">`;
  if (!act) {
    html += `<span class="name muted">还没有绑定</span>`;
  } else if (act.type === "app") {
    html += `<img src="${iconFor(act.bundleID ?? "")}" alt=""><span class="name">${esc(appName(act.bundleID ?? ""))}</span>`;
  } else if (act.type === "note") {
    html += `<span class="chip">标记</span><span class="name note">放行 · ${esc(act.text ?? "")}</span>`;
  } else if (act.type === "key") {
    html += `<span class="chip">按键</span><span class="name">${esc(fullKeyLabel(act))}</span>`;
  } else {
    html += `<span class="chip block">屏蔽</span>${act.text ? `<span class="name note">${esc(act.text)}</span>` : ""}`;
  }
  html += `<span class="done${Date.now() < flashUntil ? " show" : ""}">已保存</span></div>`;

  html += `<div class="lab">换成</div>
    <div class="seg" id="seg">
      <button data-kind="app" class="${draft.kind === "app" ? "on" : ""}">软件</button>
      <button data-kind="mark" class="${draft.kind === "mark" ? "on" : ""}">标记</button>
      <button data-kind="key" class="${draft.kind === "key" ? "on" : ""}">按键</button>
    </div>`;

  if (draft.kind === "app") {
    html += `<div class="search"><input id="q" placeholder="搜索应用" value="${esc(appQuery)}"></div>
      <div class="results" id="results"></div>`;
  } else if (draft.kind === "mark") {
    html += `<div class="lab">这个键怎么处理</div>
      <div class="choice">
        <button data-blocked="false" class="${markBlocked ? "" : "on"}">放行</button>
        <button data-blocked="true" class="warn ${markBlocked ? "on" : ""}">屏蔽</button>
      </div>
      <textarea class="field area" id="mark-field" rows="2" placeholder="写下这个键的用途，例如「其他软件已占用」">${esc(markValue)}</textarea>
      <div class="save-row">
        <button class="btn pri" data-act="save-mark" ${markDirty && markValue.trim() && !composing ? "" : "disabled"}>保存标记</button>
      </div>`;
  } else if (draft.kind === "key") {
    const chip = (id: string) => `<button data-keymod="${id}" class="${keyMods.has(id) ? "on" : ""}">${modCap(id)}</button>`;
    html += `<div class="lab">按住这些修饰键</div>
      <div class="mrow"><span class="side">左</span><span class="mset">${MODS.slice(0, 4).map(chip).join("")}</span></div>
      <div class="mrow"><span class="side">右</span><span class="mset">${MODS.slice(4).map(chip).join("")}</span></div>
      <div class="lab">再按这个键</div>
      <div class="kp">${TARGET_KEYS.map((r) => `<div class="kpr">${r.map((k) => `<button data-target-key="${k.id}" class="${k.id === keyTarget ? "on" : ""}" style="flex-grow:${k.w}">${esc(/^[a-z]$/.test(k.id) ? k.id : k.label)}</button>`).join("")}</div>`).join("")}</div>`;
  }

  html += `<div class="acts">${act ? `<button class="btn dgr" data-act="delete">清空绑定</button>` : ""}</div>`;

  insp.innerHTML = html;

  const q = document.getElementById("q") as HTMLInputElement | null;
  if (q) {
    // 打字只重画列表，不动输入框本身，焦点和光标都不会丢。
    q.addEventListener("input", () => {
      appQuery = q.value;
      pickAt = -1;
      paintResults();
    });
    q.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      const list = filteredApps();
      if (!list.length) return;
      if (e.key === "Enter") {
        const app = pickAt >= 0 ? list[pickAt] : list[0];
        if (!app) return;
        e.preventDefault();
        chooseApp(app);
        return;
      }
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      pickAt = pickAt < 0 ? (step > 0 ? 0 : list.length - 1) : (pickAt + step + list.length) % list.length;
      paintResults();
      document.querySelector(".results .r.on")?.scrollIntoView({ block: "nearest" });
    });
    focusEditor(q, caret);
    paintResults();
    void loadApps();
  }
  const markField = document.getElementById("mark-field") as HTMLTextAreaElement | null;
  if (markField) {
    markField.addEventListener("compositionstart", () => { composing = true; });
    markField.addEventListener("compositionend", () => {
      composing = false;
      syncSaveButton();
    });
    markField.addEventListener("input", () => {
      markValue = markField.value;
      markDirty = markValue !== savedMark.text || markBlocked !== savedMark.blocked;
      syncSaveButton();
    });
    focusEditor(markField, caret);
  }
}

function syncSaveButton() {
  const btn = document.querySelector<HTMLButtonElement>("[data-act='save-mark']");
  if (btn) btn.disabled = !markDirty || !markValue.trim() || composing;
}

function resetMarkToNone() {
  savedMark = { text: "", blocked: false };
  markValue = "";
  markBlocked = false;
  markDirty = false;
}

// ---- writing --------------------------------------------------------------
//
// 软件、按键、删除都是点一下就写盘；标记文字要点「保存标记」才写。
// 写文件排队，避免连续点击时后到的覆盖先到的。

let flashUntil = 0;
let writeChain: Promise<void> = Promise.resolve();

async function clearGesture(layerID: string, key: string) {
  if (key === "@single") await Service.clearOnRelease(layerID);
  else if (key === "@double") await Service.clearOnDoubleTap(layerID);
  else await Service.deleteBinding(layerID, key);
}

async function writeGesture(layerID: string, key: string, kind: string, value: string) {
  if (kind === "note" && !value.trim()) await clearGesture(layerID, key);
  else if (key === "@single") await Service.setOnRelease(layerID, kind, value);
  else if (key === "@double") await Service.setOnDoubleTap(layerID, kind, value);
  else await Service.setBinding(layerID, key, kind, value);
  flashUntil = Date.now() + 1200;
  await refresh();
  setTimeout(() => document.querySelector(".effect .done")?.classList.remove("show"), 1200);
}

function focusEditor(tv: HTMLInputElement | HTMLTextAreaElement, at?: number | null) {
  tv.focus();
  const pos = Math.min(at ?? tv.value.length, tv.value.length);
  tv.setSelectionRange(pos, pos);
}

function queueWrite(layerID: string, key: string, kind: string, value: string) {
  writeChain = writeChain.then(() => writeGesture(layerID, key, kind, value)).catch(() => {});
  return writeChain;
}

// ---- actions --------------------------------------------------------------

async function refresh() {
  const next = await Service.view();
  const first = next.rows.find((r) => r.kind === "hold") ?? next.rows.find((r) => r.kind !== "divider");
  const hadSel = sel !== "";
  view = next;
  if (!sel || !next.rows.some((r) => r.id === sel)) {
    // 只有首次打开、或者选中的行真的没了，才换到别的层
    sel = hadSel ? (first?.id ?? "") : (first?.id ?? "");
    selKey = null;
  }
  render();
}

// ---- app picker -----------------------------------------------------------
//
// The whole list is read once and filtered in the page, the way Spotlight and
// Alfred do it: an empty field is every installed app in alphabetical order,
// typing only narrows it. One round trip, no rebuild of the field being typed
// into.

let pickAt = -1;
let appsList: AppInfo[] | null = null;
let appsPending: Promise<void> | null = null;
let appsError = false;
let iconIO: IntersectionObserver | null = null;

/** Prefix matches first, then the rest, each already alphabetical. */
function filteredApps(): AppInfo[] {
  const all = appsList ?? [];
  const needle = appQuery.trim().toLowerCase();
  if (!needle) return all;
  const starts: AppInfo[] = [];
  const rest: AppInfo[] = [];
  for (const a of all) {
    const name = a.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(a);
    else if (name.includes(needle)) rest.push(a);
  }
  return [...starts, ...rest];
}

function paintResults() {
  const box = document.getElementById("results");
  if (!box) return;
  iconIO?.disconnect();
  if (appsError) {
    box.innerHTML = `<div class="empty">读取应用列表失败</div>`;
    return;
  }
  if (!appsList) {
    box.innerHTML = `<div class="empty">正在读取应用列表…</div>`;
    return;
  }
  const list = filteredApps();
  if (!list.length) {
    box.innerHTML = `<div class="empty">没有匹配的应用</div>`;
    return;
  }
  if (pickAt >= list.length) pickAt = list.length - 1;
  // 当前绑定的软件在列表里标出来，选完不用靠保存按钮确认。
  const bound = selKey ? bindingFor(selKey) : undefined;
  const curApp = bound?.type === "app" ? bound.bundleID ?? "" : "";
  box.innerHTML = list
    .map((a, i) => {
      const cls = `r${i === pickAt ? " on" : ""}${a.id === curApp ? " cur" : ""}`;
      const mark = a.id === curApp ? `<span class="pick">当前</span>` : "";
      return `<div class="${cls}" data-pick="${esc(a.id)}" data-name="${esc(a.name)}"><img data-icon="${esc(a.id)}" alt=""><span class="rn">${esc(a.name)}</span>${mark}</div>`;
    })
    .join("");
  // 图标按需来：一次只取滚动到附近的那几行，不为整份列表排队。
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target as HTMLImageElement;
        io.unobserve(img);
        void Service.icon(img.dataset.icon ?? "")
          .then((url) => {
            if (url) img.src = url;
          })
          .catch(() => {});
      }
    },
    { root: box, rootMargin: "160px" },
  );
  iconIO = io;
  box.querySelectorAll("img[data-icon]").forEach((img) => io.observe(img));
}

async function loadApps() {
  if (!appsList) {
    if (!appsPending) {
      appsPending = Service.apps("")
        .then((list) => {
          appsList = list.slice().sort((a, b) => a.name.localeCompare(b.name));
          appsError = false;
        })
        .catch(() => {
          appsError = true;
          appsPending = null;
        });
    }
    await appsPending.catch(() => {});
  }
  paintResults();
}

function chooseApp(a: AppInfo) {
  pickAt = -1;
  if (!selKey) return;
  void queueWrite(sel, selKey, "app", a.id);
  resetMarkToNone();
}

function chooseKey(id: string) {
  const r = layer();
  if (!r) return;
  selKey = id;
  const act = bindingFor(id);
  draft.kind = act?.type === "app" ? "app" : act?.type === "key" ? "key" : "mark";
  appQuery = "";
  const text = act?.type === "note" || act?.type === "block" ? act.text ?? "" : "";
  markValue = text;
  markBlocked = act?.type === "block";
  savedMark = { text, blocked: markBlocked };
  markDirty = false;
  resetKeyDraft(act ?? undefined);
  pickAt = -1;
  render();
}

sheetHost.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const modBtn = t.closest("[data-mod]") as HTMLElement | null;
  if (modBtn) {
    const id = modBtn.dataset.mod!;
    pending.has(id) ? pending.delete(id) : pending.add(id);
    renderSheet();
    return;
  }
  if (t.classList.contains("overlay")) {
    addOpen = false;
    renderSheet();
    return;
  }
  const act = (t.closest("[data-act]") as HTMLElement | null)?.dataset.act;
  if (!act) return;
  if (act === "cancel-add") {
    addOpen = false;
    pending = new Set();
    renderSheet();
  } else if (act === "pick-hold") {
    addStep = "mods";
    renderSheet();
  } else if (act === "back-kind") {
    addStep = "kind";
    renderSheet();
  } else if (act === "add-divider") {
    await Service.insertDivider("");
    addOpen = false;
    renderSheet();
    await refresh();
  } else if (act === "create-layer") {
    if (pending.size === 0) return;
    const id = await Service.addLayer([...pending]);
    addOpen = false;
    pending = new Set();
    sel = id;
    selKey = null;
    renderSheet();
    await refresh();
  }
});

rail.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const lrow = t.closest(".lrow") as HTMLElement | null;
  if (lrow) {
    sel = lrow.dataset.id!;
    selKey = null;
    render();
    return;
  }
  const act = (t.closest("[data-act]") as HTMLElement | null)?.dataset.act;
  if (act === "open-add") {
    addOpen = true;
    addStep = "kind";
    pending = new Set();
    renderSheet();
  }
});

// 拖拽：按下后移动 5px 才算开始，一份克隆跟着指针，落点画一条线，
// 松手才真正改动数据。用指针事件而不是 HTML5 拖放：后者在 WebKit 里
// 起步有延迟、拖影无法控制、也没有落点提示。
let drag: {
  id: string;
  row: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLElement | null;
  offsetY: number;
} | null = null;

function railRows(): HTMLElement[] {
  return [...rail.querySelectorAll<HTMLElement>(".lrow, .sect")];
}

function rowId(el: HTMLElement): string {
  return el.dataset.id ?? el.dataset.drag ?? "";
}

function dropIndexAt(clientY: number, movingId: string): { index: number; y: number } {
  const rows = railRows().filter((el) => rowId(el) !== movingId);
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) {
      return { index: view!.rows.findIndex((x) => x.id === rowId(el)), y: r.top };
    }
  }
  const last = rows[rows.length - 1];
  if (!last) return { index: 0, y: 0 };
  const r = last.getBoundingClientRect();
  const lastIndex = view!.rows.findIndex((x) => x.id === rowId(last));
  return { index: lastIndex + 1, y: r.bottom };
}

function showLine(y: number) {
  let line = document.querySelector<HTMLElement>(".drop-line");
  if (!line) {
    line = document.createElement("div");
    line.className = "drop-line";
    document.body.appendChild(line);
  }
  line.style.top = `${y - 1}px`;
  line.style.left = "10px";
  line.style.right = `${innerWidth - rail.getBoundingClientRect().right + 8}px`;
}

function hideLine() {
  document.querySelector(".drop-line")?.remove();
}

rail.addEventListener("pointerdown", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".lrow, .sect");
  if (!row || e.button !== 0) return;
  e.preventDefault(); // 否则拖动会把行里的文字选中
  drag = {
    id: rowId(row),
    row,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    ghost: null,
    offsetY: e.clientY - row.getBoundingClientRect().top,
  };
  row.setPointerCapture(e.pointerId);
});

rail.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.abs(e.clientY - drag.startY) < 5 && Math.abs(e.clientX - drag.startX) < 5) return;
    // 开始拖：把行调淡，做一份跟着指针的克隆
    drag.active = true;
    const rect = drag.row.getBoundingClientRect();
    const ghost = drag.row.cloneNode(true) as HTMLElement;
    ghost.classList.add("ghost-row");
    ghost.classList.remove("on");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.userSelect = "none";
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.row.classList.add("dragging-src");
    // 关掉选字并清掉已经选中的部分：克隆里带着选中会渲染成蓝块
    document.body.classList.add("dragging");
    window.getSelection()?.removeAllRanges();
  }
  if (drag.ghost) {
    const rect = drag.row.getBoundingClientRect();
    drag.ghost.style.left = `${rect.left}px`;
    drag.ghost.style.top = `${e.clientY - drag.offsetY}px`;
  }
  const { y } = dropIndexAt(e.clientY, drag.id);
  showLine(y);
});

window.addEventListener("pointerup", async (e) => {
  const d = drag;
  drag = null;
  document.body.classList.remove("dragging");
  // 只有真的拖过才清选区：普通点击和窗口失焦也走这里，那时清掉输入框的光标。
  if (d) window.getSelection()?.removeAllRanges();
  hideLine();
  if (!d) return;
  d.ghost?.remove();
  d.row.classList.remove("dragging-src");
  if (!d.active || !view) return;

  const { index } = dropIndexAt(e.clientY, d.id);
  const ids = view.rows.map((x) => x.id);
  const from = ids.indexOf(d.id);
  if (from < 0) return;
  const target = index > from ? index - 1 : index;
  if (target === from) return;
  await Service.moveTo(d.id, target);
  await refresh();
});

function cancelDrag() {
  const d = drag;
  d?.ghost?.remove();
  d?.row.classList.remove("dragging-src");
  drag = null;
  document.body.classList.remove("dragging");
  if (d) window.getSelection()?.removeAllRanges();
  hideLine();
}

window.addEventListener("pointercancel", cancelDrag);
window.addEventListener("blur", cancelDrag);
// 窗口重新拿到焦点时，把光标还给还开着的文本框。
window.addEventListener("focus", () => {
  if (!selKey) return;
  if (draft.kind !== "mark") return;
  activeEditor()?.focus();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drag?.active) cancelDrag();
});

rail.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  const layer = target.closest<HTMLElement>(".lrow");
  const divider = target.closest<HTMLElement>(".sect");
  if (!layer && !divider) return;
  e.preventDefault();

  if (divider) {
    const id = divider.dataset.drag ?? "";
    if (!id) return;
    menu(e as MouseEvent, [
      { label: "删除分节线", danger: true, run: () => Service.removeItem(id) },
    ]);
    return;
  }

  const id = layer!.dataset.id ?? "";
  if (!id) return;
  menu(e as MouseEvent, [
    { label: "上移", run: () => Service.moveItem(id, -1) },
    { label: "下移", run: () => Service.moveItem(id, 1) },
    { divider: true },
    { label: "在上方插入分节线", run: () => Service.insertDivider(id) },
    { divider: true },
    { label: "删除", danger: true, run: () => Service.removeItem(id) },
  ]);
});

board.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const k = t.closest("[data-key]") as HTMLElement | null;
  if (k) {
    chooseKey(k.dataset.key!);
    return;
  }
  // 点键盘区空白处取消选中，右栏回到操作说明。滑块和手势键帽本身不算空白。
  if (t.closest(".slider-row, .g, .gesture")) return;
  if (selKey) {
    selKey = null;
    render();
  }
});

insp.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  // 点面板的空白处也回到文本框：输入框没拿到焦点时，按键会被系统当成
  // 没人处理的键，变成叮叮叮的提示音。
  if (selKey && !t.closest("[data-act],[data-kind],[data-pick],[data-keymod],[data-target-key],[data-blocked],input,textarea")) {
    activeEditor()?.focus();
  }
  const blockedBtn = t.closest("[data-blocked]") as HTMLElement | null;
  if (blockedBtn) {
    markBlocked = blockedBtn.dataset.blocked === "true";
    markDirty = markValue !== savedMark.text || markBlocked !== savedMark.blocked;
    renderInsp();
    return;
  }
  const kindBtn = t.closest("[data-kind]") as HTMLElement | null;
  if (kindBtn) {
    const next = kindBtn.dataset.kind as typeof draft.kind;
    if (!selKey || next === draft.kind) return;
    draft.kind = next;
    pickAt = -1;
    if (next === "key") {
      const binding = bindingFor(selKey);
      resetKeyDraft(binding ?? undefined);
    }
    renderInsp();
    return;
  }
  const targetMod = (t.closest("[data-keymod]") as HTMLElement | null)?.dataset.keymod;
  if (targetMod) {
    if (keyMods.has(targetMod)) keyMods.delete(targetMod);
    else keyMods.add(targetMod);
    renderInsp();
    return;
  }
  const targetKey = (t.closest("[data-target-key]") as HTMLElement | null)?.dataset.targetKey;
  if (targetKey) {
    if (!selKey) return;
    keyTarget = targetKey;
    const value = keyValue();
    if (value) {
      void queueWrite(sel, selKey, "key", value);
      resetMarkToNone();
    }
    renderInsp();
    return;
  }
  const rowEl = t.closest("[data-pick]") as HTMLElement | null;
  if (rowEl) {
    chooseApp({ id: rowEl.dataset.pick!, name: rowEl.dataset.name ?? "" });
    return;
  }
  const act = (t.closest("[data-act]") as HTMLElement | null)?.dataset.act;
  if (!act || !selKey) return;
  if (act === "save-mark") {
    if (!markValue.trim()) return;
    const kind = markBlocked ? "block" : "note";
    await queueWrite(sel, selKey, kind, markValue);
    savedMark = { text: markValue, blocked: markBlocked };
    markDirty = false;
    renderInsp();
  } else if (act === "delete") {
    await clearGesture(sel, selKey);
    selKey = null;
    await refresh();
  }
});

// ---- a menu drawn by us, not the system's ---------------------------------

function menu(at: MouseEvent, items: { label?: string; danger?: boolean; divider?: boolean; run?: () => unknown }[]) {
  document.querySelector(".menu")?.remove();
  const m = document.createElement("div");
  m.className = "menu";
  for (const it of items) {
    if (it.divider) {
      const hr = document.createElement("div");
      hr.className = "hr";
      m.appendChild(hr);
      continue;
    }
    const d = document.createElement("div");
    d.textContent = it.label ?? "";
    if (it.danger) d.className = "danger";
    d.onclick = async () => {
      m.remove();
      await it.run?.();
      await refresh();
    };
    m.appendChild(d);
  }
  document.body.appendChild(m);
  const rect = m.getBoundingClientRect();
  m.style.left = `${Math.min(at.clientX, innerWidth - rect.width - 8)}px`;
  m.style.top = `${Math.min(at.clientY, innerHeight - rect.height - 8)}px`;
  const close = (ev: MouseEvent) => {
    if (!m.contains(ev.target as Node)) {
      m.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

// ---- start ----------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (addOpen) {
      addOpen = false;
      renderSheet();
    } else if (selKey) {
      selKey = null;
      render();
    }
    return;
  }
  // 文本框开着、焦点却不在它身上：这一下也交给它。拦掉默认动作是为了不让
  // 系统把这次按键当成没人处理，响一声提示音；字符本身丢掉，下一次按键就
  // 正常落进框里。
  if (!selKey || e.metaKey || e.ctrlKey || e.altKey) return;
  if (draft.kind !== "mark") return;
  const editor = activeEditor() as HTMLTextAreaElement | null;
  if (!editor) return;
  const target = e.target;
  if (target === editor || (target instanceof HTMLElement && target.closest("input,textarea,[contenteditable]"))) return;
  e.preventDefault();
  editor.focus();
});

(async () => {
  // 让侧栏的名字先到，图标随后补上
  view = await Service.view();
  for (const r of view.rows) {
    for (const act of Object.values(r.keys ?? {})) {
      if (act?.type === "app" && act.bundleID) {
        const n = await Service.name(act.bundleID);
        names.set(act.bundleID, n);
      }
    }
  }
  await refresh();
})();
