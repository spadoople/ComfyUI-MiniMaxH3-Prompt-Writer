import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { canvasImageSources, conditioningImageSources, createCanvasImagePicker, readCanvasImageFiles } from "../web/canvas_image_picker.js";

function conveyorFixture() {
  const image = filename => ({ filename, annotated: `characters/A & B/${filename} [input]`, type: "input" });
  const state = {
    output_mode: "persistent_refs", main_output_enabled: false, last_frame_output_enabled: false,
    reference_output_enabled: [true, false, true, true],
    reference_slots: [image("base.png"), image("disabled.png"), null, image("donor.png")],
    items: [{ ...image("processed.png"), id: "previous", status: "processed" }],
  };
  const node = { id: 52, type: "ImageConveyor", widgets: [{ name: "state_json", value: JSON.stringify(state) }], outputs: [] };
  node.outputs[6] = { name: "ref_image_1" };
  node.outputs[7] = { name: "ref_image_2" };
  node.outputs[8] = { name: "ref_image_3" };
  node.outputs[9] = { name: "ref_image_4" };
  const condition = { id: 8, type: "MiniMaxH3ImageConditioning", inputs: [
    { name: "images.image_4", link: 44 }, { name: "images.image_2", link: 42 },
    { name: "images.image_1", link: 41 }, { name: "images.image_3", link: 43 },
  ] };
  const links = Object.fromEntries([6, 7, 8, 9].map((slot, index) => [41 + index, { origin_id: 52, origin_slot: slot }]));
  const app = { graph: { _nodes: [node, condition], links }, canvas: { selectedItems: new Set([node]) } };
  return { app, node, state };
}

test("canvas picker lists the Conveyor shelf and staged queue files from the current widget", () => {
  const { app, node } = conveyorFixture();
  node.type = "SequentialBatchImageLoader";
  const sources = canvasImageSources(app);
  assert.deepEqual(sources.map(source => source.filename), ["base.png", "disabled.png", "donor.png", "processed.png"]);
  assert.ok(sources.every(source => source.type === "input" && source.subfolder === "characters/A & B"));
  assert.deepEqual(sources.map(source => source.selected), [true, false, true, false]);
});

test("wired Conveyor shelf outputs follow conditioning order and skip empty or disabled slots", () => {
  const { app, node } = conveyorFixture();
  assert.deepEqual(conditioningImageSources(app).map(source => source.filename), ["base.png", "donor.png"]);
  node.properties = { image_conveyor_reference_enabled: [false, true, true, true] };
  assert.deepEqual(conditioningImageSources(app).map(source => source.filename), ["disabled.png", "donor.png"]);
});

test("Conveyor queue-group files are selectable without guessing the next wired execution", () => {
  const { app, node, state } = conveyorFixture();
  state.output_mode = "queue_group";
  state.items.push({ id: "bad", annotated: "../external.png [input]", source_path: "C:/external.png", status: "pending" });
  node.widgets[0].value = JSON.stringify(state);
  assert.deepEqual(canvasImageSources(app).map(source => source.filename), ["processed.png"]);
  assert.throws(() => conditioningImageSources(app), /queue-driven image.*Import from canvas/);
});

test("conditioning import follows numeric slots and resolves exposed subgraph inputs", () => {
  const load = (id, value) => ({ id, type: "LoadImage", widgets: [{ name: "image", value }] });
  const condition = { id: 7, type: "MiniMaxH3ImageConditioning", inputs: [
    { name: "images.image_10", link: 10 }, { name: "images.image_1", link: 11 },
    { name: "images.image_3", link: 12 }, { name: "images.image_2", link: 13 },
  ] };
  const subgraph = { id: "child", _nodes: [condition, load(6, "local.png")], links: new Map([
    [10, { origin_id: -10, origin_slot: 2 }], [11, { origin_id: -10, origin_slot: 0 }],
    [12, { origin_id: 6, origin_slot: 0 }], [13, { origin_id: -10, origin_slot: 1 }],
  ]) };
  const owner = { id: 3, subgraph, inputs: [{ link: 20 }, { link: null }, { link: 21 }] };
  const root = { id: "parent", _nodes: [load(1, "base.png"), load(2, "donor.png"), owner], links: {
    20: { origin_id: 1, origin_slot: 0 }, 21: { origin_id: 2, origin_slot: 0 },
  } };
  const app = { graph: root, canvas: { selectedItems: new Set([owner]) } };
  assert.deepEqual(conditioningImageSources(app).map(source => source.filename), ["base.png", "local.png", "donor.png"]);
  root._nodes[1].type = "CropImage";
  assert.throws(() => conditioningImageSources(app), /image_10.*processed image/);
});

