"""Bounded HTTP worker. Every request leaves through Mullvad's in-tunnel proxy."""

import hmac
import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import threading
from html import unescape
from html.parser import HTMLParser
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlsplit

EXIT_CHECK = "https://am.i.mullvad.net/json"
BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search"
DNS_LOOKUP = "https://cloudflare-dns.com/dns-query"


def proxy_get(url, *, headers=(), connect_to=None, limit=128_000):
    # -q ignores .curlrc. With socks5h, DNS runs at the Mullvad proxy. A blank
    # --noproxy overrides environment bypass rules. No redirects are followed.
    config = [f"url = {json.dumps(url, ensure_ascii=False)}"]
    config += [f"header = {json.dumps(header)}" for header in headers]
    if connect_to:
        config.append(f"connect-to = {json.dumps(connect_to)}")
    with subprocess.Popen(
        [
            "/usr/bin/curl", "-q", "--silent", "--fail", "--globoff", "--proto", "=https",
            "--proxy", "socks5h://10.64.0.1:1080", "--noproxy", "",
            "--connect-timeout", "3", "--max-time", "6", "--max-filesize", str(limit),
            "--write-out", "\n%{response_code}\n%{content_type}", "--config", "-",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={},
    ) as process:
        process.stdin.write("\n".join(config).encode())
        process.stdin.close()
        output = process.stdout.read(limit + 1024)
        if len(output) == limit + 1024:
            process.kill()
        if process.wait(timeout=7) != 0:
            raise ValueError("Upstream request failed")
    body, status, content_type = output.rsplit(b"\n", 2)
    if status != b"200" or len(body) > limit:
        raise ValueError("Upstream request rejected")
    return body, content_type.lower().split(b";", 1)[0].strip()


def verify_exit():
    body, _ = proxy_get(EXIT_CHECK, limit=8_000)
    if json.loads(body).get("mullvad_exit_ip") is not True:
        raise ValueError("Unverified Mullvad exit")


def search(query, key, provider="brave"):
    verify_exit()
    if provider == "searxng":
        return search_searxng(query)
    url = BRAVE_SEARCH + "?" + urlencode(
        {"q": query, "count": 5, "result_filter": "web", "text_decorations": "false"}
    )
    body, _ = proxy_get(url, headers=("Accept: application/json", f"X-Subscription-Token: {key}"))
    results = json.loads(body).get("web", {}).get("results", [])
    return [
        {
            "url": item["url"][:2048],
            "title": unescape(item["title"])[:240],
            "snippet": unescape(item["description"])[:1200],
        }
        for item in results[:5]
        if isinstance(item, dict) and all(isinstance(item.get(field), str) for field in ("url", "title", "description"))
    ]


def search_searxng(query):
    # The engine is reachable only within the VPN namespace. POST keeps the
    # query out of access-log URLs. SearXNG sends its own traffic via SOCKS5h.
    engine = HTTPConnection("127.0.0.1", 8988, timeout=12)
    try:
        engine.request(
            "POST", "/search",
            urlencode({"q": query, "format": "json", "categories": "general"}),
            {"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "127.0.0.1"},
        )
        response = engine.getresponse()
        data = response.read(256_001)
        if response.status != 200 or len(data) > 256_000:
            raise ValueError("Search engine unavailable")
    finally:
        engine.close()
    payload = json.loads(data)
    results = payload["results"]
    if not results and payload.get("unresponsive_engines"):
        raise ValueError("Search engines unavailable")
    return [
        {"url": item["url"][:2048], "title": unescape(item["title"])[:240],
         "snippet": unescape(item["content"])[:1200]}
        for item in results
        if isinstance(item, dict)
        and str(item.get("url", "")).startswith("https://")
        and all(isinstance(item.get(field), str) for field in ("url", "title", "content"))
    ][:5]


def validate_page(url):
    if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 33 for char in url):
        raise ValueError("Invalid page URL")
    target = urlsplit(url)
    name = target.hostname
    if (
        target.scheme != "https" or not name or target.netloc != name
        or not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9-]{1,63}\.)+[a-z][a-z0-9-]{1,62}", name)
        or name.endswith((".local", ".internal", ".localhost", ".home", ".test", ".invalid", ".onion"))
    ):
        raise ValueError("Unsupported page URL")
    return name


