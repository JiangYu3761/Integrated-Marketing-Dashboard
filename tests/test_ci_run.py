import os
from pathlib import Path
import subprocess
import sys
import unittest


class CIRunnerTests(unittest.TestCase):
    def test_failure_keeps_exit_code_and_escapes_annotation_newlines(self):
        script = Path(__file__).resolve().parents[1] / "scripts/ci_run.py"
        result = subprocess.run([sys.executable, str(script), sys.executable, "-c",
                                 "print('first line\\n100% failed'); raise SystemExit(7)"],
                                capture_output=True, text=True, env={**os.environ, "GITHUB_ACTIONS": "true"})
        self.assertEqual(result.returncode, 7)
        self.assertIn("first line\n100% failed", result.stdout)
        self.assertIn("::error title=Check failed::first line%0A100%25 failed%0A", result.stdout)


if __name__ == "__main__":
    unittest.main()
