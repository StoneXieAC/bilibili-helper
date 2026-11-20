"""使用 Python hashlib 对照扩展当前的 MD5 实现；不请求网络。"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    inputs = ["", "abc", "中文投稿", "a" * 55, "a" * 56, "a" * 64, "x" * 1000]
    script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('content/page-agent.js', 'utf8');
const start = source.indexOf('  function spaceMd5(');
const end = source.indexOf('  let spaceWbiKey', start);
if (start < 0 || end < 0) throw new Error('当前 MD5 实现不存在');
const context = vm.createContext({ TextEncoder });
vm.runInContext(source.slice(start, end), context);
process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(context.spaceMd5)));
"""
    result = subprocess.run(
        ['node', '-e', script, json.dumps(inputs)], cwd=ROOT,
        check=True, capture_output=True, text=True, timeout=15,
    )
    actual = json.loads(result.stdout)
    expected = [hashlib.md5(value.encode()).hexdigest() for value in inputs]
    assert actual == expected, (actual, expected)
    print(f'PASS: {len(inputs)} MD5 vectors match hashlib')


if __name__ == '__main__':
    main()
