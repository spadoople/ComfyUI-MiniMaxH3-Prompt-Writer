const IMAGE_LOADERS = new Set(["LoadImage", "LoadImageOutput"]);
const IMAGE_OUTPUTS = new Set(["PreviewImage", "SaveImage"]);
const CONVEYOR_NODES = new Set(["ImageConveyor", "SequentialBatchImageLoader"]);

function loaderImage(node, type) {
  return imageLocation(node.widgets?.find(widget => widget.name === "image")?.value,
    type === "LoadImageOutput" ? "output" : "input");
}

function selectedNodes(app) {
  return app.canvas?.selectedItems ?? new Set(Object.values(app.canvas?.selected_nodes || {}));
}

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

function conveyorState(node) {
  const value = node.widgets?.find(widget => widget.name === "state_json")?.value;
  try {
    const state = JSON.parse(value);
    return state && typeof state === "object" && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

function conveyorImage(entry) {
  // annotated identifies the stored ComfyUI copy. source_path can refer to an external original.
  const path = typeof entry?.annotated === "string" ? entry.annotated.trim().replaceAll("\\", "/") : "";
  const location = imageLocation(path, entry?.type || "input");
  if (!location || /^[a-z]:/i.test(path)) return null;
  const relativePath = path.replace(/ \[(input|output|temp)\]$/, "");
  if (relativePath.split("/").some(part => !part || part === "." || part === "..")) return null;
  return location;
}

function hasConveyorShelf(state) {
  // Older workflows inferred queue-group mode from the group size.
  return Object.hasOwn(state, "output_mode")
    ? String(state.output_mode).trim().toLowerCase() !== "queue_group"
    : !(Number(state.images_per_execution) > 1);
}

function conveyorRefEnabled(node, state, index) {
  const switches = node.properties?.image_conveyor_reference_enabled ?? state.reference_output_enabled;
  return switches?.[index] !== false;
}

function conveyorCanvasSources(node, label, selected) {
  const state = conveyorState(node);
  if (!state) return [];
  const shelf = hasConveyorShelf(state) && Array.isArray(state.reference_slots) ? state.reference_slots : [];
  const queue = Array.isArray(state.items) ? state.items : [];
  return [
    ...shelf.flatMap((entry, index) => {
      const source = conveyorImage(entry);
      if (!source) return [];
      const enabled = conveyorRefEnabled(node, state, index);
      return [{ ...source, label: `${label} · Ref ${index + 1}${enabled ? "" : " (off)"}`, selected: selected && enabled }];
    }),
    ...queue.flatMap((entry, index) => {
      const source = conveyorImage(entry);
      return source ? [{ ...source, label: `${label} · Queue ${index + 1}`, selected: false }] : [];
    }),
  ];
}

function conveyorConditioningSource(node, outputSlot, label) {
  const state = conveyorState(node);
  if (!state) throw new Error(`${label} has no readable Conveyor state`);
  const outputName = node.outputs?.[outputSlot]?.name;
  const match = outputName?.match(/^ref_image_([1-8])$/);
  if (!hasConveyorShelf(state) || !match) {
    const toggle = outputName === "image" ? ["image_conveyor_main_enabled", "main_output_enabled"]
      : outputName === "last_frame" ? ["image_conveyor_last_frame_enabled", "last_frame_output_enabled"] : null;
    if (hasConveyorShelf(state) && toggle && (node.properties?.[toggle[0]] ?? state[toggle[1]]) === false) return null;
    throw new Error(`${label} uses a queue-driven image. Select the intended queue file in Import from canvas`);
  }
  const index = Number(match[1]) - 1;
  const entry = state.reference_slots?.[index];
  if (!entry || !conveyorRefEnabled(node, state, index)) return null;
  const source = conveyorImage(entry);
  if (!source) throw new Error(`${label} Ref ${index + 1} has no readable staged image`);
  return { ...source, label: `${label} · Ref ${index + 1}`, selected: true };
}

export function canvasImageSources(app) {
  const graph = app.rootGraphOrUndefined || app.graph;
  const selected = selectedNodes(app);
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
      const nodeSelected = selected.has(node);
      let sources = [];
      if (CONVEYOR_NODES.has(type)) sources = conveyorCanvasSources(node, label, nodeSelected);
      else if (IMAGE_LOADERS.has(type)) sources = [loaderImage(node, type)];
      else if (Array.isArray(images)) {
        sources = images.map(image => imageLocation(image?.filename, image?.type ?? "output", image?.subfolder));
      }
      for (const source of sources) {
        if (!source) continue;
        const { filename, subfolder, type: folder } = source;
        const key = JSON.stringify([folder, subfolder, filename]);
        const fromSelectedNode = source.selected ?? nodeSelected;
        if (!candidates.has(key) || (fromSelectedNode && !candidates.get(key).selected)) {
          candidates.set(key, { ...source, label: source.label ?? label, selected: fromSelectedNode });
        }
      }
      visit(node.subgraph, `${label} / `);
    }
  }

  visit(graph);
  return [...candidates.values()];
}

function graphLink(graph, id) {
  return graph.getLink?.(id) ?? graph.links?.get?.(id) ?? graph.links?.[id] ?? graph._links?.get?.(id);
}