test("conditioning import requires a single target and preserves duplicate picture slots", () => {
  const node = { id: 1, type: "LoadImage", widgets: [{ name: "image", value: "repeat.png" }] };
  const input = { name: "images.image_1", link: 21 };
  const first = { id: 2, type: "MiniMaxH3ImageConditioning", inputs: [input, { name: "image_2", link: 22 }] };
  const second = { id: 3, type: "MiniMaxH3ImageConditioning", inputs: [input] };
  const app = { graph: { _nodes: [node, first, second], links: {
    21: { origin_id: 1, origin_slot: 0 }, 22: { origin_id: 1, origin_slot: 0 },
  } }, canvas: { selectedItems: new Set() } };
  assert.throws(() => conditioningImageSources(app), /Select one MiniMax H3 Image Conditioning/);
  app.canvas.selectedItems.add(first);
  assert.deepEqual(conditioningImageSources(app).map(source => source.filename), ["repeat.png", "repeat.png"]);
});

test("finds staged inputs and completed image outputs across the workflow", () => {
  const load = (id, value, comfyClass = "LoadImage") => ({ id, comfyClass, widgets: [{ name: "image", value }] });
  const selected = load(2, "references\\person & dog.png");
  const preview = { id: 1, type: "PreviewImage" };
  const root = {
    _nodes: [load(1, "references/person & dog.png"), selected, load(3, "previous.png [output]"),
      load(4, "blake3:asset-hash"), { id: 5, type: "SaveImage" }, { id: 6, type: "PreviewImage" },
      { id: 7, type: "LoadVideo", images: [{ filename: "clip.mp4", type: "output" }] },
      { id: 8, title: "Detail pass", subgraph: { id: "nested", nodes: [preview, load(9, "last.png", "LoadImageOutput")] } }],
  };
  const sources = canvasImageSources({
    rootGraphOrUndefined: root,
    canvas: { selectedItems: new Set([selected]) },
    nodeOutputs: {
      5: { images: [{ filename: "render.png", subfolder: "runs/saturday", type: "output" }] },
      "nested:1": { images: [{ filename: "preview.png", type: "temp" }] },
    },
  });
  assert.deepEqual(sources.map(({ filename, subfolder, type }) => [filename, subfolder, type]), [
    ["person & dog.png", "references", "input"], ["previous.png", "", "output"],
    ["blake3:asset-hash", "", "input"], ["render.png", "runs/saturday", "output"],
    ["preview.png", "", "temp"], ["last.png", "", "output"],
  ]);
  assert.equal(sources[0].selected, true);
  assert.match(sources[0].label, /#2$/);
  assert.equal(sources[4].label, "Detail pass #8 / PreviewImage #1");
});

test("reads full images in requested order and resolves hash-backed filenames", async () => {
  const sources = [
    { filename: "blake3:abc", subfolder: "", type: "input", label: "Load Image #2" },
    { filename: "dog & cat.png", subfolder: "pets/small", type: "temp", label: "Preview Image #4" },
  ];
  const requests = [];
  const files = await readCanvasImageFiles(sources, async route => {
    const url = new URL(route, "http://localhost");
    requests.push(url);
    return new Response(url.searchParams.get("filename"), { headers: {
      "Content-Type": "image/png",
      ...(requests.length === 1 ? { "Content-Disposition": 'filename="portrait.png"' } : {}),
    } });
  });
  assert.deepEqual(files.map(file => file.name), ["portrait.png", "dog & cat.png"]);
  assert.equal(requests[1].searchParams.get("subfolder"), "pets/small");
  assert.equal(requests[1].searchParams.get("type"), "temp");
  assert.equal(requests[1].searchParams.has("preview"), false);
  await assert.rejects(readCanvasImageFiles(sources, async () => new Response(null, { status: 404 })), /Load Image #2.*404/);
  await assert.rejects(readCanvasImageFiles(sources, async () => new Response("text")), /not a supported image/);
});

test("shows append order, enforces remaining slots and imports the reordered selection", async t => {
  const window = new Window();
  const oldDocument = globalThis.document;
  globalThis.document = window.document;
  t.after(async () => { globalThis.document = oldDocument; await window.happyDOM.close(); });
  const imported = [];
  const picker = createCanvasImagePicker({
    root: document.body,
    viewUrl: () => "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    getCapacity: () => ({ pictureCount: 7, remaining: 2 }),
    onImport: async sources => imported.push(sources.map(source => source.filename)),
  });
  const source = (filename, selected = false) => ({ filename, subfolder: "", type: "input", label: filename, selected });
  picker.open([source("one.png"), source("two.png", true), source("three.png")]);
  const rows = () => [...document.querySelectorAll(".h3ps-canvas-picker-row")];
  assert.equal(rows()[0].querySelector("strong").textContent, "two.png");
  assert.equal(rows()[0].querySelector(".h3ps-canvas-picker-order").textContent, "Picture 8");
  rows()[1].querySelector("input").click();
  assert.equal(rows()[2].querySelector("input").disabled, true);
  rows()[1].querySelector("button").click();
  assert.equal(rows()[0].querySelector("strong").textContent, "one.png");
  document.querySelector("[data-picker-import]").click();
  await Promise.resolve();
  assert.deepEqual(imported, [["one.png", "two.png"]]);
  assert.equal(picker.isOpen(), false);
});
