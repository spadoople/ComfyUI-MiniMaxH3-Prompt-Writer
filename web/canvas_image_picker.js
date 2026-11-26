const IMAGE_LOADERS = new Set(["LoadImage", "LoadImageOutput"]);
const IMAGE_OUTPUTS = new Set(["PreviewImage", "SaveImage"]);

function imageLocation(path, folder = "input", subfolder = "") {
  if (typeof path !== "string" || !path.trim()) return null;
  const annotation = path.match(/ \[(input|output|temp)\]$/);
  if (annotation) {
    folder = annotation[1];
    path = path.slice(0, annotation.index);
  }
  if (!["input", "output", "temp"].includes(folder) || typeof subfolder !== "string") return null;
  const parts = path.replaceAll("\\", "/").split("/");
  const filename = parts.pop();
  if (!filename) return null;
  return { filename, subfolder: [subfolder, ...parts].filter(Boolean).join("/"), type: folder };
}

export function canvasImageSources(app) {
  const graph = app.rootGraphOrUndefined || app.graph;
  const selected = app.canvas?.selectedItems ?? new Set(Object.values(app.canvas?.selected_nodes || {}));
  const candidates = new Map();
  const visited = new Set();

  function visit(graph, prefix = "") {
    if (!graph || visited.has(graph)) return;
    visited.add(graph);
    for (const node of graph.nodes ?? graph._nodes ?? []) {
      const type = node.comfyClass || node.type;
      const label = `${prefix}${node.title || type} #${node.id}`;
      const outputKey = prefix && graph.id ? `${graph.id}:${node.id}` : node.id;
      const images = IMAGE_OUTPUTS.has(type) ? app.nodeOutputs?.[outputKey]?.images ?? node.images : null;
      const sources = IMAGE_LOADERS.has(type)
        ? [imageLocation(node.widgets?.find(widget => widget.name === "image")?.value, type === "LoadImageOutput" ? "output" : "input")]
        : (Array.isArray(images) ? images.map(image => imageLocation(image?.filename, image?.type ?? "output", image?.subfolder)) : []);
      for (const source of sources) {
        if (!source) continue;
        const key = JSON.stringify(source);
        const fromSelectedNode = selected.has(node);
        if (!candidates.has(key) || fromSelectedNode) {
          candidates.set(key, { ...source, label, selected: fromSelectedNode });
        }
      }
      visit(node.subgraph, `${label} / `);
    }
  }

  visit(graph);
  return [...candidates.values()];
}

function imageRoute({ filename, subfolder, type }) {
  return `/view?${new URLSearchParams({ filename, subfolder, type })}`;
}

