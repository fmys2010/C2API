from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

import services.config
from services.image_storage_service import ImageStorageService


def png_bytes() -> bytes:
    path = Path(tempfile.gettempdir()) / "chatgpt2api-test-image.png"
    Image.new("RGB", (2, 2), color=(255, 0, 0)).save(path, format="PNG")
    return path.read_bytes()


class ImageStorageServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.images_dir = self.data_dir / "images"

        self.p1 = mock.patch(
            "services.config.ConfigStore.images_dir",
            new_callable=mock.PropertyMock,
            return_value=self.images_dir,
        )
        self.p2 = mock.patch(
            "services.config.ConfigStore.base_url",
            new_callable=mock.PropertyMock,
            return_value="https://api.example.test",
        )
        self.p3 = mock.patch.object(
            services.config.config,
            "cleanup_old_images",
            return_value=None,
        )
        self.p1.start()
        self.p2.start()
        self.p3.start()
        self.addCleanup(self.p1.stop)
        self.addCleanup(self.p2.stop)
        self.addCleanup(self.p3.stop)

        self.service = ImageStorageService(index_file=self.data_dir / "image_index.json")

    def test_local_mode_saves_file_and_updates_index(self):
        payload = png_bytes()
        stored = self.service.save(payload, base_url="https://override.example.test")
        self.assertEqual(stored.storage, "local")
        self.assertEqual(stored.size, len(payload))
        self.assertTrue(stored.url.startswith("https://override.example.test/images/"))
        self.assertTrue((self.images_dir / stored.rel).is_file())
        self.assertEqual(self.service.get_bytes(stored.rel), payload)
        self.assertTrue(self.service.exists(stored.rel))
        self.assertTrue(self.service.has_local(stored.rel))

    def test_delete_removes_file_and_index_entry(self):
        payload = png_bytes()
        stored = self.service.save(payload)
        self.assertTrue(self.service.delete(stored.rel))
        self.assertFalse((self.images_dir / stored.rel).is_file())
        self.assertFalse(self.service.exists(stored.rel))

    def test_list_items_returns_indexed_images(self):
        payload = png_bytes()
        stored = self.service.save(payload)
        items = self.service.list_items(base_url="https://api.example.test")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["rel"], stored.rel)
        self.assertEqual(items[0]["size"], len(payload))


if __name__ == "__main__":
    unittest.main()
