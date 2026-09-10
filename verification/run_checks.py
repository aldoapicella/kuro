"""Run the reference-model checks and record exactly what was executed."""
import hashlib
import io
import json
from pathlib import Path
import platform
import sqlite3
import sys
import unittest
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / 'verification'
sys.path.insert(0, str(HERE))
suite = unittest.defaultTestLoader.discover(str(HERE), pattern='test_*.py')

def ids(test):
    if isinstance(test, unittest.TestSuite):
        return [item for child in test for item in ids(child)]
    return [test.id()]

names = ids(suite)
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
files = ['verification/reference_model.py', 'verification/test_reference_model.py',
         'docs/architecture.md', 'docs/reference/architecture-pista.pdf']
record = {
    'scope': 'Executable design model only; no QVAC, Pear, Electron, OS crypto or production integration run.',
    'timestamp_utc': datetime.now(timezone.utc).isoformat(),
    'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version,
    'tests_run': result.testsRun, 'test_names': names,
    'authorization_matrix_subcases': 256,
    'failures': len(result.failures), 'errors': len(result.errors),
    'success': result.wasSuccessful(),
    'sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
    'output': stream.getvalue(),
}
(HERE / 'results.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(stream.getvalue(), end='')
print('Reference-model result:', HERE / 'results.json')
sys.exit(0 if result.wasSuccessful() else 1)