def resolve_public_ipv4(name):
    url = DNS_LOOKUP + "?" + urlencode({"name": name, "type": "A"})
    body, _ = proxy_get(url, headers=("Accept: application/dns-json",), limit=16_000)
    response = json.loads(body)
    if response.get("Status") != 0 or response.get("TC") is True:
        raise ValueError("DNS lookup failed")
    addresses = [
        ipaddress.IPv4Address(record["data"])
        for record in response.get("Answer", [])
        if record.get("type") == 1
    ]
    if not addresses or any(not ip.is_global or ip.is_multicast for ip in addresses):
        raise ValueError("Page did not resolve exclusively to public addresses")
    return str(addresses[0])


class PageText(HTMLParser):
    SKIP = {"head", "script", "style", "noscript", "template", "svg", "canvas", "iframe"}
    BREAK = {"p", "div", "br", "li", "article", "h1", "h2", "h3", "section", "main", "tr"}

    def __init__(self):
        super().__init__()
        self.skipped = []
        self.parts = []

    def handle_starttag(self, tag, _):
        if tag in self.SKIP:
            self.skipped.append(tag)
        elif tag in self.BREAK and not self.skipped:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if self.skipped and tag == self.skipped[-1]:
            self.skipped.pop()
        elif tag in self.BREAK and not self.skipped:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skipped:
            self.parts.append(data)


def read_page(url):
    name = validate_page(url)
    verify_exit()
    address = resolve_public_ipv4(name)
    body, content_type = proxy_get(url, connect_to=f"::{address}:443", limit=512_000)
    text = body.decode("utf-8", errors="replace")
    if content_type in (b"text/html", b"application/xhtml+xml"):
        extractor = PageText()
        extractor.feed(text)
        extractor.close()
        text = "".join(extractor.parts)
    elif content_type != b"text/plain":
        raise ValueError("Unsupported page content")
    excerpt = " ".join(text.split())[:2400]
    if not excerpt:
        raise ValueError("Empty page")
    return excerpt


def serve(token, key, provider, bind="127.0.0.1"):
    slots = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            # Never write private queries, result URLs, or headers to logs.
            pass

        def respond(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def setup(self):
            self.request.settimeout(3)
            super().setup()

        def do_POST(self):
            authorized = hmac.compare_digest(
                self.headers.get("Authorization", "").encode(), f"Bearer {token}".encode()
            )
            if not authorized:
                self.respond(401, {})
                return
            if self.path not in ("/search", "/read", "/status"):
                self.respond(404, {})
                return
            if not slots.acquire(blocking=False):
                self.respond(429, {})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 2 or size > 4096 or self.headers.get("Content-Type") != "application/json":
                    raise ValueError("Invalid request")
                request = json.loads(self.rfile.read(size))
                if self.path == "/status":
                    verify_exit()
                    result = {"mullvad": True}
                elif self.path == "/read":
                    result = {"excerpt": read_page(request["url"])}
                else:
                    query = request["query"]
                    if not isinstance(query, str) or not query.strip() or len(query) > 400:
                        raise ValueError("Invalid query")
                    result = {"sources": search(query, key, provider)}
            except (ValueError, KeyError, TypeError, AttributeError, OSError, HTTPException, subprocess.SubprocessError):
                self.respond(503, {"message": "Private search unavailable."})
                return
            finally:
                slots.release()
            self.respond(200, result)

    ThreadingHTTPServer((bind, 8754), Handler).serve_forever()


if __name__ == "__main__":
    worker_token = os.environ.get("CONDUIT_CHAT_SEARCH_TOKEN", "")
    search_key = os.environ.get("BRAVE_SEARCH_API_KEY", "")
    provider = os.environ.get("CONDUIT_CHAT_SEARCH_PROVIDER", "brave")
    if not re.fullmatch(r"[0-9a-f]{64}", worker_token):
        raise SystemExit("Set a random 64-character hex worker token.")
    if provider not in ("brave", "searxng"):
        raise SystemExit("Select brave or searxng in CONDUIT_CHAT_SEARCH_PROVIDER.")
    if provider == "brave" and not re.fullmatch(r"[A-Za-z0-9_.-]{8,256}", search_key):
        raise SystemExit("Set the Brave Search API key.")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    serve(worker_token, search_key, provider, os.environ.get("CONDUIT_CHAT_SEARCH_BIND", "127.0.0.1"))
