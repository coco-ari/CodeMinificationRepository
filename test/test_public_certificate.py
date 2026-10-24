"""使用临时证书验证公网证书检查，避免域名不符或即将过期时误通过。"""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/renew-autoops-certificate.py"
spec = importlib.util.spec_from_file_location("public_certificate", SCRIPT)
certificate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(certificate)


class CertificateValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        help_result = subprocess.run(["openssl", "verify", "-help"], capture_output=True, text=True)
        if "-verify_hostname" not in help_result.stdout + help_result.stderr:
            raise unittest.SkipTest("需要 Linux 发行所用 OpenSSL 的 verify_hostname 能力")
        cls.temporary = tempfile.TemporaryDirectory(prefix="autoops-certificate-test-")
        cls.root = Path(cls.temporary.name)
        cls.certs = {}
        for name, days in [("current", 90), ("near-expiry", 1), ("untrusted", 90)]:
            path = cls.root / (name + ".pem")
            config = cls.root / (name + ".cnf")
            config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n"
                              "[dn]\nCN=auto.996788.xyz\n[ext]\n"
                              "subjectAltName=DNS:auto.996788.xyz\nbasicConstraints=critical,CA:TRUE\n")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-days", str(days), "-config", str(config),
                            "-keyout", str(cls.root / (name + ".key")), "-out", str(path)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cls.certs[name] = path

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_matching_domain_and_trusted_chain(self):
        with patch.dict(os.environ, {"SSL_CERT_FILE": str(self.certs["current"])}):
            self.assertTrue(certificate.valid(self.certs["current"]))

    def test_wrong_domain(self):
        with patch.dict(os.environ, {"SSL_CERT_FILE": str(self.certs["current"])}), \
                patch.object(certificate, "DOMAIN", "wrong-domain.invalid"):
            self.assertFalse(certificate.valid(self.certs["current"]))

    def test_near_expiry(self):
        with patch.dict(os.environ, {"SSL_CERT_FILE": str(self.certs["near-expiry"])}):
            self.assertFalse(certificate.valid(self.certs["near-expiry"]))

    def test_untrusted_chain(self):
        with patch.dict(os.environ, {"SSL_CERT_FILE": str(self.certs["current"])}):
            self.assertFalse(certificate.valid(self.certs["untrusted"]))

    def test_missing_file(self):
        self.assertFalse(certificate.valid(self.root / "missing.pem"))


if __name__ == "__main__":
    unittest.main()