export function conditioningImageSources(app) {
  const root = app.rootGraphOrUndefined || app.graph;
  const selected = selectedNodes(app);
  const candidates = [];

  function visit(graph, parent = null, owner = null) {
    if (!graph) return;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) if (ancestor.graph === graph) return;
    const context = { graph, parent, owner, selected: selected.has(owner) || Boolean(parent?.selected) };
    for (const node of graph.nodes ?? graph._nodes ?? []) {
      if ((node.comfyClass || node.type) === "MiniMaxH3ImageConditioning") candidates.push({ node, context });
      if (node.subgraph) visit(node.subgraph, context, node);
    }
  }

  function trace(context, id, seen = new Set()) {
    if (id == null) return null;
    const { graph, parent, owner } = context;
    const key = `${graph.id ?? "root"}:${id}`;
    if (seen.has(key)) throw new Error("a link loops back on itself");
    seen.add(key);
    const link = graphLink(graph, id);
    if (!link) throw new Error("its connection is unavailable");
    if (parent && String(link.origin_id) === String(graph.inputNode?.id ?? -10)) {
      return trace(parent, owner.inputs?.[link.origin_slot]?.link, seen);
    }
    const node = graph.getNodeById?.(link.origin_id)
      ?? (graph.nodes ?? graph._nodes ?? []).find(item => String(item.id) === String(link.origin_id));
    if (!node) throw new Error("its source node is unavailable");
    const type = node.comfyClass || node.type;
    const label = `${node.title || type} #${node.id}`;
    if (CONVEYOR_NODES.has(type)) return conveyorConditioningSource(node, link.origin_slot, label);
    if (IMAGE_LOADERS.has(type) && Number(link.origin_slot) === 0) {
      const source = loaderImage(node, type);
      if (source) return { ...source, label, selected: true };
      throw new Error(`${label} has no selected file`);
    }
    if (/^(?:Reroute|Reroute \(rgthree\))$/i.test(type)) {
      return trace(context, node.inputs?.[0]?.link, seen);
    }
    if (node.subgraph) {
      const subgraph = node.subgraph;
      const output = subgraph.outputs?.[link.origin_slot];
      const innerLink = subgraph.outputNode?.inputs?.[link.origin_slot]?.link ?? output?.linkIds?.[0];
      if (innerLink != null) return trace({ graph: subgraph, parent: context, owner: node }, innerLink, seen);
    }
    throw new Error(`${label} produces a processed image. Use a saved or previewed result with Import from canvas`);
  }

  visit(root);
  const chosen = candidates.filter(({ node, context }) => selected.has(node) || context.selected);
  const matches = chosen.length ? chosen : candidates;
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Select one MiniMax H3 Image Conditioning node, or its containing subgraph."
      : "Add a MiniMax H3 Image Conditioning node to this workflow.");
  }
  const { node, context } = matches[0];
  const slots = (node.inputs || []).flatMap(input => {
    const match = input.name?.match(/^(?:images\.)?image_(\d+)$/);
    return match && input.link != null ? [{ number: Number(match[1]), link: input.link }] : [];
  }).sort((left, right) => left.number - right.number);
  const sources = slots.flatMap(slot => {
    try {
      const source = trace(context, slot.link);
      return source ? [{ ...source, label: `image_${slot.number} · ${source.label}` }] : [];
    } catch (error) {
      throw new Error(`Could not import image_${slot.number}. ${error.message}.`);
    }
  });
  if (!sources.length) throw new Error("Connect an image to MiniMax H3 Image Conditioning first.");
  return sources;
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
  let fixedOrder = false;

  function sync() {
    const { pictureCount, remaining } = getCapacity();
    submit.disabled = busy || !ordered.length || ordered.length > remaining;
    submit.textContent = busy ? "Importing…" : ordered.length ? `Import ${ordered.length}` : "Import";
    cancel.disabled = busy;
    const displayed = [...ordered, ...rows.filter(row => !ordered.includes(row))];
    displayed.forEach((row, position) => {
      const index = ordered.indexOf(row);
      row.order.textContent = index < 0 ? "" : `Picture ${pictureCount + index + 1}`;
      row.checkbox.disabled = busy || fixedOrder || (index < 0 && ordered.length >= remaining);
      row.checkbox.checked = index >= 0;
      row.up.hidden = row.down.hidden = fixedOrder || index < 0;
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
    open(sources, { keepOrder = false } = {}) {
      if (dialog.open) return;
      list.replaceChildren();
      rows = sources.map(makeRow);
      const { remaining } = getCapacity();
      fixedOrder = keepOrder;
      ordered = keepOrder ? rows : rows.filter(row => row.source.selected).slice(0, remaining);
      status.textContent = "";
      hint.textContent = keepOrder ? "Import the connected images in the conditioning node’s Picture order."
        : !sources.length ? "Add a Load Image or run a Preview Image or Save Image node first."
        : remaining === 0 ? "Remove a reference before importing more pictures."
        : `Select up to ${remaining} ${remaining === 1 ? "image" : "images"}. Move selections up or down to set their Picture numbers.`;
      sync();
      dialog.showModal();
    },
    isOpen: () => dialog.open,
    close,
  };
}
