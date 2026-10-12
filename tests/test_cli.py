import socket
import sys

import pytest

from brushgraft import __version__
from brushgraft.cli import _bind, _links, build_parser


def test_busy_port_falls_back_to_free_one():
    # a server on all addresses, or on loopback only: the link must not reach it
    for theirs, ours in (("127.0.0.1", "127.0.0.1"), ("0.0.0.0", "127.0.0.1"),
                         ("127.0.0.1", "0.0.0.0")):
        with socket.socket() as taken:
            taken.bind((theirs, 0))
            taken.listen()
            port = taken.getsockname()[1]
            sock = _bind(ours, port)
            try:
                assert sock.getsockname()[1] not in (0, port), (theirs, ours)
            finally:
                sock.close()


@pytest.mark.skipif(sys.platform == "win32",
                    reason="Windows may hold the port a while; the link printed has the new one")
def test_a_restart_gets_its_port_back_while_old_connections_linger():
    server = _bind("127.0.0.1", 0)
    port = server.getsockname()[1]
    server.listen()
    client = socket.create_connection(("127.0.0.1", port))
    conn, _ = server.accept()
    conn.close()  # the server's side closes first: its end waits in TIME_WAIT
    server.close()
    client.close()
    again = _bind("127.0.0.1", port)
    try:
        assert again.getsockname()[1] == port
    finally:
        again.close()


def test_version(capsys):
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--version"])
    assert __version__ in capsys.readouterr().out


class TestLinks:
    def test_local_only_by_default(self):
        assert _links("127.0.0.1", 7788, "tok") == ("http://127.0.0.1:7788/?token=tok", None)
        assert _links("localhost", 7788, "tok")[0] == "http://127.0.0.1:7788/?token=tok"

    def test_wildcard_opens_on_loopback_and_tells_others_what_to_use(self):
        local, network = _links("0.0.0.0", 7788, "tok")
        assert local == "http://127.0.0.1:7788/?token=tok"   # 0.0.0.0 can't be browsed to
        assert network == "http://<this computer's address>:7788/?token=tok"
        assert _links("::", 7788, "tok")[0] == "http://[::1]:7788/?token=tok"

    def test_a_specific_address_is_the_link(self):
        assert _links("192.168.1.5", 8080, "tok") == ("http://192.168.1.5:8080/?token=tok", None)
        assert _links("fe80::1", 8080, "tok")[0] == "http://[fe80::1]:8080/?token=tok"