export async function readCanvasImageFiles(sources, fetchApi) {
  const files = [];
  for (const source of sources) {
    const response = await fetchApi(imageRoute(source));
    if (!response.ok) throw new Error(`Could not read the image from ${source.label} (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.type === "image/svg+xml") {
      throw new Error(`The file from ${source.label} is not a supported image.`);
    }
    // Asset picker widgets may contain a hash in place of a filename.
    const match = response.headers.get("Content-Disposition")?.match(/(?:^|;\s*)filename="((?:[^"\\]|\\.)*)"/i);
    const filename = match?.[1].replace(/\\(.)/g, "$1").split(/[\\/]/).pop() || source.filename;
    files.push(new File([blob], filename, { type: blob.type }));
  }
  return files;
}

export function createCanvasImagePicker({ root, viewUrl, onImport, getCapacity }) {
  const dialog = document.createElement("dialog");
  dialog.className = "h3ps-canvas-picker";
  dialog.setAttribute("aria-labelledby", "h3ps-canvas-picker-title");
  dialog.innerHTML = `
    <header><strong id="h3ps-canvas-picker-title">Import from canvas</strong></header>
    <p data-picker-hint></p>
    <div class="h3ps-canvas-picker-list" data-picker-list></div>
    <footer>
      <p role="status" data-picker-status></p>
      <button type="button" class="h3ps-secondary-button" data-picker-cancel>Cancel</button>
      <button type="button" class="h3ps-primary-button" data-picker-import>Import</button>
    </footer>`;
  root.append(dialog);

  const list = dialog.querySelector("[data-picker-list]");
  const hint = dialog.querySelector("[data-picker-hint]");
  const status = dialog.querySelector("[data-picker-status]");
  const cancel = dialog.querySelector("[data-picker-cancel]");
  const submit = dialog.querySelector("[data-picker-import]");
  let rows = [];
  let ordered = [];
  let busy = false;

  function sync() {
    const { pictureCount, remaining } = getCapacity();
    submit.disabled = busy || !ordered.length || ordered.length > remaining;
    submit.textContent = busy ? "Importing…" : ordered.length ? `Import ${ordered.length}` : "Import";
    cancel.disabled = busy;
    const displayed = [...ordered, ...rows.filter(row => !ordered.includes(row))];
    displayed.forEach((row, position) => {
      const index = ordered.indexOf(row);
      row.order.textContent = index < 0 ? "" : `Picture ${pictureCount + index + 1}`;
      row.checkbox.disabled = busy || (index < 0 && ordered.length >= remaining);
      row.checkbox.checked = index >= 0;
      row.up.hidden = row.down.hidden = index < 0;
      row.up.disabled = busy || index <= 0;
      row.down.disabled = busy || index >= ordered.length - 1;
      if (list.children[position] !== row.element) list.insertBefore(row.element, list.children[position] ?? null);
    });
  }

  function move(row, offset, control) {
    const index = ordered.indexOf(row);
    if (index < 0 || index + offset < 0 || index + offset >= ordered.length) return;
    ordered.splice(index, 1);
    ordered.splice(index + offset, 0, row);
    sync();
    (control.disabled ? (offset < 0 ? row.down : row.up) : control).focus();
  }

  function makeRow(source) {
    const element = document.createElement("div");
    element.className = "h3ps-canvas-picker-row";
    element.innerHTML = `
      <label><input type="checkbox"><img alt="" loading="lazy"><span><strong></strong><small></small></span></label>
      <span class="h3ps-canvas-picker-order"></span>
      <button type="button" class="h3ps-icon-button">↑</button>
      <button type="button" class="h3ps-icon-button">↓</button>`;
    const row = {
      source, element, checkbox: element.querySelector("input"), order: element.querySelector(".h3ps-canvas-picker-order"),
      up: element.querySelector("button"), down: element.querySelector("button:last-child"),
    };
    const name = source.filename.startsWith("blake3:") ? `Image asset ${source.filename.slice(7, 15)}` : source.filename;
    element.querySelector("strong").textContent = name;
    element.querySelector("small").textContent = source.label;
    const thumbnail = element.querySelector("img");
    thumbnail.src = viewUrl(imageRoute(source));
    thumbnail.addEventListener("error", () => { thumbnail.alt = "Preview unavailable"; });
    row.up.title = `Move ${name} earlier`;
    row.down.title = `Move ${name} later`;
    row.up.setAttribute("aria-label", row.up.title);
    row.down.setAttribute("aria-label", row.down.title);
    row.up.addEventListener("click", () => move(row, -1, row.up));
    row.down.addEventListener("click", () => move(row, 1, row.down));
    row.checkbox.addEventListener("change", () => {
      status.textContent = "";
      if (row.checkbox.checked) ordered.push(row);
      else ordered = ordered.filter(item => item !== row);
      sync();
      row.checkbox.focus();
    });
    return row;
  }

  function close() {
    if (busy) return false;
    if (dialog.open) dialog.close();
    return true;
  }

  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    list.replaceChildren();
    rows = [];
    ordered = [];
  });
  submit.addEventListener("click", async () => {
    if (submit.disabled) return;
    busy = true;
    status.textContent = "Reading selected images…";
    sync();
    try {
      await onImport(ordered.map(({ source }) => source));
      dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      sync();
      if (dialog.open) submit.focus();
    }
  });

  return {
    open(sources) {
      if (dialog.open) return;
      list.replaceChildren();
      rows = sources.map(makeRow);
      const { remaining } = getCapacity();
      ordered = rows.filter(row => row.source.selected).slice(0, remaining);
      status.textContent = "";
      hint.textContent = !sources.length ? "Add a Load Image or run a Preview Image or Save Image node first."
        : remaining === 0 ? "Remove a reference before importing more pictures."
        : `Select up to ${remaining} ${remaining === 1 ? "image" : "images"}. Move selections up or down to set their Picture numbers.`;
      sync();
      dialog.showModal();
    },
    isOpen: () => dialog.open,
    close,
  };
}
