#!/usr/bin/env python3
import argparse
import http.server
import select
import socket
import socketserver
import sys
import urllib.parse


BUFFER_SIZE = 64 * 1024
SOCKET_TIMEOUT_SEC = 15


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_CONNECT(self) -> None:
        host, _, port_text = self.path.partition(":")
        port = int(port_text or "443")
        self._log(f"CONNECT {host}:{port}")
        try:
            with socket.create_connection((host, port), timeout=SOCKET_TIMEOUT_SEC) as upstream:
                upstream.setblocking(False)
                self.connection.setblocking(False)
                self.send_response(200, "Connection Established")
                self.end_headers()
                self._pump_bidirectional(upstream)
        except Exception as exc:  # noqa: BLE001
            self.send_error(502, f"CONNECT failed: {exc}")
            self._log(f"CONNECT FAILED {host}:{port} -> {exc}")

    def do_GET(self) -> None:
        self._forward_plain_http()

    def do_HEAD(self) -> None:
        self._forward_plain_http()

    def do_POST(self) -> None:
        self._forward_plain_http()

    def do_PUT(self) -> None:
        self._forward_plain_http()

    def do_DELETE(self) -> None:
        self._forward_plain_http()

    def log_message(self, format_str: str, *args) -> None:  # noqa: A003
        self._log(format_str % args)

    def _forward_plain_http(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.scheme and parsed.netloc:
            host = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, parsed.fragment))
        else:
            host_header = self.headers.get("Host", "")
            if ":" in host_header:
                host, port_text = host_header.rsplit(":", 1)
                port = int(port_text)
            else:
                host = host_header
                port = 80
            path = self.path or "/"
        if not host:
            self.send_error(400, "Missing target host")
            return
        self._log(f"{self.command} {host}:{port}{path}")
        try:
            with socket.create_connection((host, port), timeout=SOCKET_TIMEOUT_SEC) as upstream:
                upstream.settimeout(SOCKET_TIMEOUT_SEC)
                request_line = f"{self.command} {path} {self.request_version}\r\n"
                upstream.sendall(request_line.encode("utf-8"))
                for key, value in self.headers.items():
                    lowered = key.lower()
                    if lowered in {"proxy-connection", "connection"}:
                        continue
                    upstream.sendall(f"{key}: {value}\r\n".encode("utf-8"))
                upstream.sendall(b"Connection: close\r\n\r\n")
                content_length = int(self.headers.get("Content-Length", "0") or "0")
                if content_length > 0:
                    upstream.sendall(self.rfile.read(content_length))
                while True:
                    chunk = upstream.recv(BUFFER_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as exc:  # noqa: BLE001
            self.send_error(502, f"HTTP forward failed: {exc}")
            self._log(f"FORWARD FAILED {host}:{port}{path} -> {exc}")

    def _pump_bidirectional(self, upstream: socket.socket) -> None:
        sockets = [self.connection, upstream]
        while True:
            readable, _, exceptional = select.select(sockets, [], sockets, 1.0)
            if exceptional:
                break
            if not readable:
                continue
            for current in readable:
                peer = upstream if current is self.connection else self.connection
                try:
                    data = current.recv(BUFFER_SIZE)
                except BlockingIOError:
                    continue
                if not data:
                    return
                peer.sendall(data)

    @staticmethod
    def _log(message: str) -> None:
        print(message, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Temporary local HTTP proxy for Android mobile-host validation.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=18888)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ProxyHandler)
    print(f"Listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
