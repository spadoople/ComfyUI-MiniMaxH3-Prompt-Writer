import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { canvasImageSources, createCanvasImagePicker, readCanvasImageFiles } from "../web/canvas_image_picker.js";

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
