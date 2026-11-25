import { Service, type CommandInfo } from "./mygo";
import "./launcher.css";

document.body.innerHTML = `
  <div class="launcher">
    <div class="searchbar">
      <input id="query" type="text" placeholder="Search for apps and commands…" autocomplete="off" spellcheck="false" aria-label="搜索应用与命令">
    </div>
    <div class="results" id="results"></div>
    <div class="foot">
      <span class="left">MyCast</span>
      <span class="action">Open Command <span class="keys"><span class="kbd">↵</span></span></span>
      <span class="sep"></span>
      <span class="action">Actions <span class="keys"><span class="kbd">⌘</span><span class="kbd">K</span></span></span>
    </div>
  </div>
`;

const input = document.getElementById("query") as HTMLInputElement;
const results = document.getElementById("results") as HTMLDivElement;

let items: CommandInfo[] = [];
let selected = 0;

function makeRow(cmd: CommandInfo, index: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className = `row${index === selected ? " on" : ""}`;
  row.dataset.id = cmd.id;

  const icon = document.createElement("span");
  icon.className = "ico";
  icon.textContent = cmd.id === "keyboard-mapping" ? "⌨" : "•";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = cmd.title;

  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = cmd.subtitle;

  const tail = document.createElement("span");
  tail.className = "tail";
  const keys = document.createElement("span");
  keys.className = "keys";
  for (const keyName of Array.from(cmd.shortcut)) {
    const key = document.createElement("span");
    key.className = "kbd";
    key.textContent = keyName;
    keys.append(key);
  }
  tail.append(keys);
  const type = document.createElement("span");
  type.className = "type";
  type.textContent = cmd.type;
  tail.append(type);

  row.append(icon, name, sub, tail);
  row.addEventListener("click", () => {
    selected = index;
    void openSelected();
  });
  return row;
}

function render(): void {
  results.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有匹配的命令";
    results.append(empty);
    return;
  }
  const section = document.createElement("div");
  section.className = "section";
  section.textContent = "命令";
  results.append(section);
  items.forEach((cmd, index) => results.append(makeRow(cmd, index)));
}

async function refresh(): Promise<void> {
  items = await Service.commands(input.value);
  selected = 0;
  render();
}

async function openSelected(): Promise<void> {
  const cmd = items[selected];
  if (cmd) {
    await Service.openCommand(cmd.id);
  }
}

input.addEventListener("input", () => void refresh());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    void Service.hideLauncher();
    return;
  }
  if (event.key === "ArrowDown" && items.length > 0) {
    event.preventDefault();
    selected = (selected + 1) % items.length;
    render();
    return;
  }
  if (event.key === "ArrowUp" && items.length > 0) {
    event.preventDefault();
    selected = (selected - 1 + items.length) % items.length;
    render();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void openSelected();
  }
});

void refresh();
input.focus();
