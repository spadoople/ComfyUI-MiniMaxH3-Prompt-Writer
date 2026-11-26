import unittest
from unittest.mock import Mock, patch

from backend.assembly import AssemblyError, assemble_refinement, assemble_request
from backend.h3_pipeline import _audit, run_h3_pipeline, validate_media_capabilities
from backend.media import MediaError, MediaStore
from backend.models.contract import ModelError


class ImageModeTests(unittest.TestCase):
    session = "11111111-2222-4333-8444-555555555555"

    def setUp(self):
        self.store = MediaStore()
        store_patch = patch("backend.assembly.STORE", self.store)
        store_patch.start()
        self.addCleanup(store_patch.stop)
        pipeline_store = patch("backend.h3_pipeline.STORE", self.store)
        pipeline_store.start()
        self.addCleanup(pipeline_store.stop)

    def body(self, mode="ImageEdit", **fields):
        return {"session_id": self.session, "mode": mode, "aspect_ratio": "3:4",
                "creative_brief": 'Put the words "夜の庭" on the sign.', **fields}

    def add_picture(self, number):
        return self.store.commit_add(self.session, "ImageEdit", {
            "id": f"image-{number}", "session_id": self.session, "mode": "ImageEdit",
            "type": "image", "filename": f"frame-{number}.png", "width": 768, "height": 1024,
        })

    def test_text_to_image_accepts_a_text_only_model_and_omits_duration(self):
        request = assemble_request(self.body("ImageCreate"))
        validate_media_capabilities({"family": "gguf", "capabilities": {"images": False}}, request)
        self.assertEqual(request["media_inputs"], [])
        self.assertIsNone(request["input"]["duration_seconds"])
        self.assertIn("夜の庭", request["messages"][-1]["content"])
        self.assertNotIn("Duration:", request["messages"][-1]["content"])
        self.assertTrue(_audit("A garden from <Picture 1>.", request)[0]["repair_required"])

    def test_edit_requires_a_base_and_accepts_sixteen_ordered_images(self):
        with self.assertRaises(AssemblyError) as missing:
            assemble_request(self.body())
        self.assertEqual(missing.exception.code, "IMAGE_REFERENCE_REQUIRED")
        for number in range(1, 17):
            added = self.add_picture(number)
            self.assertEqual(added["reference"], f"<Picture {number}>")
        with self.assertRaises(MediaError) as full:
            self.add_picture(17)
        self.assertEqual(full.exception.code, "MEDIA_LIMIT_REACHED")
        with self.assertRaises(MediaError):
            self.store.prepare_add(self.session, "ImageEdit", "clip.mp4", "video/mp4", None)
        ids = [f"image-{number}" for number in range(16, 0, -1)]
        self.store.reorder(self.session, "ImageEdit", ids)
        request = assemble_request(self.body(creative_brief="Borrow the lettering from <Picture 16>."))
        self.assertEqual([source["asset_id"] for source in request["media_inputs"]], ids)
        self.assertIn("frame-16.png (image) — base image", request["messages"][-1]["content"])
        self.assertFalse(_audit("The sign in <Picture 16> supplies the lettering.", request)[0]["repair_required"])
        with self.assertRaises(ModelError):
            validate_media_capabilities({"family": "ollama", "capabilities": {"images": False}}, request)
        with self.assertRaises(AssemblyError) as unknown:
            assemble_request(self.body(creative_brief="Use <Picture 17>."))
        self.assertEqual(unknown.exception.code, "REFERENCE_NOT_FOUND")

    def test_edit_refine_uses_current_pictures_and_no_video_audit(self):
        self.add_picture(1)
        self.add_picture(2)
        request = assemble_refinement(self.body(current_prompt="The sign in <Picture 1> is red.",
                                                instruction="Change the lighting only."), None)
        self.assertEqual([source["reference"] for source in request["media_inputs"]], ["<Picture 1>", "<Picture 2>"])
        self.assertIn("Change the lighting only.", request["messages"][-1]["content"])
        response = lambda text: {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}
        complete = Mock(side_effect=[response("[Shot 1] A sign from <Picture 9>."),
                                     response("The red sign from <picture 1> catches soft daylight.")])
        with patch("backend.h3_pipeline._asset_data_uri", return_value="data:image/png;base64,eA=="):
            result = run_h3_pipeline(
                {"family": "ollama", "capabilities": {"images": True}}, request, self.session,
                {"max_output_tokens": 4096, "context_tokens": 32768}, complete=complete,
                count_text_tokens=lambda text: len(text.split()), is_cancelled=lambda: False,
                thinking=False, seed=None,
            )
        self.assertEqual(result["prompt"], "The red sign from <Picture 1> catches soft daylight.")
        self.assertTrue(result["format_repair_applied"])
        self.assertEqual(complete.call_args_list[-1].kwargs["purpose"], "repair")
