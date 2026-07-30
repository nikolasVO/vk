import tempfile
import unittest
from pathlib import Path

from vk_market_feed import normalize_price
from vk_publisher import (
    Product,
    clean_text,
    extract_image_urls,
    load_products,
    load_state,
    save_state,
)


PROJECT_DIR = Path(__file__).resolve().parent


class TextTests(unittest.TestCase):
    def test_html_is_converted_to_plain_text(self):
        source = "Первый<br/><br/><ul><li>Один</li><li>Два</li></ul>"
        self.assertEqual(clean_text(source), "Первый\n\n• Один\n• Два")

    def test_image_urls_are_unique(self):
        source = (
            "https://example.test/1.jpg, https://example.test/2.jpg; "
            "https://example.test/1.jpg"
        )
        self.assertEqual(
            extract_image_urls(source),
            (
                "https://example.test/1.jpg",
                "https://example.test/2.jpg",
            ),
        )

    def test_message_has_requested_order(self):
        product = Product(
            row_number=2,
            article="1",
            description="Текст",
            title="Название",
            brand="Бренд",
            size="L",
            image_urls=("https://example.test/1.jpg",),
            source_url="",
        )
        self.assertEqual(
            product.message,
            (
                "Описание:\nТекст\n\n"
                "Название: Название\n\n"
                "Бренд: Бренд\n\n"
                "Размер: L"
            ),
        )


class WorkbookTests(unittest.TestCase):
    def test_real_workbook_is_read(self):
        products = load_products(PROJECT_DIR / "res.xlsx")
        self.assertEqual(len(products), 2733)
        self.assertEqual(products[0].row_number, 2)
        self.assertEqual(products[0].article, "730508811")
        self.assertEqual(products[0].brand, "WARTECH")
        self.assertEqual(products[0].price, "7037")
        self.assertEqual(len(products[0].image_urls), 3)


class MarketFeedTests(unittest.TestCase):
    def test_price_is_normalized_for_vk_yml(self):
        self.assertEqual(normalize_price("2 000 ₽"), "2000")
        self.assertEqual(normalize_price("1 234,50"), "1234.5")
        self.assertEqual(normalize_price("нет цены"), "")


class StateTests(unittest.TestCase):
    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            state = {"version": 1, "published": {"article:1": {"post_id": 42}}}
            save_state(path, state)
            self.assertEqual(load_state(path), state)


if __name__ == "__main__":
    unittest.main()
