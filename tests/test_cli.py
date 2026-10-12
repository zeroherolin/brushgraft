import socket

import pytest

from brushgraft import __version__
from brushgraft.cli import _bind, _links, build_parser


def test_busy_port_falls_back_to_free_one():
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        port = taken.getsockname()[1]
        sock = _bind("127.0.0.1", port)
        try:
            assert sock.getsockname()[1] not in (0, port)
        finally:
            sock.close()


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
