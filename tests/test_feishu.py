import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

from desktop.macos.feishu import Connector, ConnectorError, FIELDS, digest
from desktop.macos.local_server import create_server

ROOT = Path(__file__).resolve().parents[1]


class Remote:
    def __init__(self):
        self.records = {}
        self.creates = []
        self.updates = []
        self.fields = list(FIELDS)
        self.drop_reply = False

    def __call__(self, method, path, body=None, token=None):
        if path.startswith("/auth/"):
            return {"tenant_access_token": "example-token"}
        assert token == "example-token"
        if "/fields?" in path:
            return {"data": {"items": [{"field_name": key, "type": 1} for key in self.fields]}}
        if "/search?" in path:
            key = body["filter"]["conditions"][0]["value"][0]
            records = [{"record_id": remote_id} for remote_id, fields in self.records.items() if fields["本地ID"] == key]
            return {"data": {"items": records, "has_more": False}}
        if method == "POST":
            remote_id = "rec" + str(len(self.records) + 1)
            self.creates.append(path.split("client_token=")[1])
            self.records[remote_id] = dict(body["fields"])
            if self.drop_reply:
                self.drop_reply = False
                raise ConnectorError("连接超时")
            return {"data": {"record": {"record_id": remote_id}}}
        assert method == "PUT"
        remote_id = path.rsplit("/", 1)[1]
        self.updates.append(remote_id)
        self.records[remote_id] = dict(body["fields"])
        return {"data": {"record": {"record_id": remote_id}}}


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.api = Remote()
        self.connector = Connector(self.directory.name, self.api)
        self.settings = {"appId":"cli_example", "appSecret":"private-test-value", "appToken":"baseExample", "tableId":"tblExample"}
        self.fields = dict.fromkeys(FIELDS, "")
        self.fields.update({"本地ID":"report:report-1", "事项":"样品进展", "类型":"日报"})

    def send(self):
        return self.connector.synchronize({"fields":self.fields, "destination":"baseExample/tblExample"})

    def test_credentials_are_write_only_and_existing_config_survives_failed_validation(self):
        public = self.connector.configure(self.settings)
        self.assertNotIn(self.settings["appSecret"], json.dumps(public))
        self.assertEqual(self.connector.config_file.stat().st_mode & 0o777, 0o600)
        self.connector.configure({**self.settings, "appSecret": ""})
        self.api.fields.remove("事项")
        with self.assertRaisesRegex(ConnectorError, "事项"):
            self.connector.configure({**self.settings, "tableId":"other"})
        self.assertEqual(self.connector.status()["config"]["tableId"], "tblExample")

    def test_retry_after_timeout_and_edits_keep_one_remote_record(self):
        self.connector.configure(self.settings)
        self.api.drop_reply = True
        failure = self.send()
        self.assertTrue(failure["error"])
        self.assertFalse(failure["syncedAt"])
        self.assertEqual(self.send()["remoteId"], "rec1")
        self.assertEqual(len(self.api.creates), 1)
        self.fields["内容"] = "更新后的日报"
        self.assertEqual(self.send()["fingerprint"], digest(self.fields))
        self.assertEqual(self.api.records["rec1"]["内容"], "更新后的日报")
        self.send()
        self.assertEqual(self.api.updates, ["rec1", "rec1"])
        reopened = Connector(self.directory.name, self.api)
        self.assertEqual(reopened.status()["records"]["report:report-1"]["remoteId"], "rec1")

    def test_duplicate_remote_keys_do_not_overwrite_existing_rows(self):
        self.connector.configure(self.settings)
        self.api.records = {"rec1":self.fields.copy(), "rec2":self.fields.copy()}
        self.assertIn("多条", self.send()["error"])
        self.assertFalse(self.api.updates)

    def test_old_destination_is_not_used_after_connection_changes(self):
        self.connector.configure({**self.settings, "tableId":"other"})
        with self.assertRaisesRegex(ConnectorError, "目标表"):
            self.send()
        self.assertFalse(self.api.creates)

    def test_only_same_origin_json_requests_can_use_connector(self):
        server = create_server(ROOT, port=0, connector=self.connector)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:" + str(server.server_port)
        client = build_opener(ProxyHandler({}))
        headers = {"Content-Type":"application/json", "X-Dashboard-Request":"feishu", "Origin":url}
        try:
            for overridden in ({"Origin":"https://other.example"}, {"Host":"other.example"}, {"X-Dashboard-Request":""}, {"Content-Type":"text/plain"}):
                with self.assertRaises(HTTPError) as denied:
                    client.open(Request(url + "/_desktop/feishu/status", b"{}", {**headers, **overridden})).close()
                self.assertEqual(denied.exception.code, 403)
                denied.exception.close()
            with client.open(Request(url + "/_desktop/feishu/status", b"{}", headers)) as response:
                status = json.load(response)
            self.assertFalse(status["configured"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
