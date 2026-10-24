#!/usr/bin/env python3
"""复用宝塔已有 ACME 账号，签发及续期 AutoOps 公网域名证书。"""

import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

DOMAIN = "auto.996788.xyz"
PANEL = Path("/www/server/panel")
WEBROOT = Path("/www/wwwroot") / DOMAIN
CERT = PANEL / "vhost/cert" / DOMAIN
NGINX = "/www/server/nginx/sbin/nginx"
FILES = ("fullchain.pem", "privkey.pem")


def valid(path):
    # x509 的主机名检查会打印不匹配，但不一定返回失败；verify 才用于裁决。
    commands = [
        ["openssl", "x509", "-in", str(path), "-noout", "-checkend", "2592000"],
        ["openssl", "verify", "-purpose", "sslserver", "-verify_hostname", DOMAIN,
         "-untrusted", str(path), str(path)],
    ]
    return path.is_file() and all(subprocess.run(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0 for command in commands)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "renew"
    if mode not in {"issue", "renew", "check"}:
        raise ValueError("仅支持 issue、renew、check")
    os.umask(0o077)
    lock = open("/run/lock/autoops-certificate-renew.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if valid(CERT / FILES[0]):
        print(json.dumps({"domain": DOMAIN, "validBeyond30Days": True, "updated": False}))
        return
    if mode == "check":
        raise RuntimeError("证书缺失、域名不符或已进入续期窗口")
    os.chdir(PANEL)
    sys.path[:0] = [str(PANEL), str(PANEL / "class")]
    # 宝塔客户端可能在诊断中打印证书响应；这里只输出本站操作结果。
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from acme_v2 import acme_v2
        manager = acme_v2()
        orders = [item for item in manager.get_orders(None)
                  if item.get("domains") == [DOMAIN] and item.get("save_path")]
        if orders:
            order = max(orders, key=lambda item: item.get("cert_timeout", 0))
            result = manager.renew_cert(order["index"], cycle=30)
            refreshed = [item for item in manager.get_orders(None)
                         if item.get("domains") == [DOMAIN] and item.get("save_path")]
            source = Path(max(refreshed, key=lambda item: item.get("cert_timeout", 0))["save_path"])
        elif mode == "issue":
            result = manager.apply_cert([DOMAIN], auth_type="http", auth_to=str(WEBROOT), ca="letsencrypt")
            if not result or result.get("status") is False:
                raise RuntimeError("本站证书签发失败，请查看宝塔证书状态")
            source = Path(result["save_path"])
        else:
            raise RuntimeError("缺少本站证书订单，请先签发")
    if result and result.get("status") is False:
        raise RuntimeError("本站证书续期失败，请查看宝塔证书状态")
    if not valid(source / FILES[0]):
        raise RuntimeError("签发结果未通过域名与有效期检查")
    cert_key = subprocess.check_output(["openssl", "x509", "-in", str(source / FILES[0]), "-pubkey", "-noout"])
    private_key = subprocess.check_output(["openssl", "pkey", "-in", str(source / FILES[1]), "-pubout"])
    if cert_key != private_key:
        raise RuntimeError("证书与私钥不匹配")
    CERT.mkdir(mode=0o700, parents=True, exist_ok=True)
    previous = {name: (CERT / name).read_bytes() if (CERT / name).exists() else None for name in FILES}
    try:
        for name in FILES:
            temporary = CERT / (name + ".new")
            shutil.copyfile(source / name, temporary)
            temporary.chmod(0o600 if name == "privkey.pem" else 0o644)
            os.replace(temporary, CERT / name)
        subprocess.run([NGINX, "-t"], check=True)
        subprocess.run([NGINX, "-s", "reload"], check=True)
    except Exception:
        # 校验失败恢复原证书文件，正在运行的 Nginx 保持原配置。
        for name, content in previous.items():
            if content is None:
                (CERT / name).unlink(missing_ok=True)
            else:
                (CERT / name).write_bytes(content)
        raise
    print(json.dumps({"domain": DOMAIN, "validBeyond30Days": True, "updated": True}))


if __name__ == "__main__":
    main()
