"""One-way Feishu Bitable connector for the native app's loopback service."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

FIELDS = ("本地ID", "类型", "事项", "项目", "产品", "负责人", "行动日", "截止日", "状态", "重点", "重点原因", "板块", "来源日报", "内容")
BASE = "https://open.feishu.cn/open-apis"
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,180}")


class ConnectorError(Exception):
    """User-facing error with no credentials or raw remote response."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ConnectorError("飞书接口返回了意外跳转。")


def request_api(method, path, body=None, token=None):
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(BASE + path, method=method, headers=headers,
                      data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None)
    try:
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            result = json.load(response)
    except HTTPError as error:
        raise ConnectorError("飞书请求失败（HTTP %s）。请检查权限、网络或稍后重试。" % error.code) from None
    except (URLError, ValueError, OSError) as error:
        raise ConnectorError("无法连接飞书，请检查网络后重试。") from error
    if result.get("code") != 0:
        code = result.get("code")
        raise ConnectorError("飞书返回错误码 %s。请核对应用权限、表格授权和字段类型。" % (code if isinstance(code, int) else "未知"))
    return result


def digest(fields):
    encoded = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class Connector:
    def __init__(self, directory=None, api=request_api):
        self.directory = Path(directory or (Path.home() / "Library/Application Support/com.jiangyu3761.integrated-marketing-dashboard/Feishu"))
        self.config_file = self.directory / "connection.json"
        self.api = api
        self.lock = threading.RLock()

    def _config(self):
        if not self.config_file.exists():
            return {}
        try:
            return json.loads(self.config_file.read_text())
        except (OSError, ValueError) as exc:
            raise ConnectorError("飞书连接配置无法读取，请检查本机文件。") from exc

    def _database(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = sqlite3.connect(self.directory / "sync.sqlite3")
        db.execute("CREATE TABLE IF NOT EXISTS records (destination TEXT, local_id TEXT, remote TEXT, fingerprint TEXT, synced TEXT, error TEXT, PRIMARY KEY(destination, local_id))")
        return db

    def _target(self, config):
        return config["appToken"] + "/" + config["tableId"]

    def _path(self, config):
        return "/bitable/v1/apps/" + config["appToken"] + "/tables/" + config["tableId"]

    def _token(self, config):
        return self.api("POST", "/auth/v3/tenant_access_token/internal", {
            "app_id": config["appId"], "app_secret": config["appSecret"]
        })["tenant_access_token"]

    def configure(self, settings):
        with self.lock:
            old = self._config()
            config = {key: settings.get(key, "") for key in ("appId", "appToken", "tableId", "appSecret")}
            if not all(isinstance(value, str) for value in config.values()):
                raise ConnectorError("连接参数无效。")
            if not config["appSecret"] and old.get("appId") == config["appId"]:
                config["appSecret"] = old.get("appSecret", "")
            if not all(ID_PATTERN.fullmatch(config[key]) for key in ("appId", "appToken", "tableId")) or not 0 < len(config["appSecret"]) <= 512:
                raise ConnectorError("请填写 App ID、App Secret、Base Token 和 Table ID。")
            token = self._token(config)
            response = self.api("GET", self._path(config) + "/fields?page_size=100", token=token)
            fields = response["data"]
            available = {entry["field_name"] for entry in fields["items"] if entry.get("type") == 1}
            visited = set()
            while fields.get("has_more") and not set(FIELDS).issubset(available):
                cursor = fields.get("page_token")
                if not cursor or cursor in visited:
                    break
                visited.add(cursor)
                fields = self.api("GET", self._path(config) + "/fields?page_size=100&page_token=" + quote(cursor, safe=""), token=token)["data"]
                available.update(entry["field_name"] for entry in fields["items"] if entry.get("type") == 1)
            missing = [key for key in FIELDS if key not in available]
            if missing:
                raise ConnectorError("目标表需要以下文本字段：" + "、".join(missing))
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.NamedTemporaryFile("w", dir=self.directory, delete=False, encoding="utf-8") as temp:
                json.dump(config, temp)
            os.replace(temp.name, self.config_file)
            return self.status()

    def status(self):
        with self.lock:
            config = self._config()
            public = {key: config.get(key, "") for key in ("appId", "appToken", "tableId")}
            records = {}
            if config:
                db = self._database()
                try:
                    for key, remote, signature, stamp, error in db.execute(
                            "SELECT local_id, remote, fingerprint, synced, error FROM records WHERE destination=?", (self._target(config),)):
                        records[key] = {"remoteId": remote, "fingerprint": signature, "syncedAt": stamp, "error": error}
                finally:
                    db.close()
            return {"configured": bool(config), "config": public, "records": records, "fields": FIELDS}

    def synchronize(self, message):
        fields = message.get("fields")
        if not isinstance(fields, dict) or set(fields) != set(FIELDS):
            raise ConnectorError("记录字段不完整。")
        fields = {key: fields[key] for key in FIELDS}
        if any(not isinstance(value, str) or len(value) > 60000 for value in fields.values()):
            raise ConnectorError("字段内容无效或超出长度限制。")
        key = fields["本地ID"]
        if not key or len(key) > 220 or not fields["事项"].strip():
            raise ConnectorError("缺少有效的本地记录 ID 或事项名称。")
        with self.lock:
            config = self._config()
            if not config:
                raise ConnectorError("请先配置飞书连接。")
            target = self._target(config)
            if message.get("destination") != target:
                raise ConnectorError("目标表已经改变，请刷新总表后重试。")
            signature = digest(fields)
            db = self._database()
            try:
                existing = db.execute("SELECT remote, fingerprint, synced FROM records WHERE destination=? AND local_id=?", (target, key)).fetchone()
                remote, previous, synced = existing or ("", "", "")
                try:
                    if not remote or previous != signature:
                        token = self._token(config)
                        path = self._path(config) + "/records"
                        if not remote:
                            matches = self.api("POST", path + "/search?page_size=2", {
                                "filter": {"conjunction": "and", "conditions": [{"field_name": "本地ID", "operator": "is", "value": [key]}]},
                                "field_names": ["本地ID"]
                            }, token)["data"]
                            items = matches.get("items", [])
                            if len(items) > 1 or matches.get("has_more"):
                                raise ConnectorError("飞书中有多条相同本地 ID 的记录，请处理后重试。")
                            remote = items[0]["record_id"] if items else ""
                        if remote:
                            self.api("PUT", path + "/" + quote(remote, safe=""), {"fields": fields}, token)
                        else:
                            identifier = uuid.UUID(bytes=hashlib.sha256((target + "\n" + key).encode()).digest()[:16], version=4)
                            remote = self.api("POST", path + "?client_token=" + str(identifier), {"fields": fields}, token)["data"]["record"]["record_id"]
                        synced = datetime.now(timezone.utc).isoformat()
                    error = ""
                except ConnectorError as exc:
                    error = str(exc)
                db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?)", (target, key, remote, previous if error else signature, synced, error))
                db.commit()
                return {"remoteId": remote, "fingerprint": previous if error else signature, "syncedAt": synced, "error": error}
            finally:
                db.close()
