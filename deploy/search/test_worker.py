import json
import unittest
from unittest.mock import patch

import worker


class SearchWorkerTest(unittest.TestCase):
    def test_no_query_or_page_resolution_if_exit_check_fails(self):
        with patch.object(worker, "proxy_get", return_value=(b'{"mullvad_exit_ip":false}', b"application/json")) as request:
            with self.assertRaises(ValueError):
                worker.search("private query", "test-key")
            with self.assertRaises(ValueError):
                worker.read_page("https://example.org/")
        self.assertEqual([call.args[0] for call in request.call_args_list], [worker.EXIT_CHECK, worker.EXIT_CHECK])

    def test_worker_search_uses_only_explicit_query(self):
        calls = [
            (b'{"mullvad_exit_ip":true}', b"application/json"),
            (b'{"web":{"results":[{"url":"https://example.org/","title":"Example &amp; more","description":"Public text"}]}}', b"application/json"),
        ]
        with patch.object(worker, "proxy_get", side_effect=calls) as request:
            sources = worker.search("reviewed query", "test-key")
        self.assertIn("q=reviewed+query", request.call_args.args[0])
        self.assertEqual(sources[0]["title"], "Example & more")

    def test_disallows_local_url_and_any_nonpublic_address_in_dns_result(self):
        for url in (
            "http://example.org",
            "https://127.0.0.1",
            "https://example.org:8443/",
            "https://username@example.org/",
            "https://instance.internal/",
            "https://example.org\\@www.example.com/",
        ):
            with self.assertRaises(ValueError, msg=url):
                worker.validate_page(url)
        for private in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.5", "224.0.0.1", "100.64.0.1"):
            dns = {"Status": 0, "Answer": [{"type": 1, "data": "93.184.216.34"}, {"type": 1, "data": private}]}
            with patch.object(worker, "proxy_get", return_value=(json.dumps(dns).encode(), b"application/dns-json")):
                with self.assertRaises(ValueError, msg=private):
                    worker.resolve_public_ipv4("example.org")

    def test_page_dials_the_validated_address_and_extracts_only_text(self):
        dns = {"Status": 0, "Answer": [{"type": 1, "data": "93.184.216.34"}]}
        calls = [
            (b'{"mullvad_exit_ip":true}', b"application/json"),
            (json.dumps(dns).encode(), b"application/dns-json"),
            (b"<head><title>Hide</title></head><main><p>Example</p><script>Hide</script><p>Page</p></main>", b"text/html"),
        ]
        with patch.object(worker, "proxy_get", side_effect=calls) as request:
            self.assertEqual(worker.read_page("https://example.org/"), "Example Page")
        self.assertEqual(request.call_args.kwargs["connect_to"], "::93.184.216.34:443")


if __name__ == "__main__":
    unittest.main()
